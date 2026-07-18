// ─────────────────────────────────────────────────────────────────────────────
// LIVE-TUNING SURFACE (WhatsApp Web). Like instagram.ts, this can only be verified
// against a logged-in web.whatsapp.com — the SELECTORS block is the single place to
// re-patch when a build shifts. WhatsApp obfuscates class names every deploy, so we
// anchor ONLY on role / data-* / contenteditable / #main·footer·header structure, never
// on classes (except the long-stable semantic ones: message-in/out, selectable-text,
// copyable-text). Selector provenance + confidence: see docs/ADAPTERS.md.
//
// One WhatsApp-specific fact drives the send path: a synthetic Enter (isTrusted:false) is
// unreliable here, so we SEND BY CLICKING the send button. When the composer is empty that
// button is replaced by the mic, which is also how we confirm a send cleared.
//
// IDENTITY (verified live against web.whatsapp.com 2026-07-12): WhatsApp REMOVED the JID from
// the visible DOM. A message's data-id is now a bare msg id ("3A0123456789ABCDEF0") and no
// @c.us/@g.us appears on the page. But the real PHONE NUMBER is still on the origin — in the
// `model-storage` IndexedDB, which a content script reads in-process (same origin, no network).
// The `message` store's records carry the phone in their `from`/`to` (`<digits>@c.us`), and
// each record's key ends with the very msg id that is in the DOM data-id. So we map:
//   DOM data-id (msgid) -> model-storage `message` record (key endsWith _<msgid>) -> phone.
// The peer's phone is a PERMANENT, MUTUAL identifier (the same number for both sides), so it is
// the thread key AND the directory handle. The read is async, so a small per-msgid cache backs
// the sync adapter methods and a background lookup fills it; the peer's display NAME is the
// fallback binding until the phone resolves or if the DB is ever unavailable (never a directory
// lookup — a display name is not an account id). Contacts themselves moved to `@lid` (WhatsApp's
// privacy id) and `lid-pn-mapping` is empty, which is why the number must come from `message`.
// ─────────────────────────────────────────────────────────────────────────────
import { ComposerGlyph } from './glyph.js';
import { boot } from './boot.js';
import {
  isVisible,
  until,
  readComposerNode,
  renderBubble,
  toast,
  placeInComposer,
  restoreComposerDraft,
} from './dom.js';
import type { SiteAdapter, SendHook, BubbleStatus, ChatState, ChatActions } from './adapter.js';

// WhatsApp accepts up to 65536 chars; 8000 is comfortably under and keeps the ~3.1k
// handshake a single message (no chunking) while avoiding any pathological long-line cost.
const WA_MAX_MESSAGE_LEN = 8000;

const SELECTORS = {
  main: '#main', // the open-chat pane; also the MutationObserver root
  // Peer display name: the title-attr span is gone; the header's dir=auto span carries it.
  peerName: '#main header span[dir="auto"]',
  // Scope the composer to footer — the FIRST contenteditable on the page is the left-pane
  // search box (data-tab="3"); the composer is data-tab="10" (value drifts, so it's a hint).
  composer: '#main footer div[contenteditable="true"][data-tab="10"]',
  composerAlt: '#main footer div[contenteditable="true"]',
  textSpan: 'span.selectable-text', // read from #main only; gate real text on copyable-text
  textBubble: 'div.copyable-text[data-pre-plain-text]', // presence == a real text message
  prePlain: '#main [data-pre-plain-text]', // "[time, date] Sender: " — author per message
  // Send control: the icon was renamed (data-icon "send" -> "wds-ic-send-filled"); the
  // aria-label stays "Send". Match either. The button only exists once the composer has text.
  sendButton: '#main footer button[aria-label="Send"]',
  sendIcon: '#main footer [data-icon="wds-ic-send-filled"], #main footer [data-icon="send"]',
} as const;

// Peer phone from a model-storage `message` record. In a 1:1 the two parties are `from`
// (sender) and `to` (recipient), each "<digits>@c.us"; the peer is the one that is not me,
// and the key prefix tells us which: `true_` = I sent it (peer = `to`), `false_` = the peer
// sent it (peer = `from`). Anything not a plain @c.us phone (group @g.us, @lid, status 0@c.us)
// yields null. Pure + exported for the unit test.
export function peerPhoneFromMessage(rec: { from?: unknown; to?: unknown }, fromMe: boolean): string | null {
  const party = fromMe ? rec.to : rec.from;
  const s = typeof party === 'string' ? party : (party as { _serialized?: string } | undefined)?._serialized;
  const m = typeof s === 'string' ? s.match(/^(\d{6,15})@c\.us$/) : null;
  return m ? m[1]! : null;
}

const idbReq = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

// Reverse-scan the `message` store (newest first, bounded) for the key ending in `_<msgId>`,
// then read the peer's phone from that record. Returns null on any surprise (no DB, old schema,
// group/LID message) so the caller falls back to the name binding — never throws into a scan.
async function lookupPeerPhone(msgId: string): Promise<string | null> {
  let db: IDBDatabase;
  try {
    db = await idbReq(indexedDB.open('model-storage'));
  } catch {
    return null;
  }
  try {
    if (!db.objectStoreNames.contains('message')) return null;
    const suffix = '_' + msgId;
    const fullKey = await new Promise<IDBValidKey | null>((res) => {
      let scanned = 0;
      // Newest-first: an active chat's message is found in the first few hundred keys. ponytail:
      // 60k cap so a pathological history can't stall the lookup — an INACTIVE chat's latest
      // message can sit deep in the global store (measured: a real key-only scan is ~80ms/20k),
      // and past the cap we fall back to the name binding rather than hang.
      const cur = db.transaction('message', 'readonly').objectStore('message').openKeyCursor(null, 'prev');
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c || scanned++ > 60000) return res(null);
        if (String(c.key).endsWith(suffix)) return res(c.key);
        c.continue();
      };
      cur.onerror = () => res(null);
    });
    if (fullKey == null) return null;
    const rec = (await idbReq(db.transaction('message', 'readonly').objectStore('message').get(fullKey))) as
      | { from?: unknown; to?: unknown }
      | undefined;
    return rec ? peerPhoneFromMessage(rec, String(fullKey).startsWith('true_')) : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export class WhatsAppAdapter implements SiteAdapter {
  readonly platform = 'whatsapp';
  readonly platformLabel = 'WhatsApp';
  readonly maxMessageLen = WA_MAX_MESSAGE_LEN;

  // msgid -> resolved phone, or null once looked up with no phone (so we stop retrying and
  // commit to the name fallback). Keyed by msgid, which is unique to THIS chat's messages, so
  // it can never return another chat's number the way a display-name key could.
  private phoneByMsgId = new Map<string, string | null>();
  private phoneLookupBusy = false;

  // Message ids from the open chat's rendered bubbles (the bare DOM data-ids, e.g. "3A74…").
  private domMsgIds(): string[] {
    const main = document.querySelector<HTMLElement>(SELECTORS.main);
    if (!main) return [];
    const ids: string[] = [];
    for (const el of main.querySelectorAll<HTMLElement>('[data-id]')) {
      const id = el.getAttribute('data-id');
      if (id && /^[0-9A-F]{16,}$/i.test(id)) ids.push(id);
    }
    return ids;
  }

  // The open chat's peer phone from cache; kicks off a background IndexedDB lookup on a miss.
  // Public: satisfies SiteAdapter.peerPhone (here it equals peerHandle — same digits).
  peerPhone(): string | null {
    const ids = this.domMsgIds();
    for (const id of ids) {
      const p = this.phoneByMsgId.get(id);
      if (p) return p;
    }
    if (ids.some((id) => !this.phoneByMsgId.has(id))) void this.resolvePhone(ids);
    return null;
  }

  // True once every currently-visible msgid has been looked up (so threadId can commit to the
  // name fallback instead of hanging on "identifying").
  private phoneTried(): boolean {
    const ids = this.domMsgIds();
    return ids.length > 0 && ids.every((id) => this.phoneByMsgId.has(id));
  }

  private async resolvePhone(ids: string[]): Promise<void> {
    if (this.phoneLookupBusy) return;
    this.phoneLookupBusy = true;
    try {
      const target = ids.find((id) => !this.phoneByMsgId.has(id));
      if (!target) return;
      const phone = await lookupPeerPhone(target).catch(() => null);
      // Cache the result for every visible msgid — they belong to this same chat, so they share
      // the peer's phone; future scans then hit instantly and switching chats re-resolves.
      for (const id of ids) this.phoneByMsgId.set(id, phone);
    } finally {
      this.phoneLookupBusy = false;
    }
  }

  peerName(): string | null {
    const name = document.querySelector<HTMLElement>(SELECTORS.peerName)?.textContent?.trim();
    return name ? name.replace(/^@/, '').slice(0, 40) : null;
  }

  // Distinct message authors, read from each message's data-pre-plain-text ("[time, date]
  // Name: "). A 1:1 has at most two (you + the peer); three or more is unambiguously a group
  // — this can only UNDERcount (a quiet group), never overcount a 1:1.
  private senderCount(): number {
    const names = new Set<string>();
    for (const el of document.querySelectorAll<HTMLElement>(SELECTORS.prePlain)) {
      const m = el.getAttribute('data-pre-plain-text')?.match(/]\s*([^:]+):\s*$/);
      if (m) names.add(m[1]!.trim());
    }
    return names.size;
  }

  isDirectChat(): boolean | null {
    if (!document.querySelector(SELECTORS.main)) return false;
    const name = this.peerName();
    if (!name) return null; // header not rendered yet: fail closed
    if (this.senderCount() > 2) return false; // 3+ authors = group
    // The composer aria-label personalizes to the single peer in a 1:1 ("Type a message to
    // <name>"); a group's composer is generic. Locale-robust: require the peer NAME in the
    // aria, not the English word "to". Fail VISIBLE (null) when we can't confirm, never guess
    // direct — offering 1:1 crypto inside a group would break it.
    // ponytail: a quiet 2-speaker group whose composer somehow carried the peer name could
    // still read as direct; retune if group leakage ever shows up in the debug overlay.
    const aria = this.composer()?.getAttribute('aria-label') ?? '';
    return aria.includes(name) ? true : null;
  }

  // The thread key committed for the currently-open chat, held stable for its whole
  // lifetime (see threadId). Cleared when the chat closes or the peer changes.
  private pinnedThread: { peer: string; key: string } | null = null;

  // Thread key: prefer the peer's phone number (permanent + mutual, from IndexedDB). Until it
  // resolves, return null ("identifying") so a chat is never bound under two different keys.
  // If the lookup finished with NO phone (old schema, group/LID-only history, DB missing), fall
  // back to the display name so encryption still works. encodeURIComponent because scoped thread
  // ids must be printable ASCII with no spaces (thread.ts SCOPED_THREAD_ID_RE = [!-~]+): a raw
  // spaced or non-ASCII name would be rejected as bad-thread and stick on "identifying".
  //
  // STABILITY INVARIANT (live-verified 2026-07-17): once a non-null key is committed for the
  // open chat, keep returning THAT key until the chat actually changes. Without this the key
  // flips from name:<peer> to pn:<phone> the instant the FIRST outgoing message lands in
  // model-storage — which on first contact happens BETWEEN the handshake and the message of a
  // single send. The controller pins the thread across a multi-part send and aborts when
  // activeThreadId() changes, so that flip dropped the message half ("1 of 2 parts went out")
  // and left the peer unable to decrypt. The phone is still preferred on the NEXT open, when
  // real history resolves it before any send.
  threadId(): string | null {
    if (this.isDirectChat() !== true) {
      this.pinnedThread = null;
      return null;
    }
    const peer = this.peerName() ?? '';
    if (this.pinnedThread && this.pinnedThread.peer === peer) return this.pinnedThread.key;
    const phone = this.peerPhone();
    const name = this.peerName();
    const key = phone
      ? `pn:${phone}`
      : this.phoneTried() && name
        ? `name:${encodeURIComponent(name.toLowerCase())}`
        : null;
    if (key) this.pinnedThread = { peer, key };
    return key;
  }

  // Directory handle = the peer's phone number (digits), so WhatsApp auto-discovery now keys on
  // a real, mutual identifier. Null until the IndexedDB lookup resolves (or if it found none) —
  // a display name is never returned here, so the directory is never queried on a guess.
  peerHandle(): string | null {
    return this.peerPhone();
  }

  private composer(): HTMLElement | null {
    const box =
      document.querySelector<HTMLElement>(SELECTORS.composer) ??
      document.querySelector<HTMLElement>(SELECTORS.composerAlt);
    return box && isVisible(box) ? box : null;
  }

  private sendButton(): HTMLElement | null {
    const byLabel = document.querySelector<HTMLElement>(SELECTORS.sendButton);
    if (byLabel && isVisible(byLabel)) return byLabel;
    const byIcon = document.querySelector<HTMLElement>(SELECTORS.sendIcon)?.closest('button');
    return byIcon && isVisible(byIcon) ? byIcon : null;
  }

  findBubbles(): HTMLElement[] {
    const main = document.querySelector<HTMLElement>(SELECTORS.main);
    if (!main) return [];
    const composer = this.composer();
    // The message text lives in span.selectable-text inside a copyable-text row. Reading
    // from #main only keeps starred/search/forward-picker drawers out.
    return Array.from(main.querySelectorAll<HTMLElement>(SELECTORS.textSpan)).filter(
      (s) => s.textContent && isVisible(s) && (!composer || !composer.contains(s)),
    );
  }

  bubbleText(el: HTMLElement): string {
    return el.dataset.rsnSrc ?? el.textContent ?? '';
  }

  replaceBubbleText(el: HTMLElement, text: string, status: BubbleStatus): void {
    renderBubble(el, text, status);
  }

  readComposer(): string {
    const box = this.composer();
    return box ? readComposerNode(box) : '';
  }

  // Composer writes route through dom.ts's Lexical-proof Selection writer (the mechanism
  // this adapter live-verified 2026-07-17 — execCommand clears are no-ops on this build).
  // WhatsApp's placement signal: the box holds exactly the token AND the mic swapped to
  // the send button.
  private place(text: string): Promise<HTMLElement | null> {
    return placeInComposer(() => this.composer(), text, () => !!this.sendButton());
  }

  // Click send and confirm delivery. Success = the box WE filled is now empty (a WhatsApp
  // send always clears the composer). If WhatsApp remounts the node on send, a fresh empty
  // composer proves nothing (it reads empty whether or not the message left) — then only
  // the token echoing in an outgoing bubble counts. Same rule as Instagram's delivered():
  // a bare remount must never read as success, and must never trigger a blind retry that
  // could duplicate the send.
  private async sendAndConfirm(box: HTMLElement, text: string): Promise<boolean> {
    const nodeAlive = () => box.isConnected && this.composer() === box;
    const emptied = () => readComposerNode(box).trim() === '';
    const delivered = () =>
      nodeAlive() ? emptied() : this.findBubbles().some((b) => this.bubbleText(b).includes(text));
    // Primary and only: click send. WhatsApp ignores untrusted Enter keydowns, and a bare
    // synthetic click() on the button verifiably sends (live 2026-07-17).
    this.sendButton()?.click();
    if (await until(delivered, 1000)) return true;
    if (nodeAlive() && !emptied()) {
      // Nothing left the box — the first click likely landed mid mic↔send swap. A second
      // click is safe exactly in this state: a message that HAD gone out would have
      // cleared the box, so we cannot be duplicating one.
      this.sendButton()?.click();
      return until(delivered, 1000);
    }
    return false;
  }

  async injectAndSend(text: string): Promise<void> {
    // A multi-part send (first-contact = handshake + message) sends parts back-to-back, and
    // the previous part's send remounts the footer — wait for a composer to exist before
    // calling it missing. Live-verified: the message half arrives ~1s after the handshake,
    // squarely inside that re-render window.
    if (!this.composer()) await until(() => !!this.composer(), 800);
    const draftBox = this.composer();
    if (!draftBox) throw new Error('send-failed');
    const original = readComposerNode(draftBox);

    const box = (await this.place(text)) ?? (await this.place(text));
    if (box && (await this.sendAndConfirm(box, text))) return;
    restoreComposerDraft(() => this.composer(), original, text);
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
    // Enter-to-send is WhatsApp's default; intercept it in capture (a real user's Enter is
    // trusted, so this fires) as well as clicks on the send button.
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
    return {
      composer: !!this.composer(),
      sendButton: !!this.sendButton(),
      peer: this.peerName() ?? '—',
      phone: this.peerPhone() ?? (this.phoneTried() ? 'none' : '…'),
      direct: String(this.isDirectChat()),
      senders: this.senderCount(),
      bubbles: this.findBubbles().length,
      glyph: this.glyph?.visible() ?? false,
    };
  }
}

boot(new WhatsAppAdapter());
