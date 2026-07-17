// ─────────────────────────────────────────────────────────────────────────────
// LIVE-TUNING SURFACE. Everything else in this project is unit-tested; this file is
// the one part that can only be verified against real instagram.com. Instagram ships
// hash-mangled class names and a virtualized React list, so we select by STRUCTURE and
// ARIA roles (stable-ish), never by class. When Meta reshuffles the DOM, the SELECTORS
// block below is the single place to re-patch. If synthetic-send ever stops working,
// the popup's manual encrypt/decrypt tools are the guaranteed fallback.
// Shared, platform-independent plumbing (bubble render, toast, composer read, bootstrap)
// lives in dom.ts / boot.ts; this file is Instagram's DOM only.
// ─────────────────────────────────────────────────────────────────────────────
import { ComposerGlyph } from './glyph.js';
import { boot } from './boot.js';
import { isVisible, until, readComposerNode, renderBubble, toast } from './dom.js';
import { IG_MAX_MESSAGE_LEN } from '../core/wire.js';
import type { SiteAdapter, SendHook, BubbleStatus, ChatState, ChatActions } from './adapter.js';

const SELECTORS = {
  composer:
    'div[role="textbox"][contenteditable="true"], div[contenteditable="true"][data-lexical-editor="true"], textarea[aria-label*="Message" i], textarea[placeholder*="Message" i]',
  main: 'main',
  // Desktop currently uses spans; mobile Safari also renders message bodies as div[dir].
  // findBubbles() applies a wire-token filter before returning any of these broad hits.
  messageText: 'span[dir="auto"], div[dir="auto"], span[dir="ltr"], div[dir="ltr"], span[dir="rtl"], div[dir="rtl"]',
  // Peer identification. Verified against live instagram.com 2026-07-12: the DM view has
  // NO <header> element and NO div[role="grid"] — both were assumed by the old selectors,
  // and their absence is what silently killed this adapter. `main header a` matched
  // nothing, so isDirectChat() sat at null forever ("identifying this chat", sends paused)
  // and peerHandle() never resolved, so the directory was never asked whether the peer is
  // on Ekko. The peer link is now an ordinary profile anchor in the conversation top bar:
  //   <a role="link" href="/klrusha/" aria-label="Open the profile page of klrusha">
  // The href is the account identifier; do not parse the aria-label (it is localized).
  profileLink: 'a[role="link"]',
  sendButtonText: 'Send',
} as const;

// Single-segment paths that look like a profile but are not.
const RESERVED_PATHS = new Set([
  'about',
  'accounts',
  'api',
  'blog',
  'challenge',
  'create',
  'developer',
  'direct',
  'download',
  'emails',
  'explore',
  'legal',
  'oauth',
  'p',
  'press',
  'privacy',
  'reel',
  'reels',
  'stories',
  'terms',
  'tv',
  'web',
]);

const WIRE_MARKER = /(?:EKK|RSN)1[HIMC]:/;

export class InstagramAdapter implements SiteAdapter {
  readonly platform = 'instagram';
  readonly platformLabel = 'Instagram';
  readonly maxMessageLen = IG_MAX_MESSAGE_LEN;

  private providerThreadId(): string | null {
    const m = location.pathname.match(/\/direct\/t\/([^/]+)/);
    return m ? m[1]! : null;
  }

  // A profile URL is exactly one path segment. Reserved routes (/reels/, /explore/, ...)
  // look identical and must not read as handles.
  private handleOf(a: HTMLAnchorElement): string | null {
    try {
      const url = new URL(a.href, location.href);
      // A shared post can contain arbitrary external links with one path segment. Only an
      // Instagram-hosted link can be a peer profile. Treat www/non-www as the same host because
      // the Safari manifest deliberately supports both.
      const host = (s: string) => s.toLowerCase().replace(/^www\./, '');
      if (host(url.hostname) !== host(location.hostname)) return null;
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length !== 1) return null;
      const h = decodeURIComponent(parts[0]!).toLowerCase();
      return !RESERVED_PATHS.has(h) && /^[a-z0-9._]{1,30}$/.test(h) ? h : null;
    } catch {
      return null;
    }
  }

  private isNavRoute(a: HTMLAnchorElement): boolean {
    try {
      const path = new URL(a.href, location.href).pathname.replace(/\/+$/, '') || '/';
      return path === '/' || path === '/explore' || path === '/reels' || path === '/direct/inbox' || path === '/accounts/activity';
    } catch {
      return false;
    }
  }

  // The app's own navigation chrome — the left rail on desktop, the bottom tab bar on mobile.
  // Found by STRUCTURE, not position: it is the tight container that holds at least two known
  // navigation routes. iPhone's compact bar does not always render both /explore/ and /reels/;
  // it may expose /, /direct/inbox/, and just one of those instead. Both layouts cluster your OWN
  // profile shortcut in here beside those routes, and
  // the person you are chatting with is never in it. That is the fact self/peer detection rides on.
  //
  // Why this replaced "<main> containment": the old split (self outside <main>, peer inside) is a
  // desktop-only geography. On mobile-web the thread header AND the nav sit outside <main>, so
  // selfHandle() grabbed the peer as "self" and peerHeaderLinks() then excluded the real peer —
  // isDirectChat() stuck at null, i.e. "identifying this chat" forever. Verified against a live
  // mobile-web DM 2026-07-13 (peer in the top bar at y=16, self in the bottom tab bar at y=618).
  private navRoot(): HTMLElement | null {
    const routes = Array.from(document.querySelectorAll<HTMLAnchorElement>(SELECTORS.profileLink))
      .filter((a) => this.isNavRoute(a))
      .filter(isVisible);
    if (routes.length < 2) return null;

    const box = this.composer();
    const candidates = new Set<HTMLElement>();
    for (const route of routes) {
      let root = route.parentElement;
      // Meta wraps every nav item in several anonymous divs. Stop at the first local ancestor
      // containing a second known route; if only the page body joins them, it contains the
      // composer and is rejected below.
      for (let depth = 0; root && depth < 16; depth++, root = root.parentElement) {
        if (box && root.contains(box)) break;
        if (routes.filter((a) => root!.contains(a)).length >= 2) {
          candidates.add(root);
          break;
        }
      }
    }
    return (
      [...candidates].sort(
        (a, b) => a.querySelectorAll(SELECTORS.profileLink).length - b.querySelectorAll(SELECTORS.profileLink).length,
      )[0] ?? null
    );
  }

  // Your OWN handle: the profile link that lives inside the nav chrome (see navRoot). Used solely
  // to exclude yourself from peer candidates — your own avatar can appear inside a thread, and
  // mistaking it for the peer would encrypt a message to yourself.
  private selfHandle(): string | null {
    const nav = this.navRoot();
    if (nav) {
      for (const a of nav.querySelectorAll<HTMLAnchorElement>(SELECTORS.profileLink)) {
        const h = this.handleOf(a);
        if (h && isVisible(a)) return h;
      }
    }
    // Do not guess when the nav cannot be proven. On iPhone both the peer header and bottom nav
    // can live outside <main>; "first profile outside main" therefore identifies the PEER as self
    // and leaves the chat unresolved. The peer candidate sorter is safe without a self value: the
    // fixed top bar is above the bottom-nav shortcut.
    return null;
  }

  // Peer candidates: profile links minus the nav chrome, minus yourself, deduped, topmost first.
  // The conversation top bar sits ABOVE the message scroller, so a @mention or a shared post's
  // author link inside a bubble can never outrank the real peer link.
  //
  // Search the document on both layouts. A mobile <main> can contain profile links from shared
  // posts while the real peer header is its sibling; preferring any main-scoped hit would silently
  // select the post author. The fixed conversation header is the topmost on-screen candidate.
  private peerHeaderLinks(): HTMLAnchorElement[] {
    const self = this.selfHandle();
    const nav = this.navRoot();
    const collect = (root: ParentNode): HTMLAnchorElement[] => {
      const seen = new Set<string>();
      const out: HTMLAnchorElement[] = [];
      const ranked = Array.from(root.querySelectorAll<HTMLAnchorElement>(SELECTORS.profileLink))
        .map((a) => ({ a, h: this.handleOf(a), rect: a.getBoundingClientRect() }))
        .filter(
          (c): c is { a: HTMLAnchorElement; h: string; rect: DOMRect } =>
            !!c.h &&
            c.h !== self &&
            isVisible(c.a) &&
            c.rect.bottom > 0 &&
            c.rect.top < window.innerHeight &&
            !(nav?.contains(c.a) ?? false),
        )
        .sort((x, y) => x.rect.top - y.rect.top || x.rect.left - y.rect.left);
      for (const c of ranked)
        if (!seen.has(c.h)) {
          seen.add(c.h);
          out.push(c.a);
        }
      return out;
    };

    return collect(document);
  }

  isDirectChat(): boolean | null {
    if (!this.providerThreadId()) return false;
    const links = this.peerHeaderLinks();
    if (links.length === 0) return null; // top bar not rendered yet, or drifted: fail VISIBLE
    const top = links[0]!.getBoundingClientRect().top;
    // A group's top bar lists its participants on the SAME row. A profile link further down
    // the pane is a bubble mention or a shared post's author, not a second participant.
    // ponytail: row test, not a participant API — retune against a real group thread.
    const sameRow = links.filter((a) => Math.abs(a.getBoundingClientRect().top - top) < 8);
    return sameRow.length === 1;
  }

  threadId(): string | null {
    return this.providerThreadId();
  }

  peerName(): string | null {
    const link = this.peerHeaderLinks()[0];
    if (!link) return null;
    // The link renders "Display Name\nhandle" (or just the handle). textContent would glue
    // those into "Display Namehandle", so read the first rendered line.
    const name = (link.innerText || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)[0];
    return name ? name.replace(/^@/, '').slice(0, 40) : this.peerHandle();
  }

  peerHandle(): string | null {
    const link = this.peerHeaderLinks()[0];
    return link ? this.handleOf(link) : null;
  }

  // The conversation column: the smallest ancestor of the composer that also holds the peer
  // link. <main> is NOT a safe root — it also contains the inbox rail, whose previews are
  // span[dir="auto"] too, so scanning main rewrites the thread LIST.
  private pane(): HTMLElement | null {
    const main = document.querySelector<HTMLElement>(SELECTORS.main);
    const box = this.composer();
    const link = this.peerHeaderLinks()[0];
    if (!box || !link) return main;
    let el: HTMLElement | null = box;
    while (el && !el.contains(link)) el = el.parentElement;
    // On mobile-web there is no <main>, so fall back to the body rather than null — the thread is
    // its own full page there (no inbox rail to accidentally rewrite, unlike desktop's two-column
    // view), so a broad scope is safe.
    return el ?? main ?? document.body;
  }

  // The DM composer is the bottom-most visible textbox inside <main> — never the first
  // role=textbox in the document, which can be a search field or story-reply box.
  private composer(): HTMLElement | null {
    const main = document.querySelector<HTMLElement>(SELECTORS.main);
    let boxes = main ? Array.from(main.querySelectorAll<HTMLElement>(SELECTORS.composer)).filter(isVisible) : [];
    // Mobile Safari can keep a semantic <main> for the message scroller while portalling the
    // composer beside it. Fall back to the document only when main has no visible editor.
    if (boxes.length === 0) boxes = Array.from(document.querySelectorAll<HTMLElement>(SELECTORS.composer)).filter(isVisible);
    return boxes.sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom).at(-1) ?? null;
  }

  // Match the send control by semantic submit type first, with English text/ARIA as the legacy
  // fallback. Search OUTWARD from the composer, never document-wide, so a "Send" in a story tray,
  // share sheet, or search overlay can never match. Non-English form submits are also caught by
  // onSend()'s submit listener even when this lookup cannot name their visible control.
  private sendButton(): HTMLElement | null {
    const box = this.composer();
    let scope: HTMLElement | null = box?.parentElement ?? null;
    for (let depth = 0; scope && depth < 8; depth++, scope = scope.parentElement) {
      const hit = Array.from(scope.querySelectorAll<HTMLElement>('div[role="button"], button, input[type="submit"]')).find(
        (b) => {
          const label = `${b.getAttribute('aria-label') ?? ''} ${b.querySelector<HTMLElement>('[aria-label]')?.getAttribute('aria-label') ?? ''}`;
          return (
            isVisible(b) &&
            !b.matches(':disabled, [aria-disabled="true"]') &&
            !b.contains(box!) &&
            (b.matches('button[type="submit"], input[type="submit"]') ||
              b.textContent?.trim() === SELECTORS.sendButtonText ||
              /(^|\s)send(\s|$)/i.test(label))
          );
        },
      );
      if (hit) return hit;
    }
    return null;
  }

  findBubbles(): HTMLElement[] {
    const root = this.pane() ?? document.body;
    const composer = this.composer();
    const candidates = Array.from(root.querySelectorAll<HTMLElement>(SELECTORS.messageText)).filter(
      (s) =>
        WIRE_MARKER.test(this.bubbleText(s)) &&
        isVisible(s) &&
        (!composer || !composer.contains(s)) &&
        !s.closest(SELECTORS.profileLink), // the top bar's own name/handle is not a message
    );
    // Some mobile builds nest a dir=auto span inside a dir=ltr div with identical text. Mutating
    // both would run decryption twice and damage the bubble; keep the deepest exact-text node.
    return candidates.filter(
      (s) => !candidates.some((child) => child !== s && s.contains(child) && this.bubbleText(child) === this.bubbleText(s)),
    );
  }

  // Preserve the original ciphertext in a data attr so pending bubbles can be retried
  // after a later handshake/unlock, and so re-renders are idempotent.
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

  private selectComposerContents(box: HTMLElement): void {
    if (box instanceof HTMLTextAreaElement) {
      box.select();
      return;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(box);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  // WebKit may reject execCommand after encryption's async background round-trip because the
  // original tap/key event no longer counts as an active user gesture. Textareas use their native
  // value setter; contenteditables retain execCommand for Lexical, with an input-event fallback.
  private setComposerTextDirect(box: HTMLElement, text: string): void {
    if (box instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(box, text);
      else box.value = text;
      box.setSelectionRange(text.length, text.length);
    } else {
      box.textContent = text;
      const range = document.createRange();
      range.selectNodeContents(box);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    box.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        composed: true,
        data: text,
        inputType: text ? 'insertText' : 'deleteContentBackward',
      }),
    );
  }

  private async replaceComposerText(box: HTMLElement, text: string, alive: () => boolean): Promise<boolean> {
    const landed = () => alive() && (text ? readComposerNode(box).includes(text) : readComposerNode(box) === '');
    box.focus();
    if (box instanceof HTMLTextAreaElement) {
      this.setComposerTextDirect(box, text);
      return until(landed, 320);
    }

    this.selectComposerContents(box);
    try {
      document.execCommand('insertText', false, text);
    } catch {
      // The direct input-event path below is the supported WebKit fallback.
    }
    if (await until(landed, 180)) return true;
    if (!alive()) return false;
    this.setComposerTextDirect(box, text);
    return until(landed, 320);
  }

  async injectAndSend(text: string): Promise<void> {
    const box = this.composer();
    if (!box) throw new Error('send-failed');
    // Every read below is pinned to THIS node. Re-resolving the composer mid-send is how
    // you get false success: Instagram remounts the box (or the user switches threads),
    // the fresh empty node reads as "cleared", and a message is silently lost.
    const readBox = () => readComposerNode(box);
    const alive = () => box.isConnected && this.composer() === box;
    const holds = () => readBox().includes(text);
    const original = readBox();
    // Confirm the token actually landed before "sending"; otherwise a synthetic Enter could send
    // the user's untouched plaintext. replaceComposerText handles both Lexical and iOS textareas.
    if (!(await this.replaceComposerText(box, text, alive))) {
      // The direct WebKit fallback may have changed the DOM before the host rejected/reverted its
      // input event. Put the original draft back whenever this exact editor is still mounted.
      if (alive()) await this.replaceComposerText(box, original, alive);
      throw new Error('send-failed');
    }
    // Primary: synthetic Enter. Fallback: click the Send button if the token is still there.
    // `holds` going false — not exact string equality, which Lexical normalization breaks —
    // is the "composer cleared" signal while the node stays live. If Instagram remounts the
    // editor, the outgoing bubble must echo the exact token before that counts as success.
    const delivered = async (ms: number) => {
      const ok = await until(
        () => (alive() && !holds()) || (!alive() && this.findBubbles().some((b) => this.bubbleText(b).includes(text))),
        ms,
      );
      // Instagram mobile commonly remounts the editor on a successful send. That is success only
      // when the exact encrypted token is already visible in an outgoing bubble; a bare remount is
      // still an ambiguous failure and must never trigger a blind retry/duplicate.
      if (!ok && !alive()) throw new Error('send-failed');
      return ok;
    };
    box.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }),
    );
    if (await delivered(1000)) return;
    this.sendButton()?.click();
    if (await delivered(1200)) return;
    // The send did NOT go through. Restore what was there before this part — into the
    // SAME node it was taken from, never whatever is focused now — then surface it
    // (a silently dropped chunk corrupts reassembly).
    await this.replaceComposerText(box, original, alive);
    throw new Error('send-failed');
  }

  onSend(hook: SendHook): void {
    const run = (e: Event, isRepeat: boolean): void => {
      let text = '';
      let intercept = false;
      try {
        text = this.readComposer();
        intercept = hook.shouldHandle(text, isRepeat); // empty, disabled, or already-ciphertext → let IG send it
      } catch {
        // Fail CLOSED: if we can't decide, suppress. A blocked plain send in an unlinked
        // chat is an annoyance; leaked plaintext in a linked one breaks the promise.
        intercept = true;
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
        // Do NOT early-return on ke.repeat: that would skip suppression and let a held-Enter
        // reach native send with plaintext still in the composer (during the encrypt await).
        // run()→shouldHandle suppresses every plaintext Enter; send()'s in-flight guard drops
        // the duplicate. Once ciphertext is in the box, shouldHandle is false and it sends.
        // ke.repeat is passed through so a repeat can FOLLOW the keypress's decision but
        // never make a fresh one (plain-once consumption is keypress-only).
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
    // iOS virtual keyboards and semantic mobile composers may submit a form without exposing a
    // recognizable English "Send" control or firing a useful keydown. Intercept the form itself.
    document.addEventListener(
      'submit',
      (e) => {
        const form = e.target as HTMLFormElement | null;
        const box = this.composer();
        if (form && box && form.contains(box)) run(e, false);
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
      headerLinks: this.peerHeaderLinks().length,
      self: this.selfHandle(),
      peer: this.peerHandle(),
      direct: this.isDirectChat(),
      bubbles: this.findBubbles().length,
      glyph: this.glyph?.visible() ?? false,
    };
  }
}

// Auto-boot only as a real content script. The browser has no Node `process`; the test runner
// does, so importing this module to exercise the adapter's DOM logic does not start the observers.
if (typeof process === 'undefined') boot(new InstagramAdapter());
