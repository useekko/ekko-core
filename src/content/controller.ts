// Platform-independent glue: watches a thread, decrypts bubbles in place, and intercepts
// sends to encrypt. Talks to the background broker via `bridge` and to the DOM via
// `adapter`, so it's fully testable with fakes for both (see test/controller.test.ts).
//
// Cardinal UX rule: Ekko is INVISIBLE in a chat you haven't encrypted. Sends are only
// intercepted when the open thread is explicitly linked to a contact — every other chat
// (including people not on Ekko) sends normal plain messages, untouched.
//
// Resilience rules (the UI must never break):
//   - every per-bubble operation is isolated in try/catch — one bad bubble never stops
//     the rest of the thread from decrypting;
//   - bubbles that fail for a recoverable reason are marked `pending` and retried;
//   - scans are debounced and non-overlapping, so DOM churn can't cause a scan storm;
//   - on any encryption failure in a linked chat the native send stays suppressed.
import { classify, classifyStandalone, decodeBody, isWireBlob, PREFIX } from '../core/wire.js';
import { splitMessage, randomChunkId, parseChunk, Reassembler } from '../core/chunk.js';
import { scopedThreadId } from '../core/thread.js';
import { inviteMessage } from '../core/growth.js';
import type { WireKind } from '../core/wire.js';
import type { SiteAdapter, Bridge, SendHook, ChatState, ChatActions } from './adapter.js';
import { errorHint } from './adapter.js';

// Recoverable ingest failures — worth retrying on a later scan. 'old-session' rides along
// not because it recovers (it can't — the channel is gone) but because its first
// classification can race the mailbox-pull debounce; a later pull re-judges it.
const RETRYABLE = new Set(['locked', 'no-vault', 'no-session', 'old-session', 'no-contact', 'unreachable']);

function sameOfferPeer(
  a: { raw: string; kind: 'invite' | 'handshake' },
  b: { raw: string; kind: 'invite' | 'handshake' },
): boolean {
  if (a.kind === b.kind) return false;
  const invite = decodeBody(a.kind === 'invite' ? a.raw : b.raw);
  const handshake = decodeBody(a.kind === 'handshake' ? a.raw : b.raw);
  // Handshake wire starts with its version byte, then the sender's public bundle.
  return invite.length > 0 && handshake.length > invite.length && invite.every((byte, i) => handshake[i + 1] === byte);
}

export class Controller {
  private reasmByThread = new Map<string, Reassembler>();
  // threadId → chunk group id → chunk index → the bubble that chunk rendered as. Lets a
  // completed group collapse down to one visible message (the first chunk's bubble)
  // instead of leaving "part i of n" placeholders sitting in the thread forever.
  private chunkElsByThread = new Map<string, Map<string, Map<number, HTMLElement>>>();
  // token → plaintext for messages already decrypted here (or sent from here — send()
  // seeds this before the token even lands in the DOM). Rendering from it is synchronous,
  // so when the platform re-mounts a bubble (optimistic send → server confirm → receipts)
  // the re-scan goes straight to the final text instead of replaying raw token →
  // "Encrypted message" → async decrypt, which the user sees as the message flickering
  // between its encrypted and readable versions. Tokens are globally unique, so one flat
  // map is safe across threads.
  private plaintexts = new Map<string, string>();
  private threadId: string | null = null;
  private scheduled = false;
  private coverScheduled = false;
  private stopped = false;
  private observer: MutationObserver | null = null;
  private scanning = false;
  private rerun = false;
  private sending = false;
  private enabled = true;
  private busy = false;
  private tagline: string | null = null;
  // Threads that have already shown "Secure channel established". The handshake is replayed
  // with every message until the peer answers (delivery reliability), so without this every
  // replay would stack another identical bubble — the receiver only needs to see it once.
  private secureShown = new Set<string>();
  // threadId → linked contact, or null if known-unlinked. Absent is unresolved and
  // fails closed: a protected chat must never race a lookup into a plaintext send.
  private linked = new Map<string, { fingerprint: string; label: string } | null>();
  // threadId → "this chat WAS linked" learned from the background's plain cache while the
  // vault is locked. A locked vault must BLOCK sends in such chats, never fall through to
  // plaintext — one silent plain message voids the whole product promise.
  private lockedLinked = new Map<string, boolean>();
  // threadId → one-click "Encrypt with X" offer: a local contact whose label matched the
  // peer name exactly (fingerprint), or a directory hit (invite — added AND bound only by
  // the explicit tap), or the chat was just turned off (re-enable offer). Only ever acted
  // on by an explicit user click.
  private suggest = new Map<
    string,
    // sessionDerived: offered because a sealed message in this chat belongs to that
    // contact's session (manual-seal landing) — identity comes from our own vault, not
    // the page header, so enableChat skips its header-name revalidation for these.
    { label: string; fingerprint?: string; invite?: string; peerHandle?: string; sessionDerived?: boolean } | null
  >();
  private resolving = new Set<string>();
  // threadId → one received token a user may explicitly accept: an invite, or a
  // first-contact handshake ("X started an encrypted chat"). null means conflicting
  // tokens appeared, so we deliberately make no key choice for them.
  private invite = new Map<string, { raw: string; kind: 'invite' | 'handshake' } | null>();
  // Armed by the glyph for ONE thread: that thread's next message rides unencrypted,
  // then protection resumes. Keyed by thread so arming chat A can never leak chat B.
  private plainOnceTid: string | null = null;
  private skipUntil = 0; // repeat-only grace window (see shouldHandle)
  private skipTid: string | null = null;

  constructor(
    private a: SiteAdapter,
    private bridge: Bridge,
  ) {}

  private candidateThreadId(): string | null {
    const providerId = this.a.threadId();
    return providerId ? scopedThreadId(this.a.platform, providerId) : null;
  }

  private activeThreadId(): string | null {
    const tid = this.candidateThreadId();
    return tid && this.a.isDirectChat() !== false ? tid : null;
  }

  private directStatus(): boolean | null {
    return this.a.isDirectChat();
  }

  // Every capped cache on this controller inserts through here: FIFO-capped so a
  // long-lived tab can never grow state without bound. Per-thread maps use the default
  // recent-chat window; the plaintext cache passes a cap sized to a long scrollback.
  private capInsert<K, V>(map: Map<K, V>, key: K, value: V, cap = 16): void {
    if (!map.has(key) && map.size >= cap) map.delete(map.keys().next().value!);
    map.set(key, value);
  }

  private reassembler(tid: string): Reassembler {
    let reasm = this.reasmByThread.get(tid);
    if (!reasm) {
      reasm = new Reassembler();
      this.capInsert(this.reasmByThread, tid, reasm);
    }
    return reasm;
  }

  private chunkEls(tid: string, groupId: string): Map<number, HTMLElement> {
    let byGroup = this.chunkElsByThread.get(tid);
    if (!byGroup) {
      byGroup = new Map();
      this.capInsert(this.chunkElsByThread, tid, byGroup);
    }
    let els = byGroup.get(groupId);
    if (!els) {
      els = new Map();
      this.capInsert(byGroup, groupId, els, 64); // mirrors Reassembler's own group cap
    }
    return els;
  }

  private rememberOffer(tid: string, raw: string, kind: 'invite' | 'handshake'): void {
    const current = this.invite.get(tid);
    if (current === undefined) {
      this.capInsert(this.invite, tid, { raw, kind });
    } else if (current && current.raw !== raw) {
      const next = { raw, kind };
      // A handshake may supersede only an invite carrying the SAME public bundle. Without
      // this check, an attacker could append their handshake after a legitimate invite and
      // become the key behind the single highlighted Accept action.
      if (sameOfferPeer(current, next)) {
        if (kind === 'handshake') this.invite.set(tid, next);
      } else {
        this.invite.set(tid, null);
      }
    }
    if (this.threadId === tid) this.updateIndicator();
  }

  private isResolved(tid: string): boolean {
    return this.linked.has(tid) || this.lockedLinked.has(tid);
  }

  // Per-site master switch (Home toggle). When off, Ekko is invisible on this site.
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    this.updateIndicator();
    if (on) this.requestScan();
  }

  // Optional tag appended to sent ciphertext (growth loop). null = off.
  setTagline(tag: string | null): void {
    this.tagline = tag;
  }

  start(): void {
    try {
      this.threadId = this.activeThreadId();
      if (this.threadId) void this.refreshLinked(this.threadId);
      this.observer = new MutationObserver(() => {
        this.requestCover(); // pre-paint: cover what the platform just (re)mounted
        this.requestScan();
      });
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      document.addEventListener('visibilitychange', () => {
        this.requestCover();
        this.requestScan();
      });
      this.a.onSend(this.sendHook());
      this.requestCover();
      this.requestScan();
    } catch {
      // Never let a failed bootstrap break the host page.
    }
  }

  // Orphan teardown (boot's context watchdog): stop observing and scheduling new work.
  // Deliberately does NOT touch the adapter's send interceptors — a chat cached as linked
  // must keep failing closed ("Ekko was updated…"), never quietly send plaintext.
  stop(): void {
    this.stopped = true;
    this.observer?.disconnect();
  }

  requestScan(): void {
    if (this.stopped || this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      void this.scan();
    }, 150);
  }

  // Pre-paint cover. MutationObserver callbacks (and the microtasks they queue) run BEFORE
  // the browser paints what the platform just (re)mounted — but the full scan above is
  // debounced 150ms, so without this pass every React re-mount painted raw ciphertext for
  // a few frames ("decrypts, encrypts, decrypts"). This pass is RENDER-ONLY and synchronous:
  // cached plaintext lands final (same one-hop semantics as the scan's known-path), any
  // other token gets the generic cover; ingest, chunks and all RPC stay in the scan.
  requestCover(): void {
    if (this.stopped || this.coverScheduled) return;
    this.coverScheduled = true;
    queueMicrotask(() => {
      this.coverScheduled = false;
      if (!this.enabled || (typeof document !== 'undefined' && document.hidden)) return; // hidden tabs don't paint; the scan catches up
      try {
        const tid = this.activeThreadId();
        for (const el of this.a.findBubbles()) {
          if (el.dataset.rsn !== undefined) continue; // already carries its real face
          const c = classifyStandalone(this.a.bubbleText(el));
          // Invites must stay raw — on conflicting offers the token itself is the escape hatch.
          if (!c || c.kind === 'invite') continue;
          if (c.kind === 'message') {
            const known = this.plaintexts.get(c.raw);
            if (known !== undefined) {
              el.dataset.rsn = 'done';
              this.a.replaceBubbleText(el, known, 'decrypted');
              continue;
            }
          }
          // rsn stays unset: the scan's first-sighting cover and ingest still own this bubble.
          const hush = c.kind === 'handshake' && tid !== null && this.secureShown.has(tid);
          this.a.replaceBubbleText(el, hush ? '' : 'Encrypted message', hush ? 'info' : 'pending');
        }
      } catch {
        /* never let a render fast-path break the page — the scan still covers everything */
      }
    });
  }

  sendHook(): SendHook {
    return {
      // Intercept when the open chat is protected: linked, OR previously linked but the
      // vault is locked (blocked, never silently plain). Unlinked/unknown → false → the
      // native plain message sends normally. A standalone protocol token means it's our own
      // re-injected ciphertext, which must pass through to native send.
      shouldHandle: (text, isRepeat) => {
        // classifyStandalone: our own re-injected token (+ optional tagline). isWireBlob:
        // a manually sealed multi-block draft (handshake + message) — the seal flow's
        // whole output is ciphertext, and it must send natively even in a chat whose
        // identity never resolved (that unrecognized chat is exactly who manual seal is for).
        if (!this.enabled || !text.trim() || classifyStandalone(text) || isWireBlob(text)) return false;
        const direct = this.directStatus();
        const tid = direct === false ? this.candidateThreadId() : this.activeThreadId();
        if (!tid) return false;
        if (direct === false) return !this.isResolved(tid) || this.isProtected(tid);
        if (this.directStatus() !== true) return true;
        // Until the background answers, block this one send. send() resolves the lookup
        // and leaves an ordinary message in the composer for a deliberate retry.
        if (!this.isResolved(tid)) return true;
        if (!this.isProtected(tid)) return false;
        if (this.plainOnceTid === tid) {
          // One-shot plain send, armed from the glyph for THIS thread only. Consumed by
          // the real keypress; its held-Enter auto-repeats follow the same choice via the
          // grace window below (a repeat never consumes or grants anything fresh).
          if (!isRepeat) {
            this.plainOnceTid = null;
            this.skipUntil = Date.now() + 800;
            this.skipTid = tid;
            this.updateIndicator();
          }
          return false;
        }
        // Repeat-only: a NEW message (paste + Enter) right after a plain-once send is
        // still intercepted and encrypted — only auto-repeats of that Enter ride along.
        if (isRepeat && this.skipTid === tid && Date.now() < this.skipUntil) return false;
        return true;
      },
      handle: (text) => this.send(text),
    };
  }

  private isProtected(tid: string): boolean {
    return this.linked.get(tid) != null || this.lockedLinked.get(tid) === true;
  }

  async scan(): Promise<void> {
    if (!this.enabled) return;
    const direct = this.directStatus();
    const candidate = this.candidateThreadId();
    const tid = direct === false ? null : candidate;
    if (!tid) {
      if (candidate && direct === false && !this.isResolved(candidate)) await this.refreshLinked(candidate);
      this.threadId = null;
      // Unconditional: a chat surface with an unresolved id (direct === null, tid null)
      // must render the "unknown" glyph even though no thread was ever active here.
      this.updateIndicator();
      return;
    }
    if (this.directStatus() !== true) {
      // Fail closed for anything stateful — except READING the thread already pinned and
      // vault-linked: decryption is gated by the binding and the session, never by the 1:1
      // heuristic, and a composer re-render can flip that heuristic mid-chat (WhatsApp)
      // after bubbles were honestly ingested. Sends stay refused in send() regardless.
      if (tid !== this.threadId || !this.linked.get(tid)) {
        this.updateIndicator();
        return;
      }
    }
    if (tid !== this.threadId) {
      this.threadId = tid;
      await this.refreshLinked(tid); // learn the new chat's encryption state before doing anything
      if (this.activeThreadId() !== tid) {
        this.requestScan();
        return;
      }
    }
    // Keep the glyph honest on every scan: threadId() going null (user left DMs for the
    // feed) or a state drift must hide/refresh it, not leave a stale "Encrypted" badge
    // floating over a comment box. setChatState is cheap when nothing changed.
    this.updateIndicator();
    // The DM header often renders after the first scan — keep offering "Encrypt with X"
    // until peerName resolves (refreshSuggestion caches, so this runs at most once per thread).
    if (this.linked.get(tid) === null && !this.suggest.has(tid)) void this.refreshSuggestion(tid);
    if (this.scanning) {
      this.rerun = true;
      return;
    }
    this.scanning = true;
    try {
      for (const el of this.a.findBubbles()) {
        try {
          // Cheap skips first: the pin re-check below forces a synchronous layout, so it
          // must not run for the (dominant) already-done and ordinary bubbles — that made
          // rescans cost one reflow per historical message for the life of the tab.
          if (el.dataset.rsn === 'done') continue;
          const text = this.a.bubbleText(el);
          const c = classifyStandalone(text);
          if (!c) {
            // Not one standalone token — but it may be a multi-block bubble: the manual
            // seal's whole output (handshake + message, or a chunk run) sent as ONE
            // message. Ingest each block in order; the message block lands last, so its
            // outcome is the bubble's final face.
            if (!isWireBlob(text)) continue; // ordinary message, leave untouched
            const parts = text.trim().split(/\s+/);
            if (parts.length < 2) continue; // single tokens flow through classifyStandalone
            if (el.dataset.rsn === undefined) this.a.replaceBubbleText(el, 'Encrypted message', 'pending');
            if (this.activeThreadId() !== tid) {
              this.requestScan();
              return;
            }
            for (const part of parts) {
              const pc = classify(part)!;
              if (pc.kind === 'chunk') await this.onChunk(el, pc.raw, tid);
              else await this.ingest(el, pc.kind, pc.raw, tid);
            }
            continue;
          }
          // Known plaintext → final render in ONE synchronous hop: no pending cover, no
          // background round-trip, no animation replay. This is what stops a re-mounted
          // bubble (and every just-sent message) from flickering back to its encrypted look.
          if (c.kind === 'message') {
            const known = this.plaintexts.get(c.raw);
            if (known !== undefined) {
              el.dataset.rsn = 'done';
              this.a.replaceBubbleText(el, known, 'decrypted');
              continue;
            }
          }
          // Cover the raw token the moment it's recognized, BEFORE the async background
          // round-trip decides its real state — otherwise every load flashes a wall of
          // base64. First sighting only: a retried bubble already shows a specific hint
          // (e.g. "unlock Ekko to read") that must not flicker back to the generic cover.
          // Invites are the one kind that must stay raw: on conflicting offers the token
          // itself is the user's escape hatch (copy the one they trust into Ekko).
          // A replayed handshake in a thread whose "secure channel" chip already showed
          // will be hushed by ingest anyway — cover it hushed too, so a re-mount doesn't
          // flash "Encrypted message" and then visibly collapse.
          if (el.dataset.rsn === undefined && c.kind !== 'invite') {
            const hush = c.kind === 'handshake' && this.secureShown.has(tid);
            this.a.replaceBubbleText(el, hush ? '' : 'Encrypted message', hush ? 'info' : 'pending');
          }
          // Pin the thread before any stateful work: navigating mid-scan must abort,
          // never ingest a bubble into the thread the user just switched to.
          if (this.activeThreadId() !== tid) {
            this.requestScan();
            return;
          }
          if (c.kind === 'chunk') await this.onChunk(el, c.raw, tid);
          else await this.ingest(el, c.kind, c.raw, tid);
        } catch {
          // Skip this bubble, keep the rest of the thread working.
        }
      }
    } finally {
      this.scanning = false;
      if (this.rerun) {
        this.rerun = false;
        this.requestScan();
      }
    }
  }

  // Ask the broker whether the current thread is linked, cache it, refresh the glyph.
  private async refreshLinked(tid: string): Promise<void> {
    let res;
    try {
      res = await this.bridge({ type: 'threadContact', threadId: tid });
    } catch {
      return;
    }
    if (res.error === 'locked') {
      // Locked: the background answers from its plain linked-thread cache, so a chat the
      // user encrypted earlier fails SAFE (sends blocked) instead of degrading to plaintext.
      // Drop any stale unlocked-era entry — the glyph must show "locked", never "on".
      this.linked.delete(tid);
      this.capInsert(this.lockedLinked, tid, !!res.wasLinked);
      if (this.threadId === tid) this.updateIndicator();
      return;
    }
    if (res.error) return; // unreachable → remain unresolved and fail closed
    this.lockedLinked.delete(tid);
    this.capInsert(this.linked, tid, res.contact ? { fingerprint: res.contact.fingerprint, label: res.contact.label } : null);
    if (!res.contact) void this.refreshSuggestion(tid);
    if (this.threadId === tid) this.updateIndicator();
  }

  // One-time per thread: if the DM header's peer name matches exactly one contact, the
  // glyph offers one-click "Encrypt with X". No local match → ask the directory whether
  // this peer is on Ekko (the background gates that lookup on the auto-discovery setting
  // and persists nothing). The name is DOM-scraped and untrusted, so either path only
  // ever produces an OFFER — binding happens on the user's explicit click.
  private async refreshSuggestion(tid: string): Promise<void> {
    if (this.directStatus() !== true) return;
    if (this.suggest.has(tid) || this.resolving.has(tid)) {
      this.updateIndicator();
      return;
    }
    const display = this.a.peerName();
    const peer = display?.toLowerCase().replace(/^@/, '');
    if (!display || !peer) return; // header not rendered yet — retried from scan()
    this.resolving.add(tid);
    try {
      const res = await this.bridge({ type: 'contacts' });
      if (res.error || !res.contacts) return;
      // SPA guard: the URL flips before the header re-renders, so re-check that we're
      // still on the same thread AND the header still shows the same name — otherwise a
      // stale header could cache the WRONG contact as this thread's suggestion.
      if (this.activeThreadId() !== tid || this.a.peerName()?.toLowerCase().replace(/^@/, '') !== peer) return;

      const handle = this.a.peerHandle();

      // Strongest signal first: this chat's @handle is a linked social of a known contact — learned
      // from your account connections (their account_handles came down with the sync). A handle is a
      // stable account identifier; a display name is not. So this binds @kirusha to your existing
      // Kirill instead of the directory minting a look-alike, and it needs no directory lookup and
      // no discovery setting — it is a local, exact match against people you already connected with.
      // Unlike the name/directory paths below (offers only), this one binds AUTOMATICALLY: the
      // handle rode in through an accepted account connection, which is the consent moment. The
      // background still refuses if the user explicitly turned this chat off, or it's already bound.
      const wantHandle = handle?.toLowerCase().replace(/^@/, '');
      // A linked PHONE is the same class of signal as the handle: the platform exposes a
      // mutual contact's number (Telegram), and a phone linked on the account — their
      // WhatsApp handle, or a phone typed into another platform's field — names the same
      // person. Matched digits-for-digits against phone-shaped linked handles ONLY, never
      // against ids that merely contain digits (a Messenger user id is not a phone).
      const wantPhone = this.a.peerPhone?.() ?? null;
      const phonesOf = (c: { handles?: Record<string, string> }): string[] =>
        [c.handles?.['whatsapp'], c.handles?.[this.a.platform]].filter((h): h is string => !!h && /^\d{6,15}$/.test(h));
      if (wantHandle || wantPhone) {
        const byHandle = res.contacts.filter(
          (c) =>
            (!!wantHandle && (c.handles?.[this.a.platform] ?? '').toLowerCase().replace(/^@/, '') === wantHandle) ||
            (!!wantPhone && phonesOf(c).includes(wantPhone)),
        );
        if (byHandle.length === 1) {
          const match = byHandle[0]!;
          // Bind-time re-check, mirroring enableChat: a fast chat switch must never bind
          // the new thread to the previous chat's person.
          if (
            this.activeThreadId() !== tid ||
            this.a.peerHandle()?.toLowerCase().replace(/^@/, '') !== wantHandle ||
            (this.a.peerPhone?.() ?? null) !== wantPhone
          )
            return;
          const bound = await this.bridge({ type: 'bindThread', threadId: tid, fingerprint: match.fingerprint, auto: true });
          if (!bound.error) {
            this.retryPending(); // resolve the binding, re-ingest pending bubbles, refresh the glyph
            return;
          }
          // Opted out, locked, or unreachable: degrade to the one-click offer. Carry the
          // handle the match was made on — enableChat revalidates by it; the contact label
          // (their Ekko @handle) has no reason to equal this page's display name.
          this.capInsert(this.suggest, tid, { fingerprint: match.fingerprint, label: match.label, peerHandle: handle ?? undefined });
          this.updateIndicator();
          return;
        }
      }

      const hits = res.contacts.filter((c) => c.label.toLowerCase().replace(/^@/, '') === peer);
      if (hits.length > 0) {
        this.capInsert(
          this.suggest,
          tid,
          hits.length === 1 ? { fingerprint: hits[0]!.fingerprint, label: hits[0]!.label } : null,
        );
        this.updateIndicator();
        return;
      }
      if (!handle) return; // display names are not account identifiers; never guess
      const dir = await this.bridge({ type: 'resolvePeer', platform: this.a.platform, handle });
      if (
        this.activeThreadId() !== tid ||
        this.a.peerName()?.toLowerCase().replace(/^@/, '') !== peer ||
        this.a.peerHandle() !== handle
      )
        return;
      if (dir.invite) this.capInsert(this.suggest, tid, { label: display, invite: dir.invite, peerHandle: handle });
      else if (dir.error === 'not-found' || dir.error === 'unverified-handle' || dir.error === 'discovery-off')
        this.capInsert(this.suggest, tid, null);
      // Transient failures stay uncached so a later scan can retry.
      this.updateIndicator();
    } finally {
      this.resolving.delete(tid);
    }
  }

  private chatState(): ChatState {
    if (!this.enabled) return { kind: 'hidden' };
    const tid = this.activeThreadId();
    // No thread id: hidden ONLY when the adapter is sure there's no 1:1 chat here (feed,
    // inbox, confirmed group). isDirectChat()===null with no id means a chat surface IS
    // open but its identity didn't resolve (empty new chat, drifted id selector) — that
    // must fail visible too, or WhatsApp/Telegram drift renders no blob at all while
    // Instagram (URL-derived id) gets one.
    if (!tid) return this.directStatus() === null ? { kind: 'unknown' } : { kind: 'hidden' };
    if (this.busy) return { kind: 'busy' };
    // Fail VISIBLE, not hidden: a thread is open but we can't yet confirm it's a 1:1 chat
    // (or the background hasn't answered its link state). Sends are already paused on this
    // path — the glyph must say so instead of silently not existing, which reads as
    // "extension broken" and gives live selector-tuning nothing to look at.
    if (this.directStatus() !== true) {
      // Manual-seal landing on a surface that won't confirm: the vault may already hold the
      // session that sealed these bubbles. That offer is the vault's own record, not a page
      // guess, so it may surface here — otherwise the bubbles' "click the Ekko button to
      // read" hint points at a button this state never renders.
      const sug = this.linked.get(tid) ? undefined : this.suggest.get(tid);
      return { kind: 'unknown', suggestLabel: sug?.sessionDerived ? sug.label : undefined };
    }
    const link = this.linked.get(tid);
    if (link) return { kind: 'on', label: link.label, plainOnce: this.plainOnceTid === tid || undefined };
    if (this.lockedLinked.get(tid)) return { kind: 'locked' };
    if (!this.isResolved(tid)) return { kind: 'unknown' };
    const offer = this.invite.get(tid);
    const sug = offer === undefined ? this.suggest.get(tid) : undefined;
    return {
      kind: 'off',
      invite: offer === undefined ? undefined : offer ? 'ready' : 'ambiguous',
      inviteKind: offer?.kind,
      peer: offer?.kind === 'handshake' ? (this.a.peerName() ?? undefined) : undefined,
      suggestLabel: sug?.label,
      onEkko: sug?.invite ? true : undefined,
    };
  }

  private actions: ChatActions = {
    enable: () => void this.enableChat(),
    acceptInvite: () => void this.acceptInvite(),
    disable: () => void this.disableChat(this.activeThreadId()),
    unlock: () => void this.requestUnlock(),
    plainOnce: (on) => {
      this.plainOnceTid = on ? this.activeThreadId() : null;
      this.updateIndicator();
    },
    retry: () => this.retryPending(),
    invitePeer: () => void this.copyInvitePitch(),
  };

  // "Copy an invite to send them": the pitch lands on the clipboard (never auto-sent — the
  // user pastes and presses send themselves) and carries the @handle when one exists. A
  // locked vault still yields the generic pitch: growth must not require an unlock first.
  private async copyInvitePitch(): Promise<void> {
    const who = await this.bridge({ type: 'invite' });
    const text = inviteMessage(who.username);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API can be denied on some host pages; the selection fallback still works.
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    this.a.notify('Invite copied — paste it into this chat and send it.');
  }

  // Debug overlay only: the glyph state the controller last computed, by name.
  debugState(): string {
    return this.chatState().kind;
  }

  // The popup surfaces recognition too: the suggested EXISTING contact for a thread, if a
  // scan matched one (linked handle or exact name). Directory offers (invite, no
  // fingerprint) stay glyph-only — the popup's Link flow only binds known contacts.
  suggestionFor(tid: string): { fingerprint: string; label: string } | null {
    const s = this.suggest.get(tid);
    return s?.fingerprint ? { fingerprint: s.fingerprint, label: s.label } : null;
  }

  private updateIndicator(): void {
    this.a.setChatState(this.chatState(), this.actions);
  }

  // Glyph "Encrypt with X" — bind the open thread to the suggested/previous contact, or
  // (directory-resolved offer) add+bind the peer in one explicit background transaction.
  private async enableChat(): Promise<void> {
    const tid = this.activeThreadId();
    const s = tid ? this.suggest.get(tid) : null;
    if (!tid || !s) return;
    // A session-derived offer may bind before the 1:1 confirms: it only unblocks READING
    // bubbles whose session the vault already holds — send() independently refuses while
    // the surface is unconfirmed, so nothing can be encrypted to a guessed recipient.
    if (this.directStatus() !== true && !s.sessionDerived) return;
    // Re-validate at click time: if the header no longer shows the suggested name (fast
    // thread switch), binding would encrypt this thread to the WRONG person. Refuse.
    // Session-derived offers skip this: their identity is the vault's own session record,
    // and the contact's Ekko label has no reason to match this page's display name.
    const changed = s.sessionDerived
      ? false
      : s.peerHandle
        ? this.a.peerHandle() !== s.peerHandle
        : this.a.peerName()?.toLowerCase().replace(/^@/, '') !== s.label.toLowerCase().replace(/^@/, '');
    if (changed) {
      this.suggest.delete(tid);
      this.updateIndicator();
      this.a.notify('This chat changed — reopen it and try again.');
      return;
    }
    if (s.invite) {
      // Same audited add+bind path as accepting a received invite. The directory key is TOFU.
      const res = await this.bridge({ type: 'acceptInvite', threadId: tid, invite: s.invite, label: s.label });
      if (res.error || !res.contact) {
        if (res.error === 'already-linked') void this.refreshLinked(tid);
        this.a.notify(res.error === 'already-linked' ? 'This chat was linked elsewhere. Refreshing its Ekko status.' : errorHint(res.error));
        return;
      }
      this.capInsert(this.linked, tid, { fingerprint: res.contact.fingerprint, label: res.contact.label });
      this.updateIndicator();
      this.a.notify(`Messages here are now encrypted for ${res.contact.label}.`);
      this.requestScan();
      return;
    }
    const res = await this.bridge({ type: 'bindThread', threadId: tid, fingerprint: s.fingerprint! });
    if (res.error) {
      this.a.notify(errorHint(res.error));
      return;
    }
    this.capInsert(this.linked, tid, { fingerprint: s.fingerprint!, label: s.label });
    this.updateIndicator();
    this.a.notify(`Messages here are now encrypted for ${s.label}.`);
    this.requestScan();
  }

  // Explicitly accept the one token seen in this direct chat (invite or first-contact
  // handshake). The background parses, stores, and binds it atomically; received wire
  // text alone never invokes this path.
  private async acceptInvite(): Promise<void> {
    const tid = this.activeThreadId();
    const offer = tid ? this.invite.get(tid) : undefined;
    if (!tid || !offer || this.directStatus() !== true) return;
    this.busy = true;
    this.updateIndicator();
    try {
      const res = await this.bridge({ type: 'acceptInvite', threadId: tid, invite: offer.raw, label: this.a.peerName() ?? undefined });
      if (this.activeThreadId() !== tid) return;
      if (res.error || !res.contact) {
        if (res.error === 'already-linked') void this.refreshLinked(tid);
        if (res.error === 'thats-you' || res.error === 'bad-invite') this.invite.delete(tid);
        this.a.notify(
          res.error === 'already-linked'
            ? 'This chat was linked elsewhere. Refreshing its Ekko status.'
            : res.error === 'thats-you'
              ? 'That is your own invite, so it can’t be linked here.'
              : errorHint(res.error),
        );
        return;
      }
      this.invite.delete(tid);
      this.suggest.delete(tid);
      this.lockedLinked.delete(tid);
      this.capInsert(this.linked, tid, { fingerprint: res.contact.fingerprint, label: res.contact.label });
      this.a.notify(`This chat is now encrypted for ${res.contact.label}.`);
      this.requestScan();
    } catch {
      this.a.notify(errorHint('unreachable'));
    } finally {
      this.busy = false;
      this.updateIndicator();
    }
  }

  // In-page "turn off encryption for this chat" — explicit unlinking is sticky because
  // inbound protocol data never binds a thread on its own.
  private async disableChat(tid: string | null): Promise<void> {
    if (!tid) return;
    const res = await this.bridge({ type: 'unbindThread', threadId: tid });
    if (res.error) {
      // Do NOT pretend it worked — a silent failure here means encryption quietly stays on.
      this.a.notify(errorHint(res.error));
      return;
    }
    const prev = this.linked.get(tid);
    // One-click re-enable offer. Same rule as the degraded auto-bind offer: carry the live
    // handle for enableChat's revalidation — the label is their Ekko name, not this page's.
    if (prev) this.capInsert(this.suggest, tid, { ...prev, peerHandle: this.a.peerHandle() ?? undefined });
    this.capInsert(this.linked, tid, null);
    this.updateIndicator();
  }

  private async requestUnlock(): Promise<void> {
    const res = await this.bridge({ type: 'openPopup' });
    if (res.error) this.a.notify('Click the Ekko icon in your browser toolbar to unlock.');
  }

  private async onChunk(el: HTMLElement, raw: string, tid: string): Promise<void> {
    if (this.activeThreadId() !== tid) return;
    el.dataset.rsn = 'done';
    const part = parseChunk(raw);
    if (part) this.chunkEls(tid, part.id).set(part.index, el);
    this.a.replaceBubbleText(
      el,
      part ? `Encrypted message (part ${part.index + 1} of ${part.total})` : 'Encrypted message part',
      'info',
    );
    const whole = this.reassembler(tid).add(raw);
    if (!whole) return;
    const c = classify(whole);
    if (!c || c.kind === 'chunk') return;

    // The group just completed: collapse every "part i of n" placeholder down to the
    // first chunk's bubble so the reader sees one message, not N of them.
    let anchor = el;
    if (part) {
      const group = this.chunkElsByThread.get(tid)?.get(part.id);
      anchor = group?.get(0) ?? el;
      if (group) {
        for (const gel of group.values()) if (gel !== anchor) this.a.replaceBubbleText(gel, '', 'info'); // hush
        this.chunkElsByThread.get(tid)?.delete(part.id);
      }
    }
    anchor.dataset.rsnSrc = whole;
    await this.ingest(anchor, c.kind, c.raw, tid);
  }

  private async ingest(el: HTMLElement, kind: WireKind, raw: string, tid: string): Promise<void> {
    const peerLabel = kind === 'message' ? undefined : (this.a.peerName() ?? undefined);
    const res = await this.bridge({ type: 'ingest', threadId: tid, kind, raw, peerLabel });
    if (this.activeThreadId() !== tid) return;

    // A token in an unlinked chat is untrusted data, not an authorization to create a
    // contact — it becomes an OFFER the user may explicitly accept from the glyph.
    if (kind === 'invite' && res.error === 'no-contact') {
      this.rememberOffer(tid, raw, 'invite');
      el.dataset.rsn = 'done';
      // One actionable invite renders as a card; on conflicting offers leave the raw
      // token visible so the user can still copy the one they trust into Ekko.
      if (this.invite.get(tid)) this.a.replaceBubbleText(el, this.offerCard('invite'), 'info');
      return;
    }
    if (kind === 'handshake' && res.error === 'no-contact') {
      // First contact in an unlinked chat: an actionable moment, not a dead pending blob.
      // dataset stays `pending` so the normal retry path re-ingests it the instant this
      // chat links (glyph accept OR popup), storing the session either way.
      this.rememberOffer(tid, raw, 'handshake');
      el.dataset.rsn = 'pending';
      const actionable = !!this.invite.get(tid);
      this.a.replaceBubbleText(el, actionable ? this.offerCard('handshake') : this.pendingHint(res.error), actionable ? 'info' : 'pending');
      return;
    }

    if (kind === 'message') {
      if (res.plaintext !== undefined) {
        el.dataset.rsn = 'done';
        this.capInsert(this.plaintexts, raw, res.plaintext, 256);
        this.a.replaceBubbleText(el, res.plaintext, 'decrypted');
      } else if (res.error && RETRYABLE.has(res.error)) {
        // Unlinked chat, but the vault knows whose session sealed this (manual-seal
        // landing): surface the one-tap "Encrypt with X" offer instead of dead-ending.
        // Explicit tap only, as ever — the bubble alone binds nothing.
        if (res.error === 'no-contact' && res.contact) {
          this.capInsert(this.suggest, tid, {
            fingerprint: res.contact.fingerprint,
            label: res.contact.label,
            sessionDerived: true,
          });
          this.updateIndicator();
        }
        el.dataset.rsn = 'pending';
        this.a.replaceBubbleText(el, this.pendingHint(res.error, res.contact?.label), 'pending');
      } else {
        el.dataset.rsn = 'done';
        this.a.replaceBubbleText(el, 'This message couldn’t be decrypted', 'error');
      }
      return;
    }

    if (res.error && RETRYABLE.has(res.error)) {
      el.dataset.rsn = 'pending';
      this.a.replaceBubbleText(el, this.pendingHint(res.error), 'pending');
      return;
    }

    el.dataset.rsn = 'done';
    if (res.keyChanged) {
      this.a.replaceBubbleText(el, 'This contact’s key changed — make sure it’s really them', 'error');
      return;
    }
    if (kind === 'handshake') {
      if (res.error) {
        this.a.replaceBubbleText(el, 'Secure-channel setup', 'info');
      } else if (this.secureShown.has(tid)) {
        // A replayed handshake — hush it, already confirmed. And ONLY hush: re-resolving
        // here would loop, because a multi-block bubble whose message part is still
        // pending re-ingests this replay on every retry pass.
        this.a.replaceBubbleText(el, '', 'info');
      } else {
        this.secureShown.add(tid);
        this.a.replaceBubbleText(el, 'Secure channel established', 'info');
        void this.refreshLinked(tid);
        this.retryPending();
      }
    } else {
      this.a.replaceBubbleText(el, res.error ? 'Ekko key message' : 'Contact key received', 'info');
      if (res.added) this.retryPending(); // refresh the explicit "Encrypt with X" offer
    }
  }

  // Card copy for a received offer. Names the sender when the header gives one — the
  // name is display-only; the key it points at is still gated by the explicit accept.
  private offerCard(kind: 'invite' | 'handshake'): string {
    const who = this.a.peerName() ?? 'This person';
    return kind === 'handshake'
      ? `${who} wants to chat privately — click the Ekko button by the message box to accept`
      : `${who} sent their Ekko key — click the Ekko button by the message box to accept`;
  }

  private pendingHint(error: string, contactLabel?: string): string {
    if (error === 'locked' || error === 'no-vault') return 'Encrypted — unlock Ekko to read';
    if (error === 'unreachable') return 'Encrypted — reload the page to read';
    if (error === 'no-contact') {
      // We know the exact contact whose key sealed this — point at the one-tap link.
      if (contactLabel) return `Encrypted with ${contactLabel} — click the Ekko button by the message box to read`;
      const who = this.a.peerName();
      return who ? `Encrypted — set up Ekko with ${who} to read` : 'Encrypted — link this chat in Ekko to read';
    }
    // Honest, not hopeful: this was sealed under a secure channel this device never held
    // (the sender re-staged since; sessions never leave devices). Waiting won't fix it.
    if (error === 'old-session') return 'Sealed under an older secure channel — this device can’t read it';
    return 'Encrypted — waiting for the secure channel';
  }

  // Public: the popup broadcasts a rescan after link/unlink/unlock so the page reflects it
  // without a reload.
  retryPending(): void {
    const tid = this.activeThreadId();
    if (!tid) return;
    this.threadId = tid;
    this.linked.delete(tid);
    this.lockedLinked.delete(tid);
    this.suggest.delete(tid); // contacts may have changed — re-offer "Encrypt with X"
    void this.refreshLinked(tid);
    for (const el of this.a.findBubbles()) {
      if (el.dataset.rsn === 'pending') delete el.dataset.rsn;
    }
    this.requestScan();
  }

  private async send(text: string): Promise<void> {
    if (this.sending) {
      // A distinct second message during an in-flight send must not vanish silently.
      // (A held-Enter duplicate is suppressed upstream and lands here too — the toast
      // is honest for both.)
      this.a.notify('Still sending the previous message — try again in a second.');
      return;
    }
    const direct = this.directStatus();
    const threadId = direct === false ? this.candidateThreadId() : this.activeThreadId();
    if (!threadId) {
      this.a.notify(errorHint('no-thread'));
      return;
    }
    this.sending = true;
    this.busy = true;
    this.updateIndicator();
    let sent = 0;
    let total = 0;
    try {
      if (direct === false) {
        if (!this.isResolved(threadId)) await this.refreshLinked(threadId);
        if (!this.isResolved(threadId)) {
          this.a.notify('Ekko couldn’t check this chat. Reload the page before sending.');
        } else if (this.isProtected(threadId)) {
          this.a.notify('Groups and channels are not supported by Ekko. Nothing was sent.');
        } else {
          this.a.notify('This group is not linked to Ekko. Press Send again to send normally.');
        }
        return;
      }
      if (direct !== true) {
        this.a.notify('Ekko is still identifying this conversation. Wait for the header to load before sending.');
        return;
      }
      if (!this.isResolved(threadId)) {
        await this.refreshLinked(threadId);
        if (this.activeThreadId() !== threadId) throw new Error('thread-changed');
        if (!this.isResolved(threadId)) {
          this.a.notify('Ekko couldn’t check this chat. Reload the page before sending.');
          return;
        }
        if (!this.isProtected(threadId)) {
          // Keep the original text in the composer. A plain chat is safe to send normally,
          // but the user must press Send again after this one-time protection check.
          this.a.notify('This chat is not linked to Ekko. Press Send again to send normally.');
          return;
        }
      }
      const res = await this.bridge({ type: 'encrypt', threadId, plaintext: text });
      if (res.error || !res.tokens) {
        this.a.notify(errorHint(res.error));
        return;
      }
      // We KNOW this token's plaintext — seed the cache before the message even lands in
      // the DOM, so our own sent bubble renders readable on first sight instead of
      // raw token → "Encrypted message" → decrypt round-trip. (Chunked sends still go
      // through reassembly; only whole message tokens ever appear verbatim in a bubble.)
      for (const t of res.tokens) if (t.startsWith(PREFIX.message)) this.capInsert(this.plaintexts, t, text, 256);
      const parts = res.tokens.flatMap((t) => splitMessage(t, this.a.maxMessageLen, randomChunkId()));
      // Append the tag to the final part ONLY when it's a whole message token (never a
      // chunk) and only if it still fits the length cap.
      const last = parts.length - 1;
      if (this.tagline && last >= 0 && parts[last]!.startsWith(PREFIX.message) && parts[last]!.length + this.tagline.length <= this.a.maxMessageLen) {
        parts[last] += this.tagline;
      }
      total = parts.length;
      for (const part of parts) {
        // Pin the thread across a multi-part send: navigating away mid-sequence must
        // abort, never inject the remaining chunks into whatever chat is now open.
        if (this.activeThreadId() !== threadId) throw new Error('thread-changed');
        await this.a.injectAndSend(part); // throws 'send-failed' if the box wasn't cleared
        sent++;
      }
    } catch (e) {
      const code = (e as Error)?.message;
      if (sent > 0) {
        // Be honest about partial failure — "nothing was sent" would be a lie here, and a
        // silent partial corrupts reassembly on the other side.
        this.a.notify(`Sending was interrupted — ${sent} of ${total} parts went out. Go back to the chat and send the message again.`);
      } else {
        const known = code === 'send-failed' || code === 'thread-changed' || code === 'message-too-long';
        this.a.notify(errorHint(known ? code : 'unreachable'));
      }
    } finally {
      this.sending = false;
      this.busy = false;
      this.updateIndicator();
    }
  }
}
