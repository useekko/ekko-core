// Message contract shared by background (handler), content script, and popup (callers).
// Private keys never cross this boundary — callers send plaintext/ciphertext, the
// background holds keys and does all crypto.
import type { WireKind } from './wire.js';

export type VaultState = 'no-vault' | 'locked' | 'unlocked';

export interface ContactView {
  fingerprint: string; // hex, id for RPC
  label: string;
  verified: boolean;
  safetyNumber: string;
  fingerprintHex: string;
  // Linked messenger handles (platform -> handle) for this contact, so a content script can match
  // the open chat's @handle to the right contact. Stays in the isolated world; never on the page.
  handles?: Record<string, string>;
}

export type Req =
  | { type: 'status' }
  | { type: 'create'; passphrase: string; username?: string; adopt?: boolean } // adopt=true KEEPS a signed-in account and republishes onto it (reset); default clears any stale session
  // keepUnlocked (when present) records the unlock screen's "keep me unlocked on this
  // device" choice — applied only after the passphrase proves right.
  | { type: 'unlock'; passphrase: string; keepUnlocked?: boolean }
  | { type: 'lock' }
  // Persist the derived master key in storage.local so a browser restart doesn't lock
  // Ekko (and stall linked chats) — the Signal-Desktop posture: the OS login is the lock.
  // Off (the default) keeps today's behavior: session-only, passphrase per browser start.
  | { type: 'setKeepUnlocked'; enabled: boolean }
  | { type: 'invite' }
  | { type: 'addContact'; invite: string; label?: string }
  // Explicit in-page action: validate an invite and bind this direct thread in one
  // background transaction. Inbound protocol data alone never reaches this request.
  | { type: 'acceptInvite'; threadId: string; invite: string; label?: string }
  | { type: 'contacts' }
  | { type: 'verifyContact'; fingerprint: string }
  | { type: 'renameContact'; fingerprint: string; label: string }
  | { type: 'removeContact'; fingerprint: string }
  // `auto` marks recognition (chat @handle ↔ a contact's account-linked social) rather than a
  // user click: it never overrides an existing binding or an explicit opt-out (tombstone).
  | { type: 'bindThread'; threadId: string; fingerprint: string; auto?: boolean }
  | { type: 'unbindThread'; threadId: string }
  | { type: 'threadContact'; threadId: string }
  | { type: 'getSettings' }
  | { type: 'setSite'; platform: string; enabled: boolean }
  | { type: 'setTagline'; enabled: boolean }
  | { type: 'dirClaim'; username: string } // publish my key + claim @username in the directory
  // Look a @username up and report who it is — WITHOUT adding them. The popup shows the answer
  // (handle + their security code) and only then offers to add, so nobody adopts a key they have
  // not looked at. Persists nothing; dirAdd is still the one audited write.
  | { type: 'dirLookup'; username: string }
  | { type: 'dirAdd'; username: string } // look a @username up in the directory and add them
  // Auto-detect: is the person behind this platform handle on Ekko? On-device hashed directory
  // lookup, gated by the auto-discovery setting. Persists NOTHING — it returns their
  // invite as an OFFER; only an explicit user tap (acceptInvite) adds and binds.
  | { type: 'resolvePeer'; platform: string; handle: string }
  // Manually set a CONTACT's messenger handles (platform -> handle). This is how an
  // off-grid (invite/QR) contact gets chat recognition; for account connections the
  // peer's own linked socials keep merging over same-platform entries on sync.
  | { type: 'setContactHandles'; fingerprint: string; handles: Record<string, string> }
  | { type: 'setDiscover'; enabled: boolean } // auto-discovery lookups on/off (default off)
  // Point this install at a different (self-hosted) directory. https-only; empty string
  // resets to the default. The directory is discovery, never a root of trust — but it does
  // see lookup metadata, which is exactly why self-hosting it is supported.
  | { type: 'setDirectory'; url: string }
  | { type: 'openPopup' } // content script asks the browser to open the toolbar popup (unlock)
  // Is a newer release out? Answered from a day-cached anonymous read of the public GitHub
  // releases list — the popup shows a quiet notice for installs with no store auto-update.
  | { type: 'updateCheck' }
  | { type: 'changePassphrase'; oldPassphrase: string; newPassphrase: string }
  | { type: 'getRecoveryPhrase' } // return the vault's 24-word phrase (unlocked only) for backup
  | { type: 'importIdentity'; passphrase: string; mnemonic: string } // restore an identity from its phrase
  | { type: 'export' }
  | { type: 'import'; blob: string; passphrase: string }
  // --- the Ekko account, and the encrypted backup that makes the extension and the iOS app
  // interchangeable. Same account, same blob, either direction. See core/account.ts + core/backup.ts.
  | { type: 'acctStatus' }
  | { type: 'acctSendCode'; email: string }
  | { type: 'acctVerify'; email: string; code: string }
  // Google, the only way an extension can have it in Safari: open the flow in a TAB (Safari has no
  // browser.identity, so launchWebAuthFlow is not an option), let it land on the account page that
  // already signs in with Google, and adopt the session that page stores. `acctGoogle` arms the
  // background to expect exactly one such handoff; `acctAdoptSession` is that handoff, and the
  // background refuses it from any other origin, or when it was not asked for.
  | { type: 'acctGoogle' }
  | { type: 'acctAdoptSession'; session: { accessToken: string; refreshToken: string; expiresAt: number } }
  // Publish my public key against my @handle, and adopt the keys of everyone I am connected to.
  // Mirrors ios/Ekko/AccountSync.swift. Being connected is what makes you encryptable now.
  // Claim the account @handle (onboarding's "@you, everywhere" road; requires a session — the
  // whole point is that no handle exists without registration).
  | { type: 'acctClaim'; handle: string }
  | { type: 'acctSync' }
  // Answer an incoming connection request (listed by acctSync as `requests`). Accept
  // re-syncs in the same call, so the requester lands encryptable immediately.
  | { type: 'acctAccept'; connectionId: string }
  | { type: 'acctDecline'; connectionId: string }
  | { type: 'acctSignOut' }
  // Seal this vault's phrase + contacts and upload the ciphertext. Vault must be unlocked.
  | { type: 'acctBackup'; backupPassphrase: string }
  // Pull the blob, open it, and BECOME that identity. `passphrase` locks the new local vault;
  // `backupPassphrase` is the one that opens the blob. They are different secrets.
  | { type: 'acctRestore'; backupPassphrase: string; passphrase: string }
  | { type: 'acctDeleteBackup' }
  | { type: 'encrypt'; threadId: string; plaintext: string }
  | { type: 'manualEncrypt'; threadId: string; fingerprint: string; plaintext: string }
  // In-page manual seal ("Seal for a contact"): the ONE encrypt request a content script may
  // aim at an explicit recipient. The recipient is picked inside Ekko's own closed-shadow UI,
  // and the handler never touches thread bindings — a page context still can't bind anything.
  | { type: 'sealFor'; fingerprint: string; plaintext: string }
  // Pause Ekko on one platform until the browser closes (the glyph's power button). State
  // lives in the background's storage.session — content scripts are told, never given access.
  | { type: 'setSiteSession'; platform: string; enabled: boolean }
  // peerLabel: display name auto-detected from the host page (e.g. the IG thread
  // header), used to name a contact created by this ingest. Display-only, untrusted.
  // `manual` is used only by the popup's explicit paste/decrypt tool. Content scripts
  // must be bound to a contact before they can decrypt an inbound message.
  | { type: 'ingest'; threadId: string; kind: WireKind; raw: string; peerLabel?: string; manual?: boolean };

// Responses are shaped per request; callers narrow on the field they need. `error` set
// means the request failed for a user-actionable reason (locked, wrong passphrase, …).
export interface Res {
  ok?: boolean;
  error?: string;
  state?: VaultState;
  invite?: string; // invite string / export blob
  fingerprintHex?: string;
  contacts?: ContactView[];
  contact?: ContactView | null;
  tokens?: string[]; // wire tokens for the content script to inject in order
  plaintext?: string; // decrypted message
  added?: ContactView; // newly TOFU-added sender (from a handshake)
  keyChanged?: boolean; // a handshake/invite tried to rebind an already-bound thread — warn, don't switch
  sites?: Record<string, boolean>; // per-platform enable state (Home toggles)
  sessionOff?: string[]; // platforms paused until the browser closes (glyph power button)
  tagline?: boolean; // whether to append the Ekko tag to sent ciphertext
  discover?: boolean; // whether auto-discovery lookups are enabled
  keepUnlocked?: boolean; // whether the master key survives a browser restart (opt-in)
  // My linked socials (platform -> handle), display only — a read-only mirror of the
  // account's account_handles, refreshed by acctSync. Managed on the account, never here.
  handles?: Record<string, string>;
  directory?: string; // configured directory base URL (display only)
  // updateCheck: current install vs the newest published release.
  current?: string;
  latest?: string;
  updateAvailable?: boolean;
  username?: string; // the @username owned by this identity / just claimed
  mnemonic?: string; // the 24-word recovery phrase (create / getRecoveryPhrase), shown once for backup
  // threadContact while LOCKED: answered from the plain linked-thread cache so the
  // content script can fail safe (block sends) instead of silently going plaintext.
  wasLinked?: boolean;
  // --- account (acct*) ---
  signedIn?: boolean;
  email?: string; // the account's email, for the popup to show who is signed in
  handle?: string; // the account @handle, if one is claimed (acctStatus / acctClaim)
  hasBackup?: boolean; // an encrypted backup exists on the account
  // This device holds the derived backup key and re-uploads automatically on vault changes.
  // Only meaningful while unlocked (the key lives inside the vault).
  autoBackup?: boolean;
  backupAt?: string; // when it was last written (display only)
  restoredContacts?: number; // how many contacts came back from a restore
  skippedSelf?: number; // accepted connections skipped because they share THIS identity's key (you)
  skippedNoKey?: number; // accepted connections skipped because they never published a key
  adoptedSessions?: number; // session setups adopted from the account mailbox this sync
  requests?: { id: string; handle: string }[]; // incoming pending connection requests, awaiting consent
}

// Never throws: an invalidated extension context (update/reload) or missing listener
// surfaces as { error: 'unreachable' } so callers degrade instead of breaking the page.
export async function send(req: Req): Promise<Res> {
  try {
    const res = await chrome.runtime.sendMessage(req);
    return res ?? { error: 'unreachable' };
  } catch {
    return { error: 'unreachable' };
  }
}
