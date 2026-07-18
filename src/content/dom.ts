// Shared, platform-independent DOM plumbing for the content-script adapters. Everything
// here is identical across Instagram/WhatsApp/Telegram: reading a composer, rendering a
// decrypted bubble in place, the toast, and the injected stylesheet. An adapter supplies
// only the platform-specific selectors and send mechanics; this file is the rest.
import { ICON_LOCK } from './icons.js';
import type { BubbleStatus } from './adapter.js';

export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Poll until pred() holds or the deadline passes. Condition-driven, not fixed-delay, so
// it tolerates a slow SPA frame without racing it.
export async function until(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return true;
    if (Date.now() > deadline) return false;
    await tick(40);
  }
}

export function isVisible(el: HTMLElement): boolean {
  return el.offsetParent !== null || el.getClientRects().length > 0;
}

// The one way to read text out of a composer node (textarea or contenteditable).
// innerText, not textContent: rich editors render one block per line, and innerText keeps
// those newlines — otherwise multi-line messages encrypt with the lines glued together;
// the   swap normalizes non-breaking spaces some editors insert.
export function readComposerNode(box: HTMLElement): string {
  return box instanceof HTMLTextAreaElement ? box.value : (box.innerText ?? box.textContent ?? '').replace(/ /g, ' ');
}

// ————— Composer writes (Lexical-proof) —————
// Meta's Lexical editor (WhatsApp Web — verified live 2026-07-17 — and Messenger, the same
// editor family) IGNORES execCommand('selectAll') and execCommand('delete'), but it DOES
// mirror the DOM Selection: a range covering the box makes the next insertText/paste
// REPLACE everything, and a synthetic beforeinput deleteContentBackward over that range
// empties it. Every composer write therefore goes: select-everything, then ONE replacing
// edit. Never an execCommand clear — a silently-failed clear leaves the token stacked on
// the user's draft, and a mixed box no longer classifies as pure ciphertext, so the
// controller's own capture listener blocks the adapter's send (the 2026-07-17 WhatsApp
// field bug).

function selectContents(box: HTMLElement): void {
  box.focus();
  const range = document.createRange();
  range.selectNodeContents(box);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function pasteInto(box: HTMLElement, text: string): void {
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  selectContents(box);
  box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}

// Replace the box's whole content with `text`; empty string empties it.
export function replaceComposerText(box: HTMLElement, text: string): void {
  selectContents(box);
  if (!text) {
    box.dispatchEvent(
      new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }),
    );
    return;
  }
  // insertText replaces the selection; if a build ever drops it, the paste door does too.
  if (!document.execCommand('insertText', false, text)) pasteInto(box, text);
}

// One attempt to put `text` into the CURRENT composer and see the editor accept it: the box
// holds EXACTLY the token — exact, not includes(), so a leftover draft can never ride along
// and corrupt the send — plus whatever platform signal `accepted` adds (WhatsApp: the mic
// swapped to the send button). Returns the node the token landed in, or null. These editors
// re-render the composer's container on every empty↔filled swap and React sometimes replaces
// the contenteditable node mid-flow; the caller then just tries again on the fresh node.
// Re-resolving is SAFE here (unlike after the send fires): a node the token never entered
// can't read as already-sent.
export async function placeInComposer(
  getBox: () => HTMLElement | null,
  text: string,
  accepted: () => boolean = () => true,
): Promise<HTMLElement | null> {
  const box = getBox();
  if (!box) return null;
  const nodeAlive = () => box.isConnected && getBox() === box;
  const exact = () => readComposerNode(box).trim() === text.trim();
  const ready = () => nodeAlive() && exact() && accepted();
  replaceComposerText(box, text);
  if (await until(ready, 400)) return box;
  if (!nodeAlive()) return null; // remount mid-insert — caller retries on the fresh node
  if (!exact()) {
    // insertText was ignored or replaced only part of the range — the paste door, over a
    // fresh whole-box selection. Judged by the DOM, not execCommand's return value.
    pasteInto(box, text);
  }
  const ok = await until(ready, 700);
  return ok ? box : null;
}

// Put the user's draft back after a failed send — but only over OUR OWN token. If the box
// is empty or the platform restored its own draft across a remount, writing into it would
// stack text we don't own.
export function restoreComposerDraft(getBox: () => HTMLElement | null, original: string, token: string): void {
  const box = getBox();
  if (!box || !readComposerNode(box).includes(token)) return;
  replaceComposerText(box, original);
}

// Small inline status icons: trailing the text on a decrypted message (11px, muted),
// leading it on Ekko's own chrome chips (12px). Constant markup only; message text
// itself always goes through textContent, never innerHTML.
const BADGE_ICON: Record<BubbleStatus, string> = {
  decrypted: ICON_LOCK,
  pending:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  error:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3.5 21.5 20h-19Z"/><path d="M12 10v4.5"/><path d="M12 17.4v.2"/></svg>',
  info:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="6" opacity=".6"/><circle cx="12" cy="12" r="9.5" opacity=".3"/></svg>',
};

const BADGE_TITLE: Record<BubbleStatus, string> = {
  decrypted: 'End-to-end encrypted with Ekko',
  pending: 'Encrypted — not readable yet',
  error: 'Decryption failed',
  info: 'Ekko system message',
};

// Replace a bubble's rendered text in place, with a status icon. Idempotent — identical
// re-renders touch NO DOM, so the MutationObserver isn't retriggered (this is what stops a
// pending bubble looping forever). Non-destructive to the platform's own text nodes: we
// blank their value rather than remove them, so a framework reconcile can't throw.
export function renderBubble(
  el: HTMLElement,
  text: string,
  status: BubbleStatus,
  // preserve: platform chrome nested INSIDE the text element (Telegram's timestamp/ticks are
  // icon-font TEXT there — blanking them erased the sent time and checkmarks). source: the
  // adapter's already-stripped bubble text; caching raw textContent instead would glue the
  // timestamp onto the token (TOKEN_RE eats digits and ':') and poison every later retry read.
  opts?: { preserve?: string; source?: string },
): void {
  if (el.dataset.rsnSrc === undefined) el.dataset.rsnSrc = opts?.source ?? el.textContent ?? '';
  const view = `${status}\u0000${text}`;
  if (el.dataset.rsnView === view) return;
  el.dataset.rsnView = view;

  // Blank the platform's own text HOWEVER deeply it is nested. Meta (Instagram, Messenger),
  // WhatsApp, and Telegram wrap message text in spans, so blanking only direct children leaves
  // the raw token next to our decrypted text (the "RSN1M:... \n Hey" bug). Never blank our OWN
  // content/badge, so a re-render can't clobber the decrypted text or a revealed ciphertext.
  const skip = `.rsn-content, .rsn-badge${opts?.preserve ? `, ${opts.preserve}` : ''}`;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const texts: Node[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n);
  for (const n of texts) n.nodeValue = '';

  // Hush: an empty info bubble is protocol chatter we deliberately collapse out of the
  // conversation (e.g. the handshake replayed with every message for delivery reliability —
  // the receiver only needs to see "secure channel established" once). The text is already
  // blanked above so no ciphertext flashes; drop our content/badge and hide the element.
  if (status === 'info' && text === '') {
    el.querySelector(':scope > .rsn-content')?.remove();
    el.querySelector(':scope > .rsn-badge')?.remove();
    el.classList.add('rsn-hush');
    return;
  }
  el.classList.remove('rsn-hush');

  // Our content takes the platform text's place: BEFORE the preserved chrome, never after.
  // Telegram floats/absolutes its trailing .time — appended after it, our text wraps around
  // a float that now sits on the FIRST line (time stamped on top of the words, bubble too
  // tall). insertBefore(null) degrades to append where there is no chrome.
  const chrome = opts?.preserve ? el.querySelector(opts.preserve) : null;
  let content = el.querySelector<HTMLElement>(':scope > .rsn-content');
  const resolving = !!content; // an existing cover flipping to a new state (pending → decrypted)
  if (!content) {
    content = document.createElement('span');
    content.className = 'rsn-content';
    el.insertBefore(content, chrome);
  }
  content.textContent = text; // verbatim — decrypted content is never parsed as HTML

  let badge = el.querySelector<HTMLElement>(':scope > .rsn-badge');
  if (!badge) {
    badge = document.createElement('span');
    el.insertBefore(badge, chrome);
  }
  badge.className = `rsn-badge rsn-badge--${status}`;
  badge.innerHTML = BADGE_ICON[status]; // constant, trusted markup
  badge.title = BADGE_TITLE[status];
  badge.setAttribute('aria-label', BADGE_TITLE[status]);

  // Two voices. Decrypted = the SENDER's voice: native message text, lock trailing the
  // line like delivery metadata, plus a one-shot focus-pull as the words resolve (the
  // brand's dissolve-to-ciphertext motif, inverted). Everything else = EKKO's voice:
  // a compact chrome chip that leads with its icon, so protocol text can never be
  // mistaken for something the person typed.
  el.classList.toggle('rsn-system', status !== 'decrypted');
  if (status === 'decrypted') {
    el.insertBefore(badge, content.nextSibling); // lock trails the text, chrome stays last
    // Focus-pull ONLY when the words resolve before your eyes (a cover flipping to text).
    // A bubble born decrypted — your own just-sent message, or a bubble the platform
    // re-mounted and we re-rendered from the plaintext cache — renders still: replaying
    // the blur there is the "message jitters between ciphertext and text" bug.
    if (resolving) content.classList.add('rsn-in');
  } else {
    el.insertBefore(badge, content);
    content.classList.remove('rsn-in'); // a later decrypt re-adds it and plays again
  }

  // Reveal-original: clicking a decrypted badge toggles the bubble between the plaintext
  // and the ciphertext token that actually crossed the wire (rsnSrc).
  if (status === 'decrypted') {
    badge.classList.add('rsn-badge--btn');
    badge.title = `${BADGE_TITLE.decrypted} — click to see what was actually sent`;
    badge.onclick = (e) => {
      e.stopPropagation();
      const showCipher = content!.classList.toggle('rsn-cipher');
      content!.textContent = showCipher ? (el.dataset.rsnSrc ?? '') : text;
      badge!.title = showCipher
        ? 'This is the encrypted message as sent — click to show the text'
        : `${BADGE_TITLE.decrypted} — click to see what was actually sent`;
    };
  } else {
    badge.onclick = null;
    content.classList.remove('rsn-cipher');
  }
}

// Transient toast near the composer. One shared node, reused.
export function toast(message: string): void {
  let el = document.getElementById('rsn-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'rsn-toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('rsn-show');
  setTimeout(() => el && el.classList.remove('rsn-show'), 4500);
}

// The one stylesheet for everything this file renders (bubble content, badges, toast).
// Injected once by boot(); platform-independent.
export function injectStyle(): void {
  if (document.getElementById('rsn-style')) return;
  const css = `
    .rsn-content { unicode-bidi: plaintext; white-space: pre-wrap; }
    @keyframes rsn-in { from { opacity: 0; filter: blur(6px); } }
    .rsn-content.rsn-in { animation: rsn-in .26s ease-out; }
    @media (prefers-reduced-motion: reduce) { .rsn-content.rsn-in { animation: none; } }
    .rsn-content.rsn-cipher {
      font: 11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; opacity: .72; word-break: break-all;
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 8; overflow: hidden;
    }
    .rsn-badge { display: inline-flex; vertical-align: -1px; margin-left: 6px; opacity: .5; color: inherit; }
    .rsn-badge--btn { cursor: pointer; padding: 3px; margin: -3px -3px -3px 3px; border-radius: 4px; }
    .rsn-badge--btn:hover { opacity: .95; }
    .rsn-badge svg { width: 11px; height: 11px; }
    .rsn-badge--pending { color: color-mix(in srgb, currentColor 55%, #c99a3f); }
    .rsn-badge--error { color: color-mix(in srgb, currentColor 35%, #eb4d3d); }
    .rsn-system { font-style: normal; opacity: .82; }
    .rsn-system:has(.rsn-badge--error) { opacity: 1; }
    .rsn-system .rsn-content { font: 500 12px/1.5 system-ui, -apple-system, sans-serif; letter-spacing: .01em; }
    .rsn-system .rsn-badge { margin: 0 6px 0 0; vertical-align: -2px; opacity: .9; }
    .rsn-system .rsn-badge svg { width: 12px; height: 12px; }
    .rsn-hush { display: none !important; }
    #rsn-toast {
      position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%);
      background: #14161a; color: #f2f3f5; padding: 10px 16px; border-radius: 10px;
      font: 500 13px/1.45 system-ui, -apple-system, sans-serif; max-width: 400px;
      z-index: 2147483647; opacity: 0; pointer-events: none; transition: opacity .2s;
      box-shadow: 0 6px 24px rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.08);
    }
    #rsn-toast.rsn-show { opacity: 1; }`;
  const style = document.createElement('style');
  style.id = 'rsn-style';
  style.textContent = css;
  document.documentElement.appendChild(style);
}
