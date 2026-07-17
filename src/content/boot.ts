// The one bootstrap every content-script adapter shares: inject the stylesheet, wire the
// per-site on/off + tagline prefs (live via storage.onChanged, so they apply even while
// locked and without a reload), start the Controller, answer the popup's peerInfo/rescan
// messages, and nudge the Controller on SPA navigation. Platform-specific behavior lives
// entirely in the adapter passed in; this file never mentions a messenger by name.
import { Controller } from './controller.js';
import { injectStyle } from './dom.js';
import { send } from '../core/rpc.js';
import { EKKO_TAGLINE } from '../core/wire.js';
import { scopedThreadId } from '../core/thread.js';
import { openSealOverlay, targetFromActiveElement } from './seal.js';
import type { SiteAdapter } from './adapter.js';

const SITES_KEY = 'rsn.sites';
const TAGLINE_KEY = 'rsn.tagline';
const DISCOVER_KEY = 'rsn.discover';
const DEBUG_KEY = 'rsn.debug';

// On-page diagnostic readout (Settings → "Show debug overlay"). A live view of what the
// adapter resolves on the real logged-in page — the fastest way to see which selector
// drifted. Read-only, textContent-only, pointer-events:none; renders nothing unless the
// user turned it on.
function debugHud(
  adapter: SiteAdapter,
  controller: Controller,
  siteEnabled: () => boolean,
): (on: boolean | undefined) => void {
  let el: HTMLElement | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const render = () => {
    if (!el) return;
    // Per-site switch off = Ekko is invisible on this site; the (page-readable) readout
    // must not be the one thing still announcing it.
    el.style.display = siteEnabled() ? '' : 'none';
    if (!siteEnabled()) return;
    // A dying context can throw from any chrome.* touch; the watchdog removes this HUD
    // within a tick or two — until then, render quietly instead of spamming the console.
    let version = '?';
    try {
      version = chrome.runtime?.getManifest?.().version ?? '?';
    } catch {
      return;
    }
    const rows: Record<string, unknown> = {
      version,
      state: controller.debugState(),
      thread: adapter.threadId() ?? '—',
      direct: String(adapter.isDirectChat()),
      peer: adapter.peerName() ?? '—',
      handle: adapter.peerHandle() ?? '—',
      ...adapter.debugProbe?.(),
    };
    el.textContent =
      `Ekko debug · ${adapter.platformLabel}\n` +
      Object.entries(rows)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join('\n');
  };
  return (on) => {
    if (!on) {
      clearInterval(timer);
      timer = undefined;
      el?.remove();
      el = null;
      return;
    }
    if (el) return;
    el = document.createElement('div');
    el.id = 'rsn-debug';
    const s = el.style;
    s.position = 'fixed';
    s.top = '12px';
    s.right = '12px';
    s.zIndex = '2147483647';
    s.background = 'rgba(16,18,22,.92)';
    s.color = '#d7dbe2';
    s.font = '10.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace';
    s.padding = '8px 11px';
    s.borderRadius = '9px';
    s.whiteSpace = 'pre';
    s.pointerEvents = 'none';
    s.maxWidth = '46vw';
    s.overflow = 'hidden';
    document.documentElement.appendChild(el);
    render();
    timer = setInterval(render, 1000);
  };
}

export function boot(adapter: SiteAdapter): void {
  try {
    injectStyle();
    const controller = new Controller(adapter, send);

    // Two switches AND together: the persistent Home toggle (storage.local) and the
    // session pause (glyph power button; background-held storage.session, told to tabs by
    // getSettings + the siteSession broadcast — content scripts get no session-area access).
    let siteOn = true;
    let sessionOn = true;
    const applyEnabled = () => controller.setEnabled(siteOn && sessionOn);
    const applySites = (sites: Record<string, boolean> | undefined) => {
      siteOn = sites?.[adapter.platform] ?? true;
      applyEnabled();
    };
    void send({ type: 'getSettings' }).then((r) => {
      if (r.error) return; // unreachable — stay on; the local switch still governs
      sessionOn = !(r.sessionOff ?? []).includes(adapter.platform);
      applyEnabled();
    });
    // Tagline default OFF: you can only encrypt to an established Ekko contact, who decrypts
    // the message and never sees the tagline — so appended to every message it is pure clutter
    // (and wasted length). Growth lives in the explicit invite flow instead. The toggle stays
    // for anyone who wants the ciphertext to advertise Ekko to onlookers.
    const applyTag = (on: boolean | undefined) => controller.setTagline((on ?? false) ? EKKO_TAGLINE : null);
    const applyDebug = debugHud(adapter, controller, () => siteOn && sessionOn);
    void chrome.storage.local.get([SITES_KEY, TAGLINE_KEY, DEBUG_KEY]).then((r) => {
      applySites(r[SITES_KEY] as Record<string, boolean> | undefined);
      applyTag(r[TAGLINE_KEY] as boolean | undefined);
      applyDebug(r[DEBUG_KEY] as boolean | undefined);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[SITES_KEY]) applySites(changes[SITES_KEY].newValue as Record<string, boolean>);
      if (changes[TAGLINE_KEY]) applyTag(changes[TAGLINE_KEY].newValue as boolean);
      if (changes[DEBUG_KEY]) applyDebug(!!changes[DEBUG_KEY].newValue);
      // Toggling auto-discovery re-evaluates the open chat's offer without a reload.
      if (changes[DISCOVER_KEY]) controller.retryPending();
    });

    controller.start();

    // The popup asks who this chat is with (auto-label) and pings after unlock.
    chrome.runtime.onMessage.addListener((req: { type?: string }, _sender, sendResponse) => {
      if (req?.type === 'peerInfo') {
        const threadId = adapter.isDirectChat() === true ? adapter.threadId() : null;
        const scoped = threadId ? scopedThreadId(adapter.platform, threadId) : null;
        sendResponse({
          platform: adapter.platform,
          threadId: scoped,
          peerName: adapter.peerName(),
          peerHandle: adapter.peerHandle(),
          // The controller's recognition (chat @handle ↔ a contact's linked social), so the
          // popup can pre-select the match instead of offering a blind dropdown.
          suggested: scoped ? controller.suggestionFor(scoped) : null,
        });
      } else if (req?.type === 'rescan') {
        controller.retryPending();
        sendResponse({ ok: true });
      } else if (req?.type === 'siteSession') {
        const m = req as { platform?: string; enabled?: boolean };
        if (m.platform === adapter.platform) {
          sessionOn = m.enabled !== false;
          applyEnabled();
        }
        sendResponse({ ok: true });
      } else if (req?.type === 'sealAnywhere') {
        // The shortcut on an adapter page: seal whatever editable holds the caret —
        // usually the platform composer — chunked to this platform's send cap. Answering
        // ok is what tells the background NOT to inject the standalone overlay here.
        const target = targetFromActiveElement();
        if (target) target.maxLen = adapter.maxMessageLen;
        openSealOverlay(target);
        sendResponse({ ok: true });
      }
    });

    // SPA nav: the messages container is replaced on navigation, so the Controller observes
    // document.body (debounced) and we nudge it whenever the location changes. Telegram
    // switches chats via the URL hash (not the path), so watch both.
    window.addEventListener('hashchange', () => controller.requestScan());
    let lastPath = location.pathname;
    const pathPoll = setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        controller.requestScan();
      }
    }, 1000);

    // Orphan watchdog. An extension reload/update severs chrome.runtime under every
    // already-open tab's content script — the classic "Extension context invalidated"
    // console spam plus a zombie glyph frozen on stale state (every store update will do
    // this to every open messenger tab). When the context dies, stop every recurring job
    // and remove our UI. The send interceptors deliberately STAY: a chat cached as linked
    // keeps failing closed ("Ekko was updated or restarted. Reload this page…") — tearing
    // them down would let the next Enter send plaintext in a chat the user believes is
    // encrypted.
    const watchdog = setInterval(() => {
      if (chrome.runtime?.id) return;
      clearInterval(watchdog);
      clearInterval(pathPoll);
      applyDebug(false); // HUD node + its 1s timer
      controller.stop(); // mutation observer + scan scheduling
      adapter.destroy?.(); // glyph node, its interval and window listeners
      document.getElementById('rsn-toast')?.remove();
    }, 2000);
  } catch {
    // A broken bootstrap must never take the host page down with it.
  }
}
