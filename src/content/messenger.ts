// ─────────────────────────────────────────────────────────────────────────────
// LIVE-TUNING SURFACE (Facebook Messenger, www.messenger.com). Same Meta React stack as
// Instagram — hash-mangled classes, virtualized lists — so select by STRUCTURE and ARIA
// roles, never by class. The SELECTORS block is the single re-patch point.
//
// Messenger is the BEST-behaved of the adapters for identity (verified live 2026-07-12):
//   - threadId is the numeric conversation id in the URL (/t/<id>/ or /e2ee/t/<id>/) —
//     stable per conversation, exactly like Instagram.
//   - peerHandle is the peer's GLOBAL Facebook user id, exposed as an ordinary profile link
//     inside the open conversation (`[role="main"] a[href*="facebook.com/<id>"]`). That is a
//     permanent, MUTUAL identifier — the same number for everyone who talks to that person —
//     so directory discovery keys on something real, not a contact-book display name.
//   - 1:1 vs group = the count of DISTINCT peer ids in the conversation (your own id does not
//     appear there); one peer = 1:1, several = group.
// The open thread lives entirely inside `[role="main"]` (the thread list sits outside it), so
// that is the scope root for peer links and message bubbles.
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

// Messenger's cap is ~20k; 8000 keeps the ~3.1k handshake a single message and stays clear
// of any pathological long-line cost.
const MSGR_MAX_MESSAGE_LEN = 8000;

const SELECTORS = {
  main: '[role="main"]', // the open conversation only; the thread list is outside it
  composer: '[role="main"] [contenteditable="true"][role="textbox"]',
  // Message bubbles: Messenger tags the log's rows with data-scope="messages_table".
  messageScope: '[data-scope="messages_table"]',
  textSpan: 'span[dir="auto"], div[dir="auto"]',
  // Peer profile links carry the Facebook user id: facebook.com/<id-or-username>/.
  profileLink: 'a[href*="facebook.com/"]',
  sendButtonText: 'Send',
} as const;

// facebook.com paths that are not a profile.
const RESERVED_FB = new Set(['', 'messages', 'help', 'privacy', 'policies', 'legal', 'watch', 'marketplace', 'groups', 'events', 'photo', 'story.php', 'profile.php']);

export class MessengerAdapter implements SiteAdapter {
  readonly platform = 'messenger';
  readonly platformLabel = 'Messenger';
  readonly maxMessageLen = MSGR_MAX_MESSAGE_LEN;

  private main(): HTMLElement | null {
    return document.querySelector<HTMLElement>(SELECTORS.main);
  }

  threadId(): string | null {
    // /t/<id>/ and /e2ee/t/<id>/ both carry the numeric conversation id.
    const m = location.pathname.match(/\/t\/(\d+)/);
    return m ? m[1]! : null;
  }

  // The Facebook id (or vanity username) from a profile link, or null for a non-profile link.
  private fbIdOf(a: HTMLAnchorElement): string | null {
    try {
      const u = new URL(a.href, location.href);
      if (!/(^|\.)facebook\.com$/.test(u.hostname)) return null;
      const seg = u.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
      return seg && !RESERVED_FB.has(seg) ? seg : null;
    } catch {
      return null;
    }
  }

  // Distinct peer profile anchors inside the open conversation, topmost first. The header
  // link sits above the message log, so it wins; your own id never appears here.
  private peerLinks(): { a: HTMLAnchorElement; id: string }[] {
    const main = this.main();
    if (!main) return [];
    const seen = new Set<string>();
    const out: { a: HTMLAnchorElement; id: string }[] = [];
    const ranked = Array.from(main.querySelectorAll<HTMLAnchorElement>(SELECTORS.profileLink))
      .map((a) => ({ a, id: this.fbIdOf(a) }))
      .filter((c): c is { a: HTMLAnchorElement; id: string } => !!c.id && isVisible(c.a))
      .sort((x, y) => x.a.getBoundingClientRect().top - y.a.getBoundingClientRect().top);
    for (const c of ranked)
      if (!seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
      }
    return out;
  }

  isDirectChat(): boolean | null {
    if (!this.threadId()) return false;
    const peers = this.peerLinks();
    if (peers.length === 0) return null; // conversation not rendered yet: fail VISIBLE
    return peers.length === 1; // one distinct peer id = 1:1; several = group
  }

  peerName(): string | null {
    // The peer profile anchor's text is the display name (locale-independent). Fall back to
    // the composer's "Write to <name>" aria if the anchor is the bare avatar (no text).
    const named = this.peerLinks().find((p) => (p.a.textContent || '').trim());
    const fromLink = named?.a.textContent?.trim();
    if (fromLink) return fromLink.replace(/^@/, '').slice(0, 40);
    const aria = this.composer()?.getAttribute('aria-label') ?? '';
    const m = aria.match(/^\s*\S+\s+(?:to|à|a|an|para)\s+(.+)$/i); // "Write to X" and common locales
    return m ? m[1]!.trim().slice(0, 40) : null;
  }

  peerHandle(): string | null {
    return this.peerLinks()[0]?.id ?? null;
  }

  private composer(): HTMLElement | null {
    const box = document.querySelector<HTMLElement>(SELECTORS.composer);
    return box && isVisible(box) ? box : null;
  }

  // Search OUTWARD from the composer so a "Send" control elsewhere on the page can't match.
  private sendButton(): HTMLElement | null {
    const box = this.composer();
    let scope: HTMLElement | null = box?.parentElement ?? null;
    for (let depth = 0; scope && depth < 8; depth++, scope = scope.parentElement) {
      const hit = Array.from(scope.querySelectorAll<HTMLElement>('div[role="button"], button')).find(
        (b) =>
          isVisible(b) &&
          !b.contains(box!) &&
          (b.textContent?.trim() === SELECTORS.sendButtonText || /(^|\s)send(\s|$)/i.test(b.getAttribute('aria-label') ?? '')),
      );
      if (hit) return hit;
    }
    return null;
  }

  findBubbles(): HTMLElement[] {
    const main = this.main();
    if (!main) return [];
    // Prefer the message-table scope; fall back to main if Messenger drops the data-scope.
    const roots = main.querySelectorAll<HTMLElement>(SELECTORS.messageScope);
    const scope: ParentNode = roots.length ? roots[0]! : main;
    const composer = this.composer();
    return Array.from(scope.querySelectorAll<HTMLElement>(SELECTORS.textSpan)).filter(
      (s) =>
        s.textContent &&
        isVisible(s) &&
        (!composer || !composer.contains(s)) &&
        !s.closest(SELECTORS.profileLink), // a sender's name link is not a message
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

  // Fire the send and confirm delivery. Success = the box WE filled emptied (a Messenger
  // send always clears the composer). If React remounts the node, a fresh empty composer
  // proves nothing (it reads empty whether or not the message left) — then only the token
  // echoing in an outgoing bubble counts. Same rule as WhatsApp/Instagram: a bare remount
  // never reads as success, and never triggers a blind retry that could duplicate a send.
  private async sendAndConfirm(box: HTMLElement, text: string): Promise<boolean> {
    const nodeAlive = () => box.isConnected && this.composer() === box;
    const emptied = () => readComposerNode(box).trim() === '';
    const delivered = () =>
      nodeAlive() ? emptied() : this.findBubbles().some((b) => this.bubbleText(b).includes(text));
    // Primary: synthetic Enter (Messenger's default). Fallback: click Send — safe exactly
    // while the SAME node still holds our token, because a message that HAD gone out would
    // have cleared the box.
    box.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }),
    );
    if (await until(delivered, 700)) return true;
    if (nodeAlive() && !emptied()) {
      this.sendButton()?.click();
      return until(delivered, 1000);
    }
    return false;
  }

  // Composer writes route through dom.ts's Lexical-proof Selection writer — Messenger is
  // the same Meta Lexical editor family as WhatsApp, where execCommand clears were
  // live-proven no-ops (2026-07-17). placeInComposer confirms the box holds EXACTLY the
  // token, so a leftover draft can never ride along into the send.
  async injectAndSend(text: string): Promise<void> {
    // A multi-part send (first contact = handshake + message) sends parts back-to-back,
    // and the previous part's send can leave the composer's container mid re-render —
    // wait for a composer to exist before calling it missing.
    if (!this.composer()) await until(() => !!this.composer(), 800);
    const draftBox = this.composer();
    if (!draftBox) throw new Error('send-failed');
    const original = readComposerNode(draftBox);

    const place = () => placeInComposer(() => this.composer(), text);
    const box = (await place()) ?? (await place());
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
      handle: this.peerHandle() ?? '—',
      direct: String(this.isDirectChat()),
      peers: this.peerLinks().length,
      bubbles: this.findBubbles().length,
      glyph: this.glyph?.visible() ?? false,
    };
  }
}

boot(new MessengerAdapter());
