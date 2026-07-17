// ─────────────────────────────────────────────────────────────────────────────
// LIVE-TUNING SURFACE (Telegram Web). Telegram ships TWO different web apps with entirely
// different DOMs, and both live under web.telegram.org:
//   • WebK  → /k/  (morethanwords/tweb)         — the default
//   • WebA  → /a/  (Ajaxy/telegram-tt, also /z/) — the React one
// This adapter supports both: it detects the client and switches the SELECTORS + identity
// source. Selectors read from each client's own source (class names are hand-authored, not
// build-hashed). The SEL block is the single re-patch point. Provenance: docs/ADAPTERS.md.
//
// Identity differs by client:
//   • WebK: the URL hash is unreliable (it becomes "#@username"), so use data-peer-id from
//     the header/.bubble.  peerId >= 0 = user DM, < 0 = group/channel.
//   • WebA: the URL hash IS a stable numeric chatId ("#<chatId>[_...]").  >= 0 = user DM.
// The peer's @USERNAME and PHONE are NOT in the chat-header DOM (only the display name is) —
// both clients keep the logged-in state in IndexedDB, so we read them there keyed on the peer
// id we already have (mirrors whatsapp.ts, which reads the phone from model-storage). Telegram
// hides the phone from non-mutual-contacts, so `phone` is null far more often than not.
// Both clients append time/meta inside the text element, so bubbleText() strips it, and
// both send reliably via a send-button click (the Enter shortcut is user-configurable).
// ─────────────────────────────────────────────────────────────────────────────
import { ComposerGlyph } from './glyph.js';
import { boot } from './boot.js';
import { isVisible, until, readComposerNode, renderBubble, toast } from './dom.js';
import type { SiteAdapter, SendHook, BubbleStatus, ChatState, ChatActions } from './adapter.js';

const TG_MAX_MESSAGE_LEN = 4000; // Telegram's hard cap is 4096; 4000 leaves tagline headroom.

// Per-client selector sets. `strip` is removed from a bubble's text before classification.
const SEL = {
  k: {
    messageText: '.bubble:not(.service):not(.is-date):not(.is-sponsored) .message',
    strip: '.time, .time-inner, .reactions-element, .web, .replies-element',
    peerName: '.chat-info .peer-title',
    composer: '.input-message-input[contenteditable="true"]',
    sendButton: '.btn-send',
  },
  a: {
    messageText: '.MessageList .Message:not(.ActionMessage) .text-content',
    strip: '.MessageMeta, .message-time, .reactions, .Reactions',
    peerName: '.MiddleHeader .fullName, .MiddleHeader .info .title',
    composer: '.messages-layout .Transition_slide-active #editable-message-text, #editable-message-text',
    sendButton: 'button.main-button.send',
  },
} as const;

type TgIdentity = { username: string | null; phone: string | null };

const idbReq = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

// Pick the peer's public @username and phone out of a Telegram user record. Two client shapes:
//   WebK/tweb:          raw MTProto — { username, phone, usernames:[{username,pFlags:{active}}] }
//   WebA/telegram-tt:   camelCase   — { usernames:[{username,isActive}], phoneNumber }
// A user can have a legacy single `username` and/or the newer collectible `usernames[]`; take the
// active collectible, else the first, else the legacy field. Phone is digits only (6-15) or null —
// Telegram withholds it from non-contacts, so null is the common, correct result. Pure + exported
// for the unit test.
export function pickTelegramIdentity(rec: unknown): TgIdentity {
  const r = (rec ?? {}) as Record<string, unknown>;
  const list = Array.isArray(r.usernames) ? (r.usernames as Array<Record<string, unknown>>) : [];
  const active =
    list.find((u) => u && (((u.pFlags as { active?: unknown })?.active ?? u.isActive ?? u.active) === true)) ?? list[0];
  const uname =
    (typeof r.username === 'string' && r.username) ||
    (active && typeof active.username === 'string' ? active.username : '') ||
    '';
  const rawPhone =
    (typeof r.phone === 'string' && r.phone) || (typeof r.phoneNumber === 'string' && r.phoneNumber) || '';
  const digits = rawPhone.replace(/\D/g, '');
  return {
    username: uname ? uname.toLowerCase().replace(/^@/, '') : null,
    phone: /^\d{6,15}$/.test(digits) ? digits : null,
  };
}

// Read the peer's identity from Telegram Web's own IndexedDB. DB + store names are discovered at
// runtime (indexedDB.databases() + the live objectStoreNames) so a client version bump or tweb's
// `__encrypted` store-name suffix can't break it. Returns null on anything unexpected — the caller
// keeps the DOM/id fallback. Never throws into the caller.
// ponytail: reads the store as plaintext JSON — if the user set a Telegram local passcode tweb
// encrypts the values and this yields null (→ fall back to the numeric id). Add passcode decrypt
// only if that case ever actually shows up.
async function readPeerIdentity(webA: boolean, peerId: string): Promise<TgIdentity | null> {
  let infos: IDBDatabaseInfo[];
  try {
    infos = (await indexedDB.databases?.()) ?? [];
  } catch {
    return null;
  }
  for (const info of infos) {
    const name = info.name;
    // WebK persists under `tweb`; WebA (telegram-tt) under a `tt-*` db. Skip everything else.
    if (!name || (webA ? !/^tt[-_]/i.test(name) : !/tweb/i.test(name))) continue;
    let db: IDBDatabase;
    try {
      db = await idbReq(indexedDB.open(name));
    } catch {
      continue;
    }
    try {
      const stores = Array.from(db.objectStoreNames);
      if (webA) {
        // telegram-tt keeps the whole global state under one key; users live at .users.byId[id].
        for (const s of stores) {
          const state = await idbReq(db.transaction(s, 'readonly').objectStore(s).get('tt-global-state')).catch(
            () => null,
          );
          const rec = (state as { users?: { byId?: Record<string, unknown> } } | null)?.users?.byId?.[peerId];
          if (rec) return pickTelegramIdentity(rec);
        }
      } else {
        // tweb keeps one record per user, keyed by the numeric id, in a `users…` store.
        for (const s of stores.filter((n) => /^users/i.test(n))) {
          for (const key of [Number(peerId), peerId] as IDBValidKey[]) {
            const rec = await idbReq(db.transaction(s, 'readonly').objectStore(s).get(key)).catch(() => null);
            if (rec) return pickTelegramIdentity(rec);
          }
        }
      }
    } finally {
      db.close();
    }
  }
  return null;
}

export class TelegramAdapter implements SiteAdapter {
  readonly platform = 'telegram';
  readonly platformLabel = 'Telegram';
  readonly maxMessageLen = TG_MAX_MESSAGE_LEN;

  // WebA lives under /a/ (and the legacy /z/); everything else is WebK (/k/, or bare root
  // which redirects to /k/). Cheap to recompute; the client only changes on a full reload.
  private webA(): boolean {
    return location.pathname.startsWith('/a') || location.pathname.startsWith('/z');
  }
  private sel() {
    return this.webA() ? SEL.a : SEL.k;
  }

  // Stable numeric chat id. WebA: from the URL hash (numeric, reliable). WebK: from the DOM
  // data-peer-id (the hash there can be "@username"). Null until the chat renders.
  private chatId(): string | null {
    if (this.webA()) {
      const id = location.hash.slice(1).split('_')[0];
      return id && /^-?\d+$/.test(id) ? id : null;
    }
    const el =
      document.querySelector<HTMLElement>('.chat-info .peer-title[data-peer-id]') ??
      document.querySelector<HTMLElement>('.bubble[data-peer-id]');
    const id = el?.getAttribute('data-peer-id');
    return id && /^-?\d+$/.test(id) ? id : null;
  }

  isDirectChat(): boolean | null {
    const id = this.chatId();
    if (!id) return document.querySelector('.chat, #MiddleColumn, .messages-layout') ? null : false;
    return Number(id) >= 0; // user peer = 1:1 DM; negative = group/channel
  }

  threadId(): string | null {
    return this.chatId();
  }

  peerName(): string | null {
    const el = document.querySelector<HTMLElement>(this.sel().peerName);
    const name = el?.textContent?.trim();
    return name ? name.replace(/^@/, '').slice(0, 40) : null;
  }

  // peerId -> resolved identity (cached once looked up, so debugProbe/peerHandle stay sync). Keyed
  // by the numeric peer id, so switching chats re-resolves and a result never bleeds across peers.
  private identityByPeer = new Map<string, TgIdentity>();
  private identityBusy = false;

  private peerIdentity(): TgIdentity | null {
    const id = this.chatId();
    if (!id) return null;
    const hit = this.identityByPeer.get(id);
    if (hit) return hit;
    void this.resolveIdentity(id);
    return null;
  }

  private async resolveIdentity(peerId: string): Promise<void> {
    if (this.identityBusy || this.identityByPeer.has(peerId)) return;
    this.identityBusy = true;
    try {
      const found = await readPeerIdentity(this.webA(), peerId).catch(() => null);
      this.identityByPeer.set(peerId, found ?? { username: null, phone: null });
    } finally {
      this.identityBusy = false;
    }
  }

  peerHandle(): string | null {
    // Fast path: WebK occasionally puts `#@username` in the hash or a t.me link in the header.
    const hash = location.hash.match(/^#@([a-z0-9_]{5,32})$/i)?.[1];
    if (hash) return hash.toLowerCase();
    const link = document.querySelector<HTMLAnchorElement>(
      '.chat-info a[href*="t.me/"], .MiddleHeader a[href*="t.me/"]',
    );
    try {
      const handle = link && new URL(link.href).pathname.split('/').filter(Boolean)[0];
      if (handle) return handle.toLowerCase();
    } catch {
      // fall through to the IndexedDB-backed username
    }
    // Real source: Telegram Web's IndexedDB (the username isn't in the collapsed chat header).
    return this.peerIdentity()?.username ?? null;
  }

  private composer(): HTMLElement | null {
    const boxes = Array.from(document.querySelectorAll<HTMLElement>(this.sel().composer)).filter(isVisible);
    // Bottom-most visible input is the active chat composer (reply/edit boxes stack above,
    // and WebA keeps inactive-slide inputs in the DOM during transitions).
    return boxes.sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom).at(-1) ?? null;
  }

  private sendButton(): HTMLElement | null {
    const btn = document.querySelector<HTMLElement>(this.sel().sendButton);
    return btn && isVisible(btn) ? btn : null;
  }

  findBubbles(): HTMLElement[] {
    const composer = this.composer();
    return Array.from(document.querySelectorAll<HTMLElement>(this.sel().messageText)).filter(
      (el) => el.textContent && isVisible(el) && (!composer || !composer.contains(el)),
    );
  }

  // The message text minus the appended timestamp/reactions, so a bare token classifies.
  bubbleText(el: HTMLElement): string {
    if (el.dataset.rsnSrc !== undefined) return el.dataset.rsnSrc;
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(this.sel().strip).forEach((n) => n.remove());
    return clone.textContent ?? '';
  }

  replaceBubbleText(el: HTMLElement, text: string, status: BubbleStatus): void {
    renderBubble(el, text, status);
  }

  readComposer(): string {
    const box = this.composer();
    return box ? readComposerNode(box) : '';
  }

  async injectAndSend(text: string): Promise<void> {
    const box = this.composer();
    if (!box) throw new Error('send-failed');
    const readBox = () => readComposerNode(box);
    const alive = () => box.isConnected && this.composer() === box;
    const holds = () => readBox().includes(text);
    const original = readBox();
    box.focus();
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    document.execCommand('insertText', false, text); // fires the input event both clients need
    // Confirm the token landed AND the send button flipped out of mic/record state.
    if (!(await until(() => alive() && holds() && !!this.sendButton(), 700))) throw new Error('send-failed');
    const cleared = async (ms: number) => {
      const ok = await until(() => !alive() || !holds(), ms);
      if (!alive()) throw new Error('send-failed');
      return ok;
    };
    // Primary: click send (independent of the user's Enter/Ctrl+Enter shortcut setting).
    this.sendButton()?.click();
    if (await cleared(700)) return;
    // Fallback: synthetic Enter.
    box.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }),
    );
    if (await cleared(700)) return;
    box.focus();
    document.execCommand('selectAll', false);
    if (original.trim()) document.execCommand('insertText', false, original);
    else document.execCommand('delete', false);
    throw new Error('send-failed');
  }

  onSend(hook: SendHook): void {
    const run = (e: Event, isRepeat: boolean): void => {
      let text = '';
      let intercept = false;
      try {
        text = this.readComposer();
        intercept = hook.shouldHandle(text, isRepeat);
      } catch {
        intercept = true; // fail closed
      }
      if (!intercept) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (text.trim()) void hook.handle(text);
    };
    // Enter sends by default (Shift+Enter = newline); a real user's Enter is trusted, so
    // intercept it in capture, plus clicks on the send button.
    document.addEventListener(
      'keydown',
      (e) => {
        const ke = e as KeyboardEvent;
        if (ke.key !== 'Enter' || ke.shiftKey || ke.isComposing) return;
        if (!this.composer()?.contains(document.activeElement)) return;
        run(e, ke.repeat);
      },
      true,
    );
    document.addEventListener(
      'click',
      (e) => {
        const target = e.target as HTMLElement | null;
        if (target && this.sendButton()?.contains(target)) run(e, false);
      },
      true,
    );
  }

  notify(message: string): void {
    toast(message);
  }

  private glyph: ComposerGlyph | null = null;
  setChatState(state: ChatState, actions: ChatActions): void {
    if (!this.glyph) this.glyph = new ComposerGlyph(() => this.composer(), this.platformLabel, this.platform, this.maxMessageLen);
    this.glyph.update(state, actions);
  }

  destroy(): void {
    this.glyph?.destroy();
    this.glyph = null;
  }

  debugProbe(): Record<string, unknown> {
    const id = this.chatId();
    const idn = this.peerIdentity(); // returns the cached identity, or triggers the background read
    const resolved = id ? this.identityByPeer.get(id) : undefined;
    return {
      client: this.webA() ? 'WebA' : 'WebK',
      // '…' = IndexedDB read still in flight; 'none'/'hidden' = read finished, field absent
      // (a phone is 'hidden' because Telegram withholds it from non-contacts, not a selector miss).
      username: resolved ? (idn?.username ?? 'none') : '…',
      phone: resolved ? (idn?.phone ?? 'hidden') : '…',
      composer: !!this.composer(),
      sendButton: !!this.sendButton(),
      bubbles: this.findBubbles().length,
      glyph: this.glyph?.visible() ?? false,
    };
  }
}

boot(new TelegramAdapter());
