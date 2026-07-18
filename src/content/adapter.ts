// A SiteAdapter teaches the platform-independent Controller how to read/write ONE
// messenger's web UI. Add a messenger = add an adapter; the Controller never changes.
import type { Req, Res } from '../core/rpc.js';

// How a handled bubble should read to the user. The adapter renders each status with a
// small icon next to the text — no emoji overlays.
//   decrypted — plaintext shown, secured end-to-end
//   pending   — encrypted, expected to become readable (unlock / handshake / reload)
//   error     — permanently unreadable (tamper, bad token)
//   info      — protocol bubbles (handshake, key exchange), not user content
export type BubbleStatus = 'decrypted' | 'pending' | 'error' | 'info';

export interface SendHook {
  // Sync decision made at the instant the user hits send — must not be async.
  // isRepeat: this event is a held-key auto-repeat (KeyboardEvent.repeat) — such events
  // must follow the SAME decision as the keypress that started them, never a fresh one.
  shouldHandle(text: string, isRepeat?: boolean): boolean;
  // Async: clear the composer and inject the encrypted token(s).
  handle(text: string): Promise<void>;
}

// What the composer glyph shows for the OPEN chat. Computed by the Controller, rendered
// by the adapter (a small anchored button inside the message box, Grammarly-style).
//   hidden — no thread open, or Ekko is off for this site
//   off    — plain chat; suggestLabel offers one-click "Encrypt with X" when the thread's
//            peer name matches exactly one contact (onEkko marks a directory-resolved
//            match: the peer isn't a saved contact yet, the tap adds+binds them).
//            invite offers an explicit accept action for a single token actually received
//            in this direct chat; inviteKind says whether it was an invite or a
//            first-contact handshake, peer names the sender for the handshake copy.
//   on     — encrypted with `label`; plainOnce = the NEXT message rides unencrypted
//   locked — this chat encrypts, but the vault is locked: sends are BLOCKED, never plain
//   busy   — encrypting/injecting right now
//   unknown — a thread is open but Ekko can't yet confirm it's a 1:1 chat (or its link
//             state): page still rendering, selectors drifted, or background unreachable.
//             Sends stay paused. Fail-VISIBLE: the glyph must show this, never vanish —
//             an invisible blob on a broken selector is indistinguishable from "not
//             installed" and cost us a live-debugging session.
export type ChatState =
  | { kind: 'hidden' }
  // suggestLabel: a SESSION-DERIVED offer only — the vault already holds the session that
  // sealed this chat's bubbles, so the one-tap link may show before the 1:1 is confirmed.
  // Reading is all it unblocks; sends stay paused until the surface resolves.
  | { kind: 'unknown'; suggestLabel?: string }
  | {
      kind: 'off';
      suggestLabel?: string;
      onEkko?: boolean;
      invite?: 'ready' | 'ambiguous';
      inviteKind?: 'invite' | 'handshake';
      peer?: string;
    }
  | { kind: 'on'; label: string; plainOnce?: boolean }
  | { kind: 'locked' }
  | { kind: 'busy' };

// The glyph's actions, wired back into the Controller.
export interface ChatActions {
  enable(): void; // bind the open thread to the suggested/previous contact
  acceptInvite(): void; // explicitly add+bind the one received invite
  disable(): void; // explicitly unbind the open chat
  unlock(): void; // ask the background to open the popup for unlock
  plainOnce(on: boolean): void; // arm/cancel "send next message unencrypted"
  retry(): void; // re-resolve the open chat (unknown state's "Check again")
  invitePeer(): void; // copy the bring-a-friend pitch for the person in this chat
}

export interface SiteAdapter {
  readonly platform: string; // lowercase id, e.g. 'instagram' — used for storage scoping
  readonly platformLabel: string; // human name, e.g. 'Instagram' — used in user-facing copy
  readonly maxMessageLen: number;
  // true = direct chat, false = confirmed group/channel, null = UI still resolving.
  // Unknown must fail closed so a re-render cannot turn a protected chat transparent.
  isDirectChat(): boolean | null;
  // Provider-local conversation ID. The Controller namespaces it with `platform` before
  // it reaches persistent storage; a confirmed group is never offered encryption.
  threadId(): string | null;
  // Display name of the person this thread is with, from the page UI. Best-effort,
  // untrusted — used only to label auto-added contacts.
  peerName(): string | null;
  // Provider account identifier used for directory lookup (Instagram username,
  // WhatsApp phone/JID, Telegram username). Never substitute a display name.
  peerHandle(): string | null;
  // The peer's phone number as bare digits, when the platform exposes one that is NOT
  // already the handle (Telegram shows a mutual contact's phone; WhatsApp's handle IS the
  // phone). Used to auto-match a contact whose account linked a phone instead of the
  // platform's username. Optional: most adapters have nothing to add.
  peerPhone?(): string | null;
  findBubbles(): HTMLElement[];
  bubbleText(el: HTMLElement): string;
  // Replace a bubble's rendered text in place, with a status icon. Must be idempotent —
  // the Controller marks handled bubbles via dataset.
  replaceBubbleText(el: HTMLElement, text: string, status: BubbleStatus): void;
  injectAndSend(text: string): Promise<void>;
  onSend(hook: SendHook): void;
  notify(message: string): void; // transient toast near the composer
  // Render the composer glyph for the open chat. Called whenever the state changes;
  // must be idempotent.
  setChatState(state: ChatState, actions: ChatActions): void;
  // Selector self-report for the debug overlay (rsn.debug): which platform selectors
  // currently hit. Read-only, cheap, and only ever called while the overlay is on.
  debugProbe?(): Record<string, unknown>;
  // Orphan teardown (boot's context watchdog): remove injected UI and stop its timers.
  // Send interceptors deliberately stay — see the watchdog comment in boot.ts.
  destroy?(): void;
}

export type Bridge = (req: Req) => Promise<Res>;

export function errorHint(code: string | undefined): string {
  switch (code) {
    case 'locked':
    case 'no-vault':
      return 'Ekko is locked. Click the Ekko icon in your toolbar to unlock, then send again.';
    case 'no-contact':
      return 'This chat isn’t linked to an Ekko contact yet. Open Ekko from your toolbar to link one.';
    case 'unreachable':
      return 'Ekko was updated or restarted. Reload this page to reconnect.';
    case 'no-thread':
      return 'Open the conversation from your inbox so Ekko can identify this chat.';
    case 'send-failed':
      return 'Ekko couldn’t place the encrypted message in the box. Nothing was sent — try again.';
    case 'thread-changed':
      return 'You switched chats before the message went out — nothing was sent. Go back and try again.';
    case 'message-too-long':
      return 'That message is too long to encrypt in one go — nothing was sent. Split it up and send it in parts.';
    default:
      return `Ekko couldn’t encrypt this message${code ? ` (${code})` : ''} — it was not sent.`;
  }
}
