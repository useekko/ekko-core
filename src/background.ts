// Service worker: the ONLY place private keys live. Content script and popup send RPCs;
// keys never cross that boundary. Master key sits in chrome.storage.session (memory-only,
// survives SW restarts, dies with the browser); the vault ciphertext sits in local.
import {
  startHandshake,
  acceptHandshake,
  sealMessage,
  openMessage,
  readSessionId,
  parseBundle,
  fingerprint as fpOf,
  safetyNumber,
  fingerprintHex,
  answerKeyChallenge,
  type Identity,
  type Session,
} from './core/crypto.js';
import { generateMnemonic, deviceIdentity, recoveryIdentity, isValidMnemonic, normalizeMnemonic } from './core/recovery.js';
import {
  deriveMaster,
  encryptVault,
  decryptVault,
  type VaultData,
  type VaultBlob,
  type Contact,
} from './core/vault.js';
import { classify, decodeBody, formatInvite, formatHandshake, formatMessage } from './core/wire.js';
import type { Req, Res, VaultState, ContactView } from './core/rpc.js';
import { b64uEncode, b64uDecode } from './core/b64.js';
import { openBackup, newBackupKey, backupKeyOf, sealBackupWithKey, type BackupPayload } from './core/backup.js';
import {
  sendCode, verifyCode, validSession, emailOf, userIdOf,
  fetchBackup, uploadBackup, deleteBackup, SUPABASE_URL,
  myProfile, publishKey, claimHandle as acctClaimHandle, connectionEdges, sessionSetups, publishSessionSetup,
  acceptConnection, declineConnection, canonHandle, mySocials,
} from './core/account.js';
import type { AccountSession, SessionSetupRow } from './core/account.js';
import { isManualThreadId, isScopedThreadId, scopedThreadId } from './core/thread.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';

// Captured once so tests can spawn isolated instances, each bound to its own shim.
const ext = chrome;

const LOCAL_BLOB = 'rsn.vault';
const SESSION_MASTER = 'rsn.master';
// "Keep me unlocked on this device": storage.session dies with the browser, so without this
// every browser start is a passphrase wall that also BLOCKS sends in linked chats (the
// locked fail-safe). Opt-in persists the derived master key in storage.local — the same
// posture as Signal Desktop et al: the OS login becomes the lock, and the UI says so
// plainly. The preference and the key are separate entries so a deliberate Lock can clear
// the key while the preference survives for the next unlock.
const KEEP_UNLOCKED_PREF = 'rsn.keepUnlocked';
const LOCAL_MASTER = 'rsn.masterLocal';
const ACCOUNT_SESSION = 'rsn.account'; // Ekko account JWT pair; see getAccountSession
// Set while a Google sign-in we started is in flight, so the account page can hand its session back
// exactly once. Memory-only (storage.session) on purpose: it must not survive a browser restart.
const ACCOUNT_AWAIT = 'rsn.account.await';
const ACCOUNT_AWAIT_MS = 10 * 60 * 1000;
// The page that already signs in with Google, and is already an allowed Supabase redirect target.
const ACCOUNT_PAGE = 'https://account.useekko.app/';
const SITES_KEY = 'rsn.sites'; // per-platform on/off; plain (not secret), readable while locked
// Platforms paused "for this session" (glyph power button). Lives in storage.session so it
// dies with the browser — and ONLY the background reads it: widening session-storage access
// to content scripts would also hand them SESSION_MASTER. Tabs learn via broadcast/RPC.
const SITES_SESSION_KEY = 'rsn.sites.session';
const TAGLINE_KEY = 'rsn.tagline'; // append the Ekko tag to sent ciphertext (default on)
// Plain-storage mirror of linked threads, keyed by a digest. It lets a LOCKED vault fail
// closed without storing raw provider conversation IDs (which can include phone numbers).
const LINKED_CACHE = 'rsn.linked';

// The server never receives private keys — only public bundles and username claims.
const DIRECTORY_URL = 'https://useekko.app';
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const PLATFORM_RE = /^[a-z][a-z0-9]{1,19}$/; // mirrors the directory's platform id rule
// Auto-discovery on/off; plain (not secret), opt-in. Gates every resolvePeer lookup.
const DISCOVER_KEY = 'rsn.discover';

// Hashes only meet if BOTH the link and lookup sides pass through canonHandle first.
// Hash on-device so peer handles never enter URL logs, browser history, or proxy traces.
const handleHash = (platform: string, handle: string) =>
  bytesToHex(sha256(new TextEncoder().encode(`${platform}:${handle}`)));

// A directory lookup chooses a contact key, so TLS is mandatory even though the bundle is
// public; secureDirectoryUrl() enforces that regardless of what the base is set to.
// The base is overridable (storage `rsn.directory`) so a self-hosted directory
// (server/README.md) is actually usable — the AGPL server without this would be an
// ornament. https-only is enforced at BOTH the set and the use.
const DIRECTORY_KEY = 'rsn.directory';
let directoryBase: string | null | undefined; // undefined = not read from storage yet

function normalizeDirectory(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(String(raw));
    return url.protocol === 'https:' ? url.href.replace(/\/$/, '') : null;
  } catch {
    return null;
  }
}

async function secureDirectoryUrl(): Promise<string | null> {
  if (directoryBase === undefined) {
    const rec = await ext.storage.local.get(DIRECTORY_KEY);
    directoryBase = normalizeDirectory(rec[DIRECTORY_KEY] as string | undefined) ?? normalizeDirectory(DIRECTORY_URL);
  }
  return directoryBase;
}

let vault: VaultData | null = null;
let master: Uint8Array | null = null;
let currentSalt: Uint8Array | null = null;

const linkedCacheKey = (threadId: string) => b64uEncode(sha256(new TextEncoder().encode(threadId)));

// v0.3 supported Instagram only, so every unscoped legacy binding belongs there.
function migrateLegacyThreads(v: VaultData): boolean {
  let changed = false;
  for (const [threadId, fingerprint] of Object.entries(v.threadBindings)) {
    if (isScopedThreadId(threadId)) continue;
    const scoped = scopedThreadId('instagram', threadId);
    v.threadBindings[scoped] ??= fingerprint;
    delete v.threadBindings[threadId];
    changed = true;
  }
  for (const session of v.sessions) {
    // Account-mailbox sessions are thread-less BY DESIGN (per-contact, like ios:<id> on
    // the phone) — only unmarked thread-less sessions are pre-scoping legacy artifacts.
    if (session.threadId || session.acct) continue;
    const matches = Object.entries(v.threadBindings)
      .filter(([, fp]) => fp === bytesToHex(session.peerFingerprint))
      .map(([threadId]) => threadId);
    // A legacy manual-encrypt binding is not a transport conversation. Prefer the sole
    // real chat when it exists. An unmatched/ambiguous session is quarantined under a
    // sentinel thread no page can ever present: old history stays decryptable through
    // the popup's explicit manual tool (which ignores thread scope), but the session
    // can never be replayed into a live conversation.
    const direct = matches.filter((threadId) => !isManualThreadId(threadId));
    session.threadId =
      direct.length === 1 ? direct[0]! : matches.length === 1 ? matches[0]! : scopedThreadId('legacy', 'unmatched');
    changed = true;
  }
  return changed;
}

async function loadMaster(): Promise<Uint8Array | null> {
  if (master) return master;
  const s = await ext.storage.session.get(SESSION_MASTER);
  const v = s[SESSION_MASTER] as string | undefined;
  if (v) {
    master = b64uDecode(v);
    return master;
  }
  // Browser restart wiped the session copy; fall back to the opted-in local copy. A stale
  // key (vault since replaced under a new passphrase) fails decryptVault in getVault and
  // reads as locked — same as a stale session copy always has.
  const l = await ext.storage.local.get(LOCAL_MASTER);
  const lv = l[LOCAL_MASTER] as string | undefined;
  if (lv) {
    master = b64uDecode(lv);
    await ext.storage.session.set({ [SESSION_MASTER]: lv });
  }
  return master;
}

async function keepUnlockedPref(): Promise<boolean> {
  const rec = await ext.storage.local.get(KEEP_UNLOCKED_PREF);
  return rec[KEEP_UNLOCKED_PREF] === true;
}

// The one door every new master key walks through (create, unlock, import, restore,
// passphrase change): session always; the local copy exactly when opted in — and REMOVED
// otherwise, so a stale key can never outlive the preference or an old passphrase.
async function persistMaster(m: Uint8Array): Promise<void> {
  const encoded = b64uEncode(m);
  await ext.storage.session.set({ [SESSION_MASTER]: encoded });
  if (await keepUnlockedPref()) await ext.storage.local.set({ [LOCAL_MASTER]: encoded });
  else await ext.storage.local.remove(LOCAL_MASTER);
}

async function getVault(): Promise<VaultData | null> {
  if (vault) return vault;
  const m = await loadMaster();
  if (!m) return null;
  const rec = await ext.storage.local.get(LOCAL_BLOB);
  const blob = rec[LOCAL_BLOB] as VaultBlob | undefined;
  if (!blob) return null;
  currentSalt = b64uDecode(blob.salt);
  try {
    vault = decryptVault(blob, m);
  } catch {
    return null; // master stale (e.g. vault replaced) — treat as locked
  }
  await migrateAndSync(vault);
  // Catch-up: a service-worker death between a change and its auto-upload leaves the dirty
  // flag set; the first rehydrate finishes the job. Once per worker life.
  if (!dirtyChecked) {
    dirtyChecked = true;
    void ext.storage.local.get(BACKUP_DIRTY).then((r) => {
      if (r[BACKUP_DIRTY]) void autoBackup();
    });
  }
  return vault;
}

// --- automatic backup ---
// One passphrase per account: the derived key lives in the vault (see VaultData.backup), so
// every vault change can re-seal a CURRENT blob without re-asking for the passphrase. The
// dirty flag rides the same storage write as the vault blob, so a worker killed mid-flight
// picks the upload back up on the next rehydrate.
const BACKUP_DIRTY = 'rsn.backupDirty';

// --- update notice ---
const UPDATE_KEY = 'rsn.update';
const UPDATE_CHECK_EVERY_MS = 24 * 3600_000;

/** Is a > b, both "x.y.z"? Non-numeric parts compare as 0 — a weird tag never claims newer. */
function newerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}
let dirtyChecked = false;
let backingUp = false;
let backupQueued = false;

function backupPayloadOf(v: VaultData): Omit<BackupPayload, 'v'> {
  return {
    mnemonic: v.mnemonic!,
    contacts: v.contacts.map((c) => ({
      bundle: b64uEncode(c.bundle),
      label: c.label,
      verified: c.verified,
      addedAt: c.addedAt,
    })),
    // Sessions are the only capability that reads past messages — without them a restore
    // orphans history (handshakeWire stays behind: pending-setup replay state, re-staged
    // by the next sync where still needed).
    sessions: v.sessions.map((s) => ({
      id: b64uEncode(s.id),
      key0to1: b64uEncode(s.key0to1),
      key1to0: b64uEncode(s.key1to0),
      myParty: s.myParty,
      peerFingerprint: b64uEncode(s.peerFingerprint),
      threadId: s.threadId,
      acct: s.acct,
    })),
  };
}

async function autoBackup(): Promise<void> {
  if (backingUp) {
    backupQueued = true; // a change landed mid-upload; re-seal once this one finishes
    return;
  }
  const v = vault;
  if (!v?.backup || !v.mnemonic) return;
  const s = await getAccountSession();
  if (!s) return;
  backingUp = true;
  try {
    do {
      backupQueued = false;
      await uploadBackup(s, sealBackupWithKey(backupPayloadOf(v), v.backup.key, v.backup.salt, v.backup.iter));
    } while (backupQueued);
    await ext.storage.local.remove(BACKUP_DIRTY);
  } catch {
    /* offline: the dirty flag stays set; the next change or rehydrate retries */
  } finally {
    backingUp = false;
  }
}

// Every path where a vault becomes readable (unlock, lazy rehydrate, import) runs the
// one-time legacy migration, then makes sure the locked fail-safe cache exists — a
// pre-existing vault that never re-persists must still get its fail-safe backfilled.
async function migrateAndSync(v: VaultData): Promise<void> {
  if (migrateLegacyThreads(v)) await persist();
  else await syncLinkedCache(v);
}

// Derive the plain linked-thread cache from the vault's truth.
function linkedCacheOf(v: VaultData): Record<string, true> {
  const linked: Record<string, true> = {};
  // Skip opt-out tombstones ('' — see unbindThread): an explicitly unlinked chat must not
  // read as "was linked" while locked, or it would block normal sending for no reason.
  for (const [tid, fp] of Object.entries(v.threadBindings)) if (fp) linked[linkedCacheKey(tid)] = true;
  return linked;
}

async function syncLinkedCache(v: VaultData): Promise<void> {
  await ext.storage.local.set({ [LINKED_CACHE]: linkedCacheOf(v) });
}

// --- account session ---
//
// Kept in storage.local, NOT storage.session: the point of signing in is that it survives a browser
// restart. What that exposes, stated plainly: anyone with read access to the profile directory gets
// the account session (the @handle, the people, and the ENCRYPTED backup blob). It does not get the
// keys — the blob is passphrase-locked and the passphrase is never stored anywhere. That is the same
// exposure as any signed-in web app's localStorage, and strictly less than the vault, which is
// scrypt-encrypted precisely because storage.local is plaintext.
async function getAccountSession(): Promise<AccountSession | null> {
  const rec = await ext.storage.local.get(ACCOUNT_SESSION);
  const s = rec[ACCOUNT_SESSION] as AccountSession | undefined;
  if (!s) return null;
  try {
    const fresh = await validSession(s);
    if (fresh !== s) await setAccountSession(fresh); // refresh tokens rotate: persist the new pair
    return fresh;
  } catch {
    // The server rejected the refresh token: the session is dead, so stop pretending otherwise.
    // (A network failure throws a TypeError from fetch, not an AccountError — but treating both as
    // signed-out only costs a re-login, while treating a dead session as live costs a 401 loop.)
    await setAccountSession(null);
    return null;
  }
}

async function setAccountSession(s: AccountSession | null): Promise<void> {
  if (s) await ext.storage.local.set({ [ACCOUNT_SESSION]: s });
  else await ext.storage.local.remove(ACCOUNT_SESSION);
}

async function persist(): Promise<void> {
  if (!vault || !master || !currentSalt) return;
  // One write, not two: the blob and its plain linked-thread mirror must land together,
  // and each storage.local.set is an IPC round-trip on the RPC critical path.
  await ext.storage.local.set({
    [LOCAL_BLOB]: encryptVault(vault, master, currentSalt),
    [LINKED_CACHE]: linkedCacheOf(vault),
    // The dirty flag rides the same write, so no vault change can outlive a worker death
    // without leaving a re-upload marker behind.
    ...(vault.backup ? { [BACKUP_DIRTY]: true } : {}),
  });
  if (vault.backup) void autoBackup(); // fire-and-forget: the RPC must not wait on the network
}

// Shared validation for every "add a contact from an invite" path: the popup's
// addContact and the in-page acceptInvite must accept and reject identically, or a fix
// to one leaves the other accepting invites it was meant to refuse.
function parseInviteOrError(
  v: VaultData,
  raw: string,
): { bundle: Uint8Array } | { error: 'not-an-invite' | 'bad-invite' | 'thats-you' } {
  const c = classify(raw);
  if (!c || c.kind !== 'invite') return { error: 'not-an-invite' };
  let bundle: Uint8Array;
  try {
    bundle = decodeBody(c.raw);
    parseBundle(bundle);
  } catch {
    return { error: 'bad-invite' };
  }
  if (bytesToHex(fpOf(bundle)) === bytesToHex(v.identity.fingerprint)) return { error: 'thats-you' };
  return { bundle };
}

async function state(): Promise<VaultState> {
  const rec = await ext.storage.local.get(LOCAL_BLOB);
  if (!rec[LOCAL_BLOB]) return 'no-vault';
  return (await getVault()) ? 'unlocked' : 'locked';
}

function contactView(c: Contact, myFp: Uint8Array): ContactView {
  return {
    fingerprint: bytesToHex(c.fingerprint),
    label: c.label,
    verified: c.verified,
    safetyNumber: safetyNumber(myFp, c.fingerprint),
    fingerprintHex: fingerprintHex(c.fingerprint),
    handles: c.handles,
  };
}

function findContact(v: VaultData, fpHex: string): Contact | undefined {
  return v.contacts.find((c) => bytesToHex(c.fingerprint) === fpHex);
}

// Untrusted display text from the host page or user input: trim, collapse, cap.
function cleanLabel(s: string | undefined): string | undefined {
  const t = s?.replace(/\s+/g, ' ').trim().slice(0, 40);
  return t || undefined;
}

const isDefaultLabel = (s: string) => /^Contact \d+$/.test(s);

function upsertContact(v: VaultData, bundle: Uint8Array, label: string | undefined): Contact {
  const fp = fpOf(bundle);
  const hex = bytesToHex(fp);
  const existing = v.contacts.find((c) => bytesToHex(c.fingerprint) === hex);
  if (existing) {
    // Upgrade a placeholder name once a real one is detected; never clobber a user-set one.
    if (label && isDefaultLabel(existing.label)) existing.label = label;
    return existing;
  }
  const c: Contact = {
    bundle,
    fingerprint: fp,
    label: label ?? `Contact ${v.contacts.length + 1}`,
    verified: false,
    addedAt: Math.floor(Date.now() / 1000),
  };
  v.contacts.push(c);
  return c;
}

// Two contacts can be the SAME person under different device keys: contacts are keyed by
// fingerprint, but an account is one identity across key rotations. After account-sync resolves a
// peer's CURRENT-key contact (`survivor`), fold any older-key look-alike for that same account into
// it — otherwise a peer who re-onboards with a new key leaves a duplicate behind (the "two @kirill"
// report). Matching, safest signal first:
//   • stored userId — durable + exact, for contacts saved since we began stamping it.
//   • legacy (no userId): the peer's directory @handle, which is GLOBALLY UNIQUE (profiles.handle),
//     AND at least one shared linked social — a belt against the rare handle-reassignment case
//     (account_handles is only unique per (user,platform,handle)). A user-RENAMED label is never
//     matched, only the system-set `@handle` label.
// Carries a user-set name + linked handles forward, re-points open threads onto the new key, and
// drops the dead key's sessions. Never carries `verified` forward — a new key must be re-verified.
// Exported for the unit test.
export function reconcileContactKeys(v: VaultData, survivor: Contact, userId: string, handle: string): boolean {
  const survivorFp = bytesToHex(survivor.fingerprint);
  const handleLabel = handle ? `@${handle.toLowerCase()}` : '';
  const handleish = (label: string) => isDefaultLabel(label) || (!!handleLabel && label.toLowerCase() === handleLabel);
  const shareSocial = (a?: Record<string, string>, b?: Record<string, string>) =>
    !!a && !!b && Object.keys(a).some((p) => !!a[p] && a[p] === b[p]);

  let changed = survivor.userId !== userId;
  survivor.userId = userId;

  const dead = v.contacts.filter(
    (o) =>
      o !== survivor &&
      (o.userId === userId ||
        (!o.userId &&
          !!handleLabel &&
          o.label.toLowerCase() === handleLabel &&
          shareSocial(o.handles, survivor.handles))),
  );
  for (const o of dead) {
    const oldFp = bytesToHex(o.fingerprint);
    if (o.label && !handleish(o.label) && handleish(survivor.label)) survivor.label = o.label; // keep a user-set name
    if (o.handles) survivor.handles = { ...o.handles, ...survivor.handles };
    for (const tid of Object.keys(v.threadBindings))
      if (v.threadBindings[tid] === oldFp) v.threadBindings[tid] = survivorFp; // open chats follow the new key
    v.sessions = v.sessions.filter((s) => bytesToHex(s.peerFingerprint) !== oldFp);
    changed = true;
  }
  if (dead.length) v.contacts = v.contacts.filter((c) => !dead.includes(c));
  return changed;
}

/// What the directory publishes for a @handle. Shared by the preview (dirLookup) and the add
/// (dirAdd) so the two can never disagree about what it said — the whole point of the preview is
/// that the thing you looked at is the thing you get.
async function directoryInvite(username: string): Promise<{ invite: string } | { error: string }> {
  const directory = await secureDirectoryUrl();
  if (!directory) return { error: 'directory-insecure' };
  try {
    const r = await fetch(`${directory}/u/${encodeURIComponent(username)}`);
    if (r.status === 404) return { error: 'not-found' };
    if (!r.ok) return { error: 'directory-error' };
    return { invite: ((await r.json()) as { invite?: string }).invite ?? '' };
  } catch {
    return { error: 'directory-unreachable' };
  }
}

async function claimUsernameRemote(bundle: Uint8Array, username: string): Promise<Res> {
  const directory = await secureDirectoryUrl();
  if (!directory) return { error: 'directory-insecure' };
  try {
    const r = await fetch(`${directory}/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invite: formatInvite(bundle), username }),
    });
    if (r.status === 409) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      return { error: body.error ?? 'username-taken' };
    }
    if (r.status === 400) return { error: 'bad-username' };
    if (!r.ok) return { error: 'directory-error' };
    return { ok: true, username };
  } catch {
    return { error: 'directory-unreachable' };
  }
}

// Prove control of an identity's device key to the directory (X25519 ECDH challenge).
// Returns the one-time credentials every authenticated endpoint consumes. Throws on
// network failure — callers map that to directory-unreachable.
async function proveKey(directory: string, identity: Identity): Promise<{ challengeId: string; proof: string } | { error: string }> {
  const cr = await fetch(`${directory}/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ invite: formatInvite(identity.bundle) }),
  });
  if (!cr.ok) return { error: 'directory-error' };
  const ch = (await cr.json()) as { challengeId?: string; challenge?: string };
  if (!ch.challengeId || !ch.challenge) return { error: 'directory-error' };
  return { challengeId: ch.challengeId, proof: b64uEncode(answerKeyChallenge(identity.xPriv, b64uDecode(ch.challenge))) };
}

// Authenticated handle claim (v2 directory): prove control of the device key via the X25519
// ECDH challenge, and register the recovery key as the account's account-free recovery anchor.
// This replaces the unauthenticated TOFU claim for phrase-derived identities, so nobody can
// grab an @handle they don't hold the key for.
async function claimHandleAuthed(device: Identity, recovery: Identity, username: string): Promise<Res> {
  const directory = await secureDirectoryUrl();
  if (!directory) return { error: 'directory-insecure' };
  try {
    const cred = await proveKey(directory, device);
    if ('error' in cred) return cred;
    const r = await fetch(`${directory}/u/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...cred, username, recovery: formatInvite(recovery.bundle) }),
    });
    if (r.status === 409) return { error: 'username-taken' };
    if (r.status === 400) return { error: 'bad-username' };
    if (r.status === 401) return { error: 'bad-proof' };
    if (!r.ok) return { error: 'directory-error' };
    return { ok: true, username };
  } catch {
    return { error: 'directory-unreachable' };
  }
}

// A phrase restores keys, not the independent @handle string. On the user's explicit
// handle step, prove the recovery key and ask the directory whether that handle belongs
// to this account. Anonymous restores skip the step and make no directory request.
async function recoverHandleAuthed(recovery: Identity): Promise<Res> {
  const directory = await secureDirectoryUrl();
  if (!directory) return { error: 'directory-insecure' };
  try {
    const cred = await proveKey(directory, recovery);
    if ('error' in cred) return cred;
    const r = await fetch(`${directory}/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cred),
    });
    if (r.status === 404) return { error: 'no-account' };
    if (r.status === 401) return { error: 'bad-proof' };
    if (!r.ok) return { error: 'directory-error' };
    const found = (await r.json()) as { username?: string };
    return found.username && USERNAME_RE.test(found.username)
      ? { ok: true, username: found.username }
      : { error: 'directory-error' };
  } catch {
    return { error: 'directory-unreachable' };
  }
}

const MAX_SESSIONS_PER_PEER_THREAD = 4;

// Keep multiple sessions per peer AND direct thread. A session negotiated for one DM must
// not be selected for another DM with the same contact. Dedupe by ID and bound each
// peer/thread list so repeated rekeys cannot grow the vault forever.
function storeSession(v: VaultData, s: Session): void {
  const id = bytesToHex(s.id);
  v.sessions = v.sessions.filter((x) => bytesToHex(x.id) !== id);
  v.sessions.push(s);
  const peer = bytesToHex(s.peerFingerprint);
  const mine = v.sessions.filter((x) => bytesToHex(x.peerFingerprint) === peer && x.threadId === s.threadId);
  if (mine.length > MAX_SESSIONS_PER_PEER_THREAD) {
    const drop = new Set(mine.slice(0, mine.length - MAX_SESSIONS_PER_PEER_THREAD).map((x) => bytesToHex(x.id)));
    v.sessions = v.sessions.filter((x) => !drop.has(bytesToHex(x.id)));
  }
}

// Shared logic for ingesting a peer's key from a handshake or an invite. It NEVER binds a
// thread: DOM-derived names and replayed protocol messages are not authorization to choose
// the recipient of future outbound messages. On conflict it stores the contact for manual
// review, keeps the existing binding, withholds the display name, and signals keyChanged.
async function ingestPeerBundle(
  v: VaultData,
  threadId: string,
  bundle: Uint8Array,
  label: string | undefined,
  session?: Session,
  manual = false,
): Promise<Res> {
  const fpHex = bytesToHex(fpOf(bundle));
  const current = v.threadBindings[threadId] || undefined; // '' opt-out tombstone = unbound here
  // A manual paste is an explicit extension-page action. It can read several copied
  // conversations without changing the one contact currently selected for manual send.
  const conflict = !manual && current !== undefined && current !== fpHex;
  // Record the contact so the user can inspect it in the popup, but on a conflict do NOT
  // store the session — otherwise the conflicting party's messages would decrypt and
  // display inside the thread the user still believes belongs to the original contact.
  const contact = upsertContact(v, bundle, conflict ? undefined : label);
  if (session && !conflict) storeSession(v, session);
  await persist();
  if (conflict) return { ok: true, keyChanged: true, contact: contactView(contact, v.identity.fingerprint) };
  return { ok: true, added: contactView(contact, v.identity.fingerprint) };
}

// Publish my public key against my handle, adopt the key of everyone I am connected to, and
// carry the post-quantum session setup through the connection instead of the conversation.
// The mirror of ios/Ekko/AccountSync.swift — the two must agree, or the phone and the
// browser would disagree about who you can encrypt to (and a channel the phone staged in the
// `session_setups` mailbox would leave this browser saying "waiting for the secure channel"
// about messages whose setup never travels in-chat anymore).
//
// Adoption is trust-on-first-use and lands UNVERIFIED, exactly like a pasted invite. The server
// saying "this is @maya's key" is the same promise Signal's server makes; the safety number, not
// the server, is what makes it true.
//
// Serialized: the popup's sync and the ingest self-heal can fire together, and two interleaved
// loops could each stage a session for one peer while the mailbox upsert keeps only one of them.
// A concurrent caller joins the in-flight run instead.
let syncRun: Promise<Res> | null = null;
function syncAccount(v: VaultData, s: AccountSession): Promise<Res> {
  syncRun ??= runAccountSync(v, s).finally(() => (syncRun = null));
  return syncRun;
}

async function runAccountSync(v: VaultData, s: AccountSession): Promise<Res> {
  const mine = await myProfile(s);
  if (!mine) return { error: 'no-handle' }; // the key hangs off the profile row
  const invite = formatInvite(v.identity.bundle);
  if (mine.publicKey !== invite) await publishKey(s, invite);

  const me = userIdOf(s);
  // The mailbox is newer than the account itself. If this backend does not have the table
  // yet, key adoption — the part that IS the encrypted channel — must still run; senders
  // simply keep the in-chat preamble (encrypt only skips it once the mailbox holds the copy).
  let setups: SessionSetupRow[] | null = null;
  try {
    setups = await sessionSetups(s);
  } catch {
    setups = null;
  }

  const myKey = bytesToHex(v.identity.fingerprint);
  let adopted = 0;
  let adoptedSessions = 0;
  let changed = false;
  let skippedSelf = 0;
  let skippedNoKey = 0;
  const requests: { id: string; handle: string }[] = [];

  // MY linked socials mirror the account now — they are managed there (the phone, the account
  // page), never here. Replace, don't merge: a social removed on the account must disappear
  // here too. Non-fatal, like the peer read — offline keeps the last mirror.
  try {
    const socials = await mySocials(s);
    if (JSON.stringify(socials) !== JSON.stringify(v.platformHandles ?? {})) {
      v.platformHandles = Object.keys(socials).length ? socials : undefined;
      changed = true;
    }
  } catch {
    /* offline or an older backend: keep the last mirror */
  }

  for (const edge of await connectionEdges(s)) {
    // The requester stages setup even while pending (RLS hides it until acceptance). A
    // pending request someone sent ME is a consent decision — surface it, act on nothing.
    if (!edge.accepted && !edge.iRequested) {
      requests.push({ id: edge.connectionId, handle: edge.peer.handle });
      continue;
    }
    const peer = edge.peer;
    if (!peer.publicKey) {
      if (edge.accepted) skippedNoKey++; // connected, but no device ever made them an identity
      continue;
    }
    const parsed = parseInviteOrError(v, peer.publicKey);
    if ('error' in parsed) {
      // A connection whose key IS this device's key (two @handles built from one seed) can't
      // be a contact — you can't add yourself. Count it so the popup can say so out loud.
      if (parsed.error === 'thats-you' && edge.accepted) skippedSelf++;
      continue;
    }
    const peerKey = bytesToHex(fpOf(parsed.bundle));

    if (setups && edge.iRequested && me) {
      try {
        // The account channel is per-contact, like `ios:<id>` on the phone: threadId stays
        // unset so the one session serves whichever chats bind to this peer.
        let acct = v.sessions.findLast((x) => bytesToHex(x.peerFingerprint) === peerKey && !x.threadId);
        if (!acct) {
          const hs = startHandshake(v.identity, parsed.bundle);
          acct = hs.session;
          acct.acct = true; // exempt from the legacy thread migration — thread-less by design
          acct.handshakeWire = hs.wire;
          storeSession(v, acct);
          // Durable BEFORE the mailbox row exists: a crash between the two may strand OUR
          // copy (re-published next sync), never the peer with a session nobody holds.
          await persist();
          changed = true;
        }
        if (acct.handshakeWire) {
          await publishSessionSetup(s, {
            connection_id: edge.connectionId,
            recipient: peer.userId,
            sender_key: myKey,
            recipient_key: peerKey,
            handshake: formatHandshake(acct.handshakeWire),
          });
          delete acct.handshakeWire; // the mailbox owns the durable copy now — no in-chat preamble
          changed = true;
        }
      } catch {
        /* offline mid-publish: the wire stays, encrypt falls back to the preamble */
      }
    }

    if (!edge.accepted) continue;
    const known = v.contacts.some((c) => bytesToHex(c.fingerprint) === peerKey);
    const c = upsertContact(v, parsed.bundle, `@${peer.handle}`); // dedupes by fp; keeps a user-set name
    if (!known) adopted++;
    // Attach their linked messenger handles so a chat with them binds to THIS contact by
    // handle instead of spawning a look-alike. Refreshed even for known contacts (they may
    // link a new one). peer.handles is already normalized in connectionEdges.
    if (peer.handles && Object.keys(peer.handles).length) {
      const merged = { ...c.handles, ...peer.handles };
      if (JSON.stringify(merged) !== JSON.stringify(c.handles ?? {})) {
        c.handles = merged;
        changed = true;
      }
    }

    // Same account, possibly a new device key: stamp the account id (so a future rotation
    // self-heals) and retire any older-key look-alike for this same person. Runs after the handles
    // merge so the shared-social safety check sees this peer's full, current handle set.
    if (reconcileContactKeys(v, c, peer.userId, peer.handle)) changed = true;

    if (setups && !edge.iRequested && me) {
      // The setup the requester staged for me. Both fingerprints must match — a row from
      // before either side rotated is refused, exactly like ios/Ekko/AccountSync.swift.
      const row = setups.findLast(
        (r) =>
          r.connection_id === edge.connectionId &&
          r.sender === peer.userId &&
          r.recipient === me &&
          r.sender_key === peerKey &&
          r.recipient_key === myKey,
      );
      if (row) {
        try {
          const token = classify(row.handshake);
          if (token?.kind === 'handshake') {
            const acc = acceptHandshake(v.identity, decodeBody(token.raw));
            // The expected-contact check: a swapped row must not select a different peer.
            if (bytesToHex(fpOf(acc.peerBundle)) === peerKey) {
              const held = v.sessions.find((x) => bytesToHex(x.id) === bytesToHex(acc.session.id));
              if (!held) {
                acc.session.acct = true; // thread-less by design: serves any chat bound to this peer
                storeSession(v, acc.session);
                adoptedSessions++;
                changed = true;
              } else if (!held.acct && held.threadId === scopedThreadId('legacy', 'unmatched')) {
                // An earlier build's legacy migration quarantined this mailbox session
                // before it carried the marker. Un-quarantine: it is the live channel.
                delete held.threadId;
                held.acct = true;
                adoptedSessions++;
                changed = true;
              }
            }
          }
        } catch {
          /* a corrupt row must not take down the rest of the sync */
        }
      }
    }
  }
  if (adopted || changed) await persist();
  return { ok: true, restoredContacts: adopted, skippedSelf, skippedNoKey, adoptedSessions, requests };
}

// A message named a session we do not hold. Before giving up, pull the account mailbox once —
// an iOS sender stages its setup there instead of the chat, so the bubble would otherwise say
// "waiting for the secure channel" forever. Debounced: unknown ciphertext from a stranger must
// not become a network beacon per bubble.
let lastMailboxPull = 0;
const MAILBOX_PULL_EVERY_MS = 60_000;
async function adoptStagedSession(v: VaultData, sidHex: string): Promise<Session | undefined> {
  if (Date.now() - lastMailboxPull < MAILBOX_PULL_EVERY_MS) return undefined;
  lastMailboxPull = Date.now();
  const s = await getAccountSession();
  if (!s) return undefined;
  try {
    const res = await syncAccount(v, s);
    // Earlier bubbles in this and other tabs are already parked as pending; wake them so the
    // whole conversation heals, not just the message that triggered the pull.
    if (res.adoptedSessions) void broadcastRescan();
  } catch {
    /* offline: the bubble keeps its pending hint, and the popup's explicit sync still exists */
  }
  return v.sessions.find((x) => bytesToHex(x.id) === sidHex);
}

async function broadcastRescan(): Promise<void> {
  try {
    const tabs = await ext.tabs.query({});
    await Promise.allSettled(
      tabs.filter((t) => t.id).map((t) => ext.tabs.sendMessage(t.id!, { type: 'rescan' })),
    );
  } catch {
    /* no tabs API in this context (tests) — the popup-driven rescan path still covers it */
  }
}

async function sessionPaused(): Promise<Set<string>> {
  const rec = await ext.storage.session.get(SITES_SESSION_KEY);
  return new Set((rec[SITES_SESSION_KEY] as string[]) ?? []);
}

// Session pause changes can't ride storage.onChanged (content scripts have no session-area
// access, by design) — tell every tab directly, same pattern as broadcastRescan.
async function broadcastSiteSession(platform: string, enabled: boolean): Promise<void> {
  try {
    const tabs = await ext.tabs.query({});
    await Promise.allSettled(
      tabs.filter((t) => t.id).map((t) => ext.tabs.sendMessage(t.id!, { type: 'siteSession', platform, enabled })),
    );
  } catch {
    /* no tabs API in this context (tests) */
  }
}

// The wire tokens for one outgoing message to `fp` in the context `threadId`: reuse the
// newest session for this peer/context (post-rekey correctness; a threadless session came
// through the account mailbox and serves any context), else start one. The handshake is
// replayed ahead of the message until authenticated peer traffic arrives.
// threadId null = create the session THREADLESS (the manual seal): it is per-contact by
// construction, and the chat it was pasted into may get linked later — a thread-pinned
// session would then fail that same chat with wrong-thread forever.
async function sendTokens(v: VaultData, contact: Contact, fp: string, threadId: string | null, plaintext: string): Promise<string[]> {
  const findSession = () =>
    v.sessions.findLast((s) => bytesToHex(s.peerFingerprint) === fp && (!s.threadId || s.threadId === threadId));
  let session = findSession();
  if (!session) {
    // First contact: the account mailbox may already carry the setup (their device staged
    // it) or accept ours — sync once before inventing an in-chat "Secure-channel setup"
    // preamble the user has to watch. Offline or not connected: the preamble below stands.
    const acct = await getAccountSession();
    if (acct) {
      try {
        await syncAccount(v, acct);
        session = findSession();
      } catch {
        /* offline: fall back to the in-chat preamble */
      }
    }
  }
  if (!session) {
    const hs = startHandshake(v.identity, contact.bundle);
    session = hs.session;
    if (threadId) session.threadId = threadId;
    session.handshakeWire = hs.wire;
    storeSession(v, session);
  }
  const tokens: string[] = [];
  if (session.handshakeWire) tokens.push(formatHandshake(session.handshakeWire));
  tokens.push(formatMessage(sealMessage(session, plaintext)));
  return tokens;
}

async function handle(req: Req, sender?: chrome.runtime.MessageSender): Promise<Res> {
  switch (req.type) {
    case 'status': {
      const st = await state();
      return { state: st, fingerprintHex: vault ? fingerprintHex(vault.identity.fingerprint) : undefined };
    }

    case 'create': {
      // Never clobber an existing vault (e.g. a stale popup that still shows onboarding).
      if ((await ext.storage.local.get(LOCAL_BLOB))[LOCAL_BLOB]) return { error: 'vault-exists' };
      // A brand-new identity is signed into nobody. Clear any stale account session so the popup
      // never claims you are signed in to an account this identity never touched (the exact "it says
      // I'm signed in as kvasilev but I didn't sign in" bug). The reset flow passes adopt=true to
      // KEEP the session and republish this new key onto that account instead.
      if (!req.adopt) await setAccountSession(null);
      const username = req.username?.toLowerCase();
      if (username && !USERNAME_RE.test(username)) return { error: 'bad-username' };
      // Phrase-derived identity: the mnemonic is the account-free backup for both the device
      // key (index 0) and the recovery key. Returned once so onboarding can show it to back up.
      const mnemonic = generateMnemonic();
      const identity = deviceIdentity(mnemonic, 0);
      const salt = randomBytes(16);
      const m = await deriveMaster(req.passphrase, salt);
      const next: VaultData = { identity, username, mnemonic, contacts: [], sessions: [], threadBindings: {} };
      if (username) {
        const claimed = await claimHandleAuthed(identity, recoveryIdentity(mnemonic), username);
        if (claimed.error) return claimed;
      }
      currentSalt = salt;
      master = m;
      vault = next;
      await persistMaster(master);
      await persist();
      return { ok: true, invite: formatInvite(identity.bundle), fingerprintHex: fingerprintHex(identity.fingerprint), username, mnemonic };
    }

    case 'importIdentity': {
      // Restore from a recovery phrase on a new device: re-derive the SAME device identity,
      // so any @handle in the directory still resolves to you — no rotation needed.
      if ((await ext.storage.local.get(LOCAL_BLOB))[LOCAL_BLOB]) return { error: 'vault-exists' };
      if (!isValidMnemonic(req.mnemonic)) return { error: 'bad-phrase' };
      const mnemonic = normalizeMnemonic(req.mnemonic);
      const identity = deviceIdentity(mnemonic, 0);
      const salt = randomBytes(16);
      const m = await deriveMaster(req.passphrase, salt);
      currentSalt = salt;
      master = m;
      vault = { identity, mnemonic, contacts: [], sessions: [], threadBindings: {} };
      // The phrase owns its @handle in the directory (bound to the recovery key) even though
      // the string isn't derivable from the words — adopt it now so the popup shows @you, not
      // an empty claim prompt (the comment above promises the handle "still resolves to you").
      // Best effort: offline or a never-claimed phrase just stays invite-only.
      const recovered = await recoverHandleAuthed(recoveryIdentity(mnemonic));
      if (recovered.username) vault.username = recovered.username;
      await persistMaster(master);
      await persist();
      return { ok: true, fingerprintHex: fingerprintHex(identity.fingerprint) };
    }

    case 'getRecoveryPhrase': {
      const v = await getVault();
      if (!v) return { error: 'locked' };
      if (!v.mnemonic) return { error: 'no-phrase' }; // legacy random identity: no seed phrase
      return { ok: true, mnemonic: v.mnemonic };
    }

    case 'unlock': {
      const rec = await ext.storage.local.get(LOCAL_BLOB);
      const blob = rec[LOCAL_BLOB] as VaultBlob | undefined;
      if (!blob) return { error: 'no-vault' };
      currentSalt = b64uDecode(blob.salt);
      const m = await deriveMaster(req.passphrase, currentSalt);
      try {
        vault = decryptVault(blob, m);
      } catch {
        return { error: 'wrong-passphrase' };
      }
      master = m;
      // The unlock screen carries the choice (that is where the pain is felt); it only
      // lands after the passphrase proved right, so a typo can't flip the preference.
      if (typeof req.keepUnlocked === 'boolean') await ext.storage.local.set({ [KEEP_UNLOCKED_PREF]: req.keepUnlocked });
      await persistMaster(m);
      await migrateAndSync(vault);
      return { ok: true, fingerprintHex: fingerprintHex(vault.identity.fingerprint) };
    }

    case 'lock': {
      vault = null;
      master = null;
      // A deliberate Lock means locked NOW, keep-unlocked or not: both key copies go. The
      // preference itself survives, so the next unlock re-persists without re-opting-in.
      await ext.storage.session.remove(SESSION_MASTER);
      await ext.storage.local.remove(LOCAL_MASTER);
      return { ok: true };
    }

    case 'invite': {
      const v = await getVault();
      if (!v) return { error: 'locked' };
      return {
        invite: formatInvite(v.identity.bundle),
        fingerprintHex: fingerprintHex(v.identity.fingerprint),
        username: v.username,
        handles: v.platformHandles,
      };
    }

    case 'addContact': {
      const v = await getVault();
      if (!v) return { error: 'locked' };
      const parsed = parseInviteOrError(v, req.invite);
      if ('error' in parsed) return parsed;
      const contact = upsertContact(v, parsed.bundle, cleanLabel(req.label));
      await persist();
      return { ok: true, contact: contactView(contact, v.identity.fingerprint) };
    }

    case 'acceptInvite': {
      // This is the in-page glyph's explicit click path. Keep it tab-only so a popup
      // cannot accidentally turn pasted text into a live chat binding.
      if (!sender?.tab) return { error: 'invite-only' };
      if (!isScopedThreadId(req.threadId)) return { error: 'bad-thread' };
      const v = await getVault();
      if (!v) return { error: 'locked' };
      // Never overwrite a live link. This makes the add+bind action safe even if another
      // Ekko view changes the chat between the glyph click and this request.
      if (v.threadBindings[req.threadId]) return { error: 'already-linked' };
      // The accepted token may be an invite OR a first-contact handshake ("Maya started an
      // encrypted chat"). Accepting a handshake also stores its session, so the messages
      // that arrived with it decrypt on the very next scan.
      const c = classify(req.invite);
      if (c?.kind === 'handshake') {
        let accepted;
        try {
          accepted = acceptHandshake(v.identity, decodeBody(c.raw));
        } catch {
          return { error: 'bad-invite' };
        }
        if (bytesToHex(fpOf(accepted.peerBundle)) === bytesToHex(v.identity.fingerprint)) return { error: 'thats-you' };
        // A session replayed out of another chat must not bind this one (same rule as ingest).
        const existing = v.sessions.find((s) => bytesToHex(s.id) === bytesToHex(accepted.session.id));
        if (existing?.threadId && existing.threadId !== req.threadId) return { error: 'bad-invite' };
        accepted.session.threadId = req.threadId;
        const contact = upsertContact(v, accepted.peerBundle, cleanLabel(req.label));
        v.threadBindings[req.threadId] = bytesToHex(contact.fingerprint);
        storeSession(v, accepted.session);
        await persist();
        return { ok: true, contact: contactView(contact, v.identity.fingerprint) };
      }
      const parsed = parseInviteOrError(v, req.invite);
      if ('error' in parsed) return parsed;
      const contact = upsertContact(v, parsed.bundle, cleanLabel(req.label));
      v.threadBindings[req.threadId] = bytesToHex(contact.fingerprint);
      await persist();
      return { ok: true, contact: contactView(contact, v.identity.fingerprint) };
    }

    case 'contacts': {
      const v = await getVault();
      if (!v) return { error: 'locked' };
      return { contacts: v.contacts.map((c) => contactView(c, v.identity.fingerprint)) };
    }

    case 'verifyContact': {
      const v = await getVault();
      if (!v) return { error: 'locked' };
      const c = findContact(v, req.fingerprint);
      if (!c) return { error: 'no-such-contact' };
      c.verified = true;
      await persist();
      return { ok: true, contact: contactView(c, v.identity.fingerprint) };
    }

    case 'renameContact': {
      const v = await getVault();
      if (!v) return { error: 'locked' };
      const c = findContact(v, req.fingerprint);
      if (!c) return { error: 'no-such-contact' };
      const label = cleanLabel(req.label);
      if (!label) return { error: 'empty-label' };
      c.label = label;
      await persist();
      return { ok: true, contact: contactView(c, v.identity.fingerprint) };
    }

    case 'removeContact': {
      const v = await getVault();
      if (!v) return { error: 'locked' };
      const before = v.contacts.length;
      v.contacts = v.contacts.filter((c) => bytesToHex(c.fingerprint) !== req.fingerprint);
      if (v.contacts.length === before) return { error: 'no-such-contact' };
      // Drop their sessions and any thread bindings so nothing keeps encrypting to them.
      v.sessions = v.sessions.filter((s) => bytesToHex(s.peerFingerprint) !== req.fingerprint);
      for (const tid of Object.keys(v.threadBindings))
        if (v.threadBindings[tid] === req.fingerprint) delete v.threadBindings[tid];
      await persist();
      return { ok: true };
    }

    case 'bindThread': {
      if (!isScopedThreadId(req.threadId)) return { error: 'bad-thread' };
      const v = await getVault();
      if (!v) return { error: 'locked' };
      if (!findContact(v, req.fingerprint)) return { error: 'no-such-contact' };
      if (req.auto) {
        // Recognition, not a click. It must never fight the user: an explicit off
        // (tombstone) stays off, and an existing binding — whoever's — stays.
        if (v.threadBindings[req.threadId] === '') return { error: 'opted-out' };
        if (v.threadBindings[req.threadId]) return { ok: true };
      }
      v.threadBindings[req.threadId] = req.fingerprint;
      await persist();
      return { ok: true };
    }

    case 'unbindThread': {
      if (!isScopedThreadId(req.threadId)) return { error: 'bad-thread' };
      const v = await getVault();
      if (!v) return { error: 'locked' };
      // '' is a tombstone, not a deletion: falsy for every "is it bound" check, but it
      // records "the user said no here" so handle recognition never re-binds an explicit off.
      v.threadBindings[req.threadId] = '';
      await persist();
      return { ok: true };
    }

    case 'getSettings': {
      const rec = await ext.storage.local.get([SITES_KEY, TAGLINE_KEY, DISCOVER_KEY, KEEP_UNLOCKED_PREF]);
      return {
        sites: (rec[SITES_KEY] as Record<string, boolean>) ?? {},
        sessionOff: [...(await sessionPaused())],
        tagline: (rec[TAGLINE_KEY] as boolean | undefined) ?? false,
        discover: (rec[DISCOVER_KEY] as boolean | undefined) ?? false,
        keepUnlocked: rec[KEEP_UNLOCKED_PREF] === true,
        directory: (await secureDirectoryUrl()) ?? undefined,
      };
    }

    case 'dirClaim': {
      const v = await getVault();
      if (!v) return { error: 'locked' };
      const username = String(req.username).toLowerCase();
      if (!USERNAME_RE.test(username)) return { error: 'bad-username' };
      if (v.username) return v.username === username ? { ok: true, username } : { error: 'username-exists', username: v.username };
      // A restored phrase-derived vault may already own this handle server-side even
      // though the string itself was not recoverable from the phrase. Recover it before
      // attempting a new first-claim write; a 404 means this is genuinely a new claim.
      if (v.mnemonic) {
        const recovered = await recoverHandleAuthed(recoveryIdentity(v.mnemonic));
        if (recovered.username) {
          v.username = recovered.username;
          await persist();
          return recovered;
        }
        if (recovered.error !== 'no-account') return recovered;
      }
      // Phrase-derived identity: authenticated claim (prove the key, register recovery anchor).
      // Legacy random identity (no phrase): fall back to the old unauthenticated claim.
      const claimed = v.mnemonic
        ? await claimHandleAuthed(v.identity, recoveryIdentity(v.mnemonic), username)
        : await claimUsernameRemote(v.identity.bundle, username);
      if (claimed.error) return claimed;
      v.username = username;
      await persist();
      return { ok: true, username };
    }

    // Who is @maya? Answers, and writes NOTHING. The popup renders the answer — the handle and the
    // security code that identifies their key — and adding is a separate, explicit tap. Looking
    // someone up should never be the same act as trusting them.
    case 'dirLookup': {
      const v = await getVault();
      if (!v) return { error: 'locked' };
      const username = String(req.username).toLowerCase();
      if (!USERNAME_RE.test(username)) return { error: 'bad-username' };
      const found = await directoryInvite(username);
      if ('error' in found) return { error: found.error };
      const parsed = parseInviteOrError(v, found.invite);
      if ('error' in parsed) {
        // A directory that answers with something that is not an invite is a broken directory, not
        // a user typo — but "thats-you" is worth passing through verbatim.
        return { error: parsed.error === 'not-an-invite' ? 'bad-invite' : parsed.error };
      }
      const fp = fpOf(parsed.bundle);
      return {
        ok: true,
        username,
        // Shaped like a contact so the popup can draw it with the code it already has — but it is
        // NOT one, and `verified` is false because nothing has been compared yet.
        contact: {
          fingerprint: bytesToHex(fp),
          label: `@${username}`,
          verified: false,
          safetyNumber: safetyNumber(v.identity.fingerprint, fp),
          fingerprintHex: fingerprintHex(fp),
        },
      };
    }

    case 'dirAdd': {
      const v = await getVault();
      if (!v) return { error: 'locked' };
      const username = String(req.username).toLowerCase();
      if (!USERNAME_RE.test(username)) return { error: 'bad-username' };
      const found = await directoryInvite(username);
      if ('error' in found) return { error: found.error };
      const parsed = parseInviteOrError(v, found.invite);
      if ('error' in parsed) {
        return { error: parsed.error === 'not-an-invite' ? 'bad-invite' : parsed.error };
      }
      const contact = upsertContact(v, parsed.bundle, username); // directory-resolved: label = @username
      await persist();
      return { ok: true, contact: contactView(contact, v.identity.fingerprint) };
    }

    case 'setSite': {
      const rec = await ext.storage.local.get(SITES_KEY);
      const sites = (rec[SITES_KEY] as Record<string, boolean>) ?? {};
      sites[req.platform] = req.enabled;
      await ext.storage.local.set({ [SITES_KEY]: sites });
      // The Home toggle is the master switch: turning a platform ON must also lift a
      // session pause, or the toggle reads "on" while the glyph stays gone.
      if (req.enabled) {
        const off = await sessionPaused();
        if (off.delete(req.platform)) {
          await ext.storage.session.set({ [SITES_SESSION_KEY]: [...off] });
          void broadcastSiteSession(req.platform, true);
        }
      }
      return { ok: true, sites };
    }

    case 'setSiteSession': {
      const off = await sessionPaused();
      if (req.enabled) off.delete(req.platform);
      else off.add(req.platform);
      await ext.storage.session.set({ [SITES_SESSION_KEY]: [...off] });
      void broadcastSiteSession(req.platform, req.enabled);
      return { ok: true, sessionOff: [...off] };
    }

    case 'setTagline': {
      await ext.storage.local.set({ [TAGLINE_KEY]: req.enabled });
      return { ok: true, tagline: req.enabled };
    }

    case 'setKeepUnlocked': {
      await ext.storage.local.set({ [KEEP_UNLOCKED_PREF]: req.enabled === true });
      if (req.enabled === true) {
        // Only a key that is actually live can be persisted; enabling while locked simply
        // takes effect at the next unlock.
        const m = await loadMaster();
        if (m) await ext.storage.local.set({ [LOCAL_MASTER]: b64uEncode(m) });
      } else {
        await ext.storage.local.remove(LOCAL_MASTER);
      }
      return { ok: true, keepUnlocked: req.enabled === true };
    }

    case 'setDirectory': {
      const raw = String(req.url ?? '').trim();
      if (!raw) {
        await ext.storage.local.remove(DIRECTORY_KEY);
        directoryBase = normalizeDirectory(DIRECTORY_URL);
        return { ok: true, directory: directoryBase ?? undefined };
      }
      const normalized = normalizeDirectory(raw);
      if (!normalized) return { error: 'directory-insecure' }; // https or nothing
      await ext.storage.local.set({ [DIRECTORY_KEY]: normalized });
      directoryBase = normalized;
      return { ok: true, directory: normalized };
    }

    case 'setDiscover': {
      if (req.enabled) {
        const v = await getVault();
        if (!v) return { error: 'locked' };
        if (!v.username) return { error: 'no-handle' };
      }
      await ext.storage.local.set({ [DISCOVER_KEY]: req.enabled });
      return { ok: true, discover: req.enabled };
    }

    case 'resolvePeer': {
      // The auto-discovery gate lives HERE, beside the network call — no caller can bypass it.
      const gate = await ext.storage.local.get(DISCOVER_KEY);
      if ((gate[DISCOVER_KEY] as boolean | undefined) !== true) return { error: 'discovery-off' };
      const v = await getVault();
      if (!v) return { error: 'locked' };
      if (!v.username) return { error: 'discovery-off' }; // anonymous mode never performs lookups
      const platform = String(req.platform).toLowerCase();
      const handle = canonHandle(platform, String(req.handle));
      if (!PLATFORM_RE.test(platform) || handle.length < 1 || handle.length > 100) return { error: 'bad-handle' };
      const directory = await secureDirectoryUrl();
      if (!directory) return { error: 'directory-insecure' };
      let invite: string;
      try {
        const r = await fetch(
          `${directory}/lookup?platform=${encodeURIComponent(platform)}&handle_hash=${handleHash(platform, handle)}`,
        );
        if (r.status === 404) return { error: 'not-found' };
        if (!r.ok) return { error: 'directory-error' };
        const found = (await r.json()) as { invite?: string; verified?: boolean };
        // Device-key proof does not prove ownership of an Instagram/Telegram/WhatsApp
        // account. Never turn an unverified first-claim mapping into an identity offer.
        if (found.verified !== true) return { error: 'unverified-handle' };
        invite = found.invite ?? '';
      } catch {
        return { error: 'directory-unreachable' };
      }
      const c = classify(invite);
      if (!c || c.kind !== 'invite') return { error: 'bad-invite' };
      let bundle: Uint8Array;
      try {
        bundle = decodeBody(c.raw);
        parseBundle(bundle);
      } catch {
        return { error: 'bad-invite' };
      }
      if (bytesToHex(fpOf(bundle)) === bytesToHex(v.identity.fingerprint)) return { error: 'thats-you' };
      // Persist NOTHING: a directory hit is an OFFER for the glyph. The explicit tap
      // (acceptInvite) is what adds the contact and binds the chat — never this lookup.
      return { ok: true, invite };
    }

    // Manually edit a contact's messenger handles. Empty value = remove; the whole map is
    // replaced after normalization (same canonical form as discovery, or recognition and
    // lookups would never match what sync or the adapters produce).
    case 'setContactHandles': {
      const v = await getVault();
      if (!v) return { error: 'locked' };
      const c = findContact(v, req.fingerprint);
      if (!c) return { error: 'unknown-contact' };
      const clean: Record<string, string> = {};
      for (const [p, h] of Object.entries(req.handles ?? {})) {
        const platform = String(p).toLowerCase();
        if (!PLATFORM_RE.test(platform)) return { error: 'bad-platform' };
        const handle = canonHandle(platform, String(h));
        if (!handle) continue;
        if (handle.length > 100) return { error: 'bad-handle' };
        clean[platform] = handle;
      }
      c.handles = Object.keys(clean).length ? clean : undefined;
      await persist();
      return { ok: true, contact: contactView(c, v.identity.fingerprint) };
    }

    case 'threadContact': {
      if (!isScopedThreadId(req.threadId)) return { error: 'bad-thread' };
      const v = await getVault();
      if (!v) {
        // Locked (or master stale): answer from the plain cache so the content script can
        // fail SAFE — block sends in a chat that encrypts — instead of going plaintext.
        const rec = await ext.storage.local.get([LINKED_CACHE, LOCAL_BLOB]);
        const cacheRaw = rec[LINKED_CACHE] as Record<string, true> | undefined;
        // A vault that predates the fail-safe feature has no cache at all until its first
        // unlock writes one. Until then report every chat as previously-linked: blocking
        // a send in an unlinked chat is friction, letting one through in a linked chat is
        // a plaintext leak.
        if (cacheRaw === undefined && rec[LOCAL_BLOB]) return { error: 'locked', wasLinked: true };
        const cache = cacheRaw ?? {};
        // One release of backwards compatibility for a locked v0.3 vault. Unlocking
        // rewrites this cache to hashes, so raw IDs disappear immediately afterwards.
        const legacyInstagramId = req.threadId.startsWith('instagram:') ? req.threadId.slice('instagram:'.length) : '';
        return {
          error: 'locked',
          wasLinked: cache[linkedCacheKey(req.threadId)] === true || (!!legacyInstagramId && cache[legacyInstagramId] === true),
        };
      }
      const fp = v.threadBindings[req.threadId];
      const c = fp ? findContact(v, fp) : undefined;
      return { contact: c ? contactView(c, v.identity.fingerprint) : null };
    }

    case 'changePassphrase': {
      const v = await getVault();
      if (!v) return { error: 'locked' };
      const rec = await ext.storage.local.get(LOCAL_BLOB);
      const blob = rec[LOCAL_BLOB] as VaultBlob | undefined;
      if (!blob) return { error: 'no-vault' };
      const oldM = await deriveMaster(req.oldPassphrase, b64uDecode(blob.salt));
      try {
        decryptVault(blob, oldM);
      } catch {
        return { error: 'wrong-passphrase' };
      }
      currentSalt = randomBytes(16);
      master = await deriveMaster(req.newPassphrase, currentSalt);
      await persistMaster(master);
      await persist(); // re-seals under the new salt+master
      return { ok: true };
    }

    case 'export': {
      const rec = await ext.storage.local.get(LOCAL_BLOB);
      const blob = rec[LOCAL_BLOB] as VaultBlob | undefined;
      if (!blob) return { error: 'no-vault' };
      return { invite: JSON.stringify(blob) };
    }

    case 'import': {
      let blob: VaultBlob;
      try {
        blob = JSON.parse(req.blob);
      } catch {
        return { error: 'bad-backup' };
      }
      const salt = b64uDecode(blob.salt);
      const m = await deriveMaster(req.passphrase, salt);
      try {
        vault = decryptVault(blob, m);
      } catch {
        return { error: 'wrong-passphrase' };
      }
      master = m;
      currentSalt = salt;
      migrateLegacyThreads(vault);
      await persist(); // re-seals the imported vault AND syncs the linked cache to it
      await persistMaster(m);
      return { ok: true, fingerprintHex: fingerprintHex(vault.identity.fingerprint) };
    }

    // --- The Ekko account + encrypted backup ---
    //
    // This is what makes the extension and the iOS app interchangeable: one account, one encrypted
    // blob, restorable either way. What leaves this machine is ciphertext under a passphrase that
    // never leaves it (core/backup.ts), so the account can hold the identity without being able to
    // read it.

    case 'acctStatus': {
      const s = await getAccountSession();
      if (!s) return { signedIn: false };
      try {
        const blob = await fetchBackup(s);
        // The handle is garnish here — a profile hiccup must not erase the backup answer,
        // which the restore flow makes decisions on.
        const profile = await myProfile(s).catch(() => null);
        return {
          signedIn: true,
          email: emailOf(s) ?? undefined,
          handle: profile?.handle,
          hasBackup: blob !== null,
          // Meaningful only while unlocked (the key lives inside the vault); the popup's
          // identity tab is only reachable unlocked, so that is the consumer.
          autoBackup: !!(await getVault())?.backup,
        };
      } catch {
        // Offline, or the session died. Say we are signed in but could not check — never claim
        // "no backup" on a failed lookup, or the popup invites the user to overwrite a good one.
        return { signedIn: true, email: emailOf(s) ?? undefined };
      }
    }

    case 'acctSendCode': {
      try {
        await sendCode(req.email.trim());
        return { ok: true };
      } catch (e) {
        return { error: (e as Error).message };
      }
    }

    case 'acctVerify': {
      try {
        const s = await verifyCode(req.email.trim(), req.code);
        await setAccountSession(s);
        return { ok: true, signedIn: true, email: emailOf(s) ?? undefined };
      } catch (e) {
        return { error: (e as Error).message };
      }
    }

    // Start the Google flow. Safari has no `browser.identity`, so this cannot be a
    // launchWebAuthFlow — it is a plain tab pointed at the same authorize URL the account page's
    // own Google button uses, landing back on a redirect target Supabase already allows. Arming
    // the handoff here, next to the state it protects, means no caller can skip the gate.
    case 'acctGoogle': {
      await ext.storage.session.set({ [ACCOUNT_AWAIT]: Date.now() });
      const url =
        `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=` +
        encodeURIComponent(ACCOUNT_PAGE) + '&prompt=select_account';
      await ext.tabs.create({ url });
      return { ok: true };
    }

    // The account page handing us the session it just got from Google (src/content/account-bridge.ts).
    //
    // Two gates, because this request carries a bearer token and arrives from a WEB PAGE:
    //   1. It must come from the account page's exact origin. A content script is the only thing
    //      that can claim that origin, and we only ever inject one there.
    //   2. We must have ASKED for it, recently. Otherwise merely opening account.useekko.app would
    //      silently sign the extension in — and worse, a session the user did not choose could be
    //      pushed at us. The flag is memory-only and one-shot.
    // Even past both gates the blast radius is small: an attacker who forced a session of THEIR
    // account onto this extension would receive backups sealed under a passphrase they do not have,
    // and a restore would fail to open. Bounded, but not a reason to be careless.
    case 'acctAdoptSession': {
      const origin =
        sender?.origin ?? (sender?.url ? new URL(sender.url).origin : null);
      if (origin !== new URL(ACCOUNT_PAGE).origin) return { error: 'bad-origin' };

      const rec = await ext.storage.session.get(ACCOUNT_AWAIT);
      const asked = rec[ACCOUNT_AWAIT] as number | undefined;
      await ext.storage.session.remove(ACCOUNT_AWAIT); // one-shot, whatever happens next
      if (!asked || Date.now() - asked > ACCOUNT_AWAIT_MS) return { error: 'not-expected' };

      const { accessToken, refreshToken, expiresAt } = req.session ?? {};
      if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
        return { error: 'bad-session' };
      }
      // Trust the tokens, not the clock the page reported: a bad expiry only ever means a needless
      // refresh, and validSession will do that on first use anyway.
      const expires = Number.isFinite(expiresAt) ? expiresAt : Date.now();
      await setAccountSession({ accessToken, refreshToken, expiresAt: expires });
      return { ok: true, signedIn: true, email: emailOf({ accessToken, refreshToken, expiresAt: expires }) ?? undefined };
    }

    // The account @handle: a session IS the registration, and there is deliberately no claim
    // without one. Success mirrors the handle into the vault's display username only when that
    // slot is empty — dirClaim's directory handle owns it otherwise, and the two handle systems
    // stay unbridged.
    case 'acctClaim': {
      const s = await getAccountSession();
      if (!s) return { error: 'signed-out' };
      const handle = String(req.handle).toLowerCase();
      if (!USERNAME_RE.test(handle)) return { error: 'bad-username' };
      try {
        const p = await acctClaimHandle(s, handle);
        const v = await getVault();
        if (v && !v.username) {
          v.username = p.handle;
          await persist();
        }
        return { ok: true, handle: p.handle };
      } catch (e) {
        return { error: (e as Error).message };
      }
    }

    // The account sync loop lives in syncAccount above; it also runs from the ingest
    // self-heal when a message names a session whose setup is waiting in the mailbox.
    case 'acctSync': {
      const s = await getAccountSession();
      if (!s) return { error: 'signed-out' };
      const v = await getVault();
      if (!v) return { error: 'locked' };
      try {
        return await syncAccount(v, s);
      } catch (e) {
        return { error: (e as Error).message };
      }
    }

    // Answer a connection request. Accepting immediately re-syncs: consent is the moment
    // RLS reveals the requester's key, linked socials and staged session setup — so one
    // tap ends with them encryptable, not with a second "now sync" chore.
    case 'acctAccept': {
      const s = await getAccountSession();
      if (!s) return { error: 'signed-out' };
      const v = await getVault();
      if (!v) return { error: 'locked' };
      try {
        await acceptConnection(s, req.connectionId);
        return await syncAccount(v, s);
      } catch (e) {
        return { error: (e as Error).message };
      }
    }

    case 'acctDecline': {
      const s = await getAccountSession();
      if (!s) return { error: 'signed-out' };
      try {
        await declineConnection(s, req.connectionId);
        return { ok: true };
      } catch (e) {
        return { error: (e as Error).message };
      }
    }

    case 'acctSignOut': {
      await setAccountSession(null);
      return { ok: true, signedIn: false };
    }

    case 'acctBackup': {
      const v = await getVault();
      if (!v) return { error: 'locked' };
      if (!v.mnemonic) return { error: 'no-phrase' }; // legacy random identity: nothing to restore FROM
      const s = await getAccountSession();
      if (!s) return { error: 'not-signed-in' };
      try {
        const bk = newBackupKey(req.backupPassphrase);
        await uploadBackup(s, sealBackupWithKey(backupPayloadOf(v), bk.key, bk.salt, bk.iter));
        // From here on backups are automatic: the derived KEY (never the passphrase) lives
        // in the vault, and every persist re-seals a current blob under it.
        v.backup = bk;
        await persist();
        return { ok: true, hasBackup: true };
      } catch (e) {
        return { error: (e as Error).message };
      }
    }

    case 'acctRestore': {
      // Refuse to clobber an identity that already exists here. Same guard as importIdentity:
      // silently replacing a vault is how someone loses the only copy of their keys.
      if ((await ext.storage.local.get(LOCAL_BLOB))[LOCAL_BLOB]) return { error: 'vault-exists' };
      const s = await getAccountSession();
      if (!s) return { error: 'not-signed-in' };
      try {
        const blob = await fetchBackup(s);
        if (!blob) return { error: 'no-backup' };
        const payload = openBackup(blob, req.backupPassphrase); // throws on the wrong passphrase
        const mnemonic = normalizeMnemonic(payload.mnemonic);
        if (!isValidMnemonic(mnemonic)) return { error: 'bad-phrase' };

        const identity = deviceIdentity(mnemonic, 0);
        const salt = randomBytes(16);
        const m = await deriveMaster(req.passphrase, salt);
        currentSalt = salt;
        master = m;

        // Contacts come back with their original addedAt and verified flag intact. The
        // fingerprint is derived, not carried: recomputing it here means a tampered bundle
        // can never arrive with a fingerprint that lies about it.
        const restored: Contact[] = payload.contacts
          .map((c) => {
            const bundle = b64uDecode(c.bundle);
            return {
              bundle,
              fingerprint: fpOf(bundle),
              label: c.label,
              verified: c.verified,
              addedAt: c.addedAt,
            };
          })
          .filter((c) => b64uEncode(c.bundle) !== b64uEncode(identity.bundle));

        // Sessions come back too — they are the only capability that reads history (an older
        // blob simply has none). Per-entry defensive: one corrupt row must not sink the
        // restore, and the byte lengths are checked so a malformed key can't sit in the vault
        // masquerading as a channel.
        const sessions: Session[] = (payload.sessions ?? []).flatMap((s) => {
          try {
            const one: Session = {
              id: b64uDecode(s.id),
              key0to1: b64uDecode(s.key0to1),
              key1to0: b64uDecode(s.key1to0),
              myParty: s.myParty === 1 ? 1 : 0,
              peerFingerprint: b64uDecode(s.peerFingerprint),
              threadId: typeof s.threadId === 'string' ? s.threadId : undefined,
              acct: s.acct === true ? true : undefined,
            };
            const sane = one.id.length === 8 && one.key0to1.length === 32 && one.key1to0.length === 32 && one.peerFingerprint.length === 32;
            return sane ? [one] : [];
          } catch {
            return [];
          }
        });
        // The restore is the moment this device learns the passphrase — turn it into the
        // stored key, so this device keeps the account's backup current from now on too.
        vault = {
          identity,
          mnemonic,
          contacts: restored,
          sessions,
          threadBindings: {},
          backup: { key: backupKeyOf(blob, req.backupPassphrase), salt: blob.salt, iter: blob.iter },
        };
        // The backup blob carries keys and contacts, not the @handle string — but this account
        // owns one server-side (the "You are @you" onboarding reads it from the same profile).
        // Adopt it so the popup's Identity tab shows @you instead of an empty claim prompt right
        // after restore. Best effort: a profile hiccup just leaves it blank, as before.
        const profile = await myProfile(s).catch(() => null);
        // USERNAME_RE mirrors the phrase path (recoverHandleAuthed validates there): the vault
        // never adopts a server string the claim flow could not have produced.
        if (profile?.handle && USERNAME_RE.test(profile.handle)) vault.username = profile.handle;
        await persistMaster(m);
        await persist();
        return {
          ok: true,
          fingerprintHex: fingerprintHex(identity.fingerprint),
          restoredContacts: restored.length,
        };
      } catch (e) {
        return { error: (e as Error).message };
      }
    }

    case 'acctDeleteBackup': {
      const s = await getAccountSession();
      if (!s) return { error: 'not-signed-in' };
      try {
        await deleteBackup(s);
        // Forget the auto-backup key too, or the next vault change would quietly resurrect
        // the copy the user just deleted.
        const v = await getVault();
        if (v?.backup) {
          delete v.backup;
          await persist();
        }
        await ext.storage.local.remove(BACKUP_DIRTY);
        return { ok: true, hasBackup: false };
      } catch (e) {
        return { error: (e as Error).message };
      }
    }

    case 'encrypt':
    case 'manualEncrypt': {
      if (!isScopedThreadId(req.threadId)) return { error: 'bad-thread' };
      if (req.type === 'manualEncrypt' && sender?.tab) return { error: 'manual-only' };
      const v = await getVault();
      if (!v) return { error: 'locked' };
      // Page encryption uses an explicit binding. The popup selects its recipient in this
      // same request so a failed or interleaved bind can never encrypt to a stale contact.
      const fp = req.type === 'manualEncrypt' ? req.fingerprint : v.threadBindings[req.threadId];
      if (!fp) return { error: 'no-contact' };
      const contact = findContact(v, fp);
      if (!contact) return { error: 'no-contact' };
      if (req.type === 'manualEncrypt') v.threadBindings[req.threadId] = fp;
      // ponytail: replay setup until authenticated peer traffic arrives; add delivery
      // receipts only if the extra first-contact chunks become a measured problem.
      const tokens = await sendTokens(v, contact, fp, req.threadId, req.plaintext);
      await persist();
      return { ok: true, tokens };
    }

    case 'sealFor': {
      // In-page manual seal ("Seal for a contact" on an unrecognized surface, or any page via
      // the keyboard shortcut). Unlike manualEncrypt this IS allowed from a tab: the recipient
      // is an explicit user pick inside Ekko's own closed-shadow UI, the plaintext is what the
      // user typed on the page, and nothing here reads or writes thread bindings — a page
      // context still can never bind a chat to a contact.
      const v = await getVault();
      if (!v) return { error: 'locked' };
      const fp = String(req.fingerprint);
      const contact = findContact(v, fp);
      if (!contact) return { error: 'no-contact' };
      const tokens = await sendTokens(v, contact, fp, null, req.plaintext);
      await persist();
      return { ok: true, tokens };
    }

    case 'ingest': {
      if (!isScopedThreadId(req.threadId)) return { error: 'bad-thread' };
      // A page content script must never opt out of explicit contact binding. The popup's
      // paste/decrypt tool is an extension page (no sender.tab) and is user initiated.
      if (req.manual && sender?.tab) return { error: 'manual-only' };
      const v = await getVault();
      if (!v) return { error: 'locked' };
      if (req.kind === 'chunk') return { error: 'bad-token' }; // callers reassemble first
      let body: Uint8Array;
      try {
        body = decodeBody(req.raw);
      } catch {
        return { error: 'bad-token' };
      }

      if (req.kind === 'handshake') {
        // Our own handshake echoes back in the thread. The sender bundle rides in cleartext,
        // so recognize ourselves BEFORE the binding gate — an unlinked chat must read our own
        // echo as ours, never surface it back as an incoming chat request.
        if (bytesToHex(fpOf(body.slice(1, 1 + v.identity.bundle.length))) === bytesToHex(v.identity.fingerprint)) return { ok: true };
        if (!req.manual && !v.threadBindings[req.threadId]) return { error: 'no-contact' };
        let accepted;
        try {
          accepted = acceptHandshake(v.identity, body);
        } catch {
          return { error: 'bad-handshake' };
        }
        const existing = v.sessions.find((s) => bytesToHex(s.id) === bytesToHex(accepted.session.id));
        if (existing?.threadId && existing.threadId !== req.threadId) {
          if (req.manual) return { ok: true }; // explicit popup fallback may read any copied session
          return { error: 'wrong-thread' };
        }
        accepted.session.threadId = req.threadId;
        return ingestPeerBundle(v, req.threadId, accepted.peerBundle, cleanLabel(req.peerLabel), accepted.session, req.manual);
      }

      if (req.kind === 'invite') {
        // Same early self-recognition for our own echoed invite (see the handshake path).
        if (bytesToHex(fpOf(body)) === bytesToHex(v.identity.fingerprint)) return { ok: true };
        if (!req.manual && !v.threadBindings[req.threadId]) return { error: 'no-contact' };
        try {
          parseBundle(body);
        } catch {
          return { error: 'bad-invite' };
        }
        return ingestPeerBundle(v, req.threadId, body, cleanLabel(req.peerLabel), undefined, req.manual);
      }

      // message
      const sid = readSessionId(body);
      if (!sid) return { error: 'bad-token' };
      const hex = bytesToHex(sid);
      let session = v.sessions.find((s) => bytesToHex(s.id) === hex);
      // An unknown session's setup may be sitting in the account mailbox (an iOS sender
      // never puts it in the chat). Pull once, then look again.
      if (!session) session = await adoptStagedSession(v, hex);
      if (!session) {
        // Dead vs pending, said honestly: the chat is bound to a contact we DO hold a live
        // session with, yet this message names a different one — it was sealed under an older
        // channel whose mailbox row was since replaced (sessions never leave devices, so
        // nothing can resurrect it). Still retried upstream: within the mailbox-pull debounce
        // this could be a rotation we haven't pulled yet, and the next adopt re-classifies.
        const boundTo = v.threadBindings[req.threadId];
        const heldForPeer = boundTo && v.sessions.some((s) => bytesToHex(s.peerFingerprint) === boundTo);
        return { error: !req.manual && heldForPeer ? 'old-session' : 'no-session' };
      }
      const bound = v.threadBindings[req.threadId];
      if (!req.manual && !bound) {
        // The vault knows who this session belongs to even though the chat isn't linked —
        // name them, so the glyph can offer the one-tap link instead of dead-ending. This
        // is the manual-seal landing path (both the sender's own bubble and the reply).
        const from = findContact(v, bytesToHex(session.peerFingerprint));
        return { error: 'no-contact', contact: from ? contactView(from, v.identity.fingerprint) : undefined };
      }
      if (!req.manual && session.threadId && session.threadId !== req.threadId) return { error: 'wrong-thread' };
      // Enforce sender identity for page-driven reads. The popup's explicit paste/decrypt
      // tool may read a copied token even when its reusable manual-send context is bound
      // to somebody else.
      if (!req.manual && bound && bound !== bytesToHex(session.peerFingerprint)) return { error: 'wrong-peer' };
      let plaintext: string;
      try {
        plaintext = openMessage(session, body);
      } catch {
        return { error: 'decrypt-failed' };
      }
      // A valid message from the other canonical party proves they received this session's
      // setup. Own echoed bubbles do not count — a failed first send can echo locally.
      if (!req.manual && session.handshakeWire && (body[1]! & 1) !== session.myParty) {
        delete session.handshakeWire;
        await persist();
      }
      return { ok: true, plaintext };
    }

    // Is a newer Ekko out? Store installs auto-update on their own, but the GitHub zip,
    // the unpacked dev build and the Safari container app do not — they'd silently rot
    // (today's WhatsApp LID drift broke exactly those installs with no way to know). One
    // anonymous GET against the public releases list, cached a day; the popup shows a
    // quiet notice, never an interruption.
    case 'updateCheck': {
      const current = ext.runtime.getManifest().version;
      const cached = (await ext.storage.local.get(UPDATE_KEY))[UPDATE_KEY] as { at: number; latest: string } | undefined;
      let latest = cached?.latest ?? current;
      if (!cached || Date.now() - cached.at > UPDATE_CHECK_EVERY_MS) {
        try {
          const r = await fetch('https://api.github.com/repos/useekko/ekko-core/releases?per_page=10');
          if (r.ok) {
            const list = (await r.json()) as { tag_name?: string; draft?: boolean; prerelease?: boolean }[];
            // Skip the rolling `nightly` tag and drafts: only a real vX.Y.Z counts.
            const hit = list.find((x) => !x.draft && !x.prerelease && /^v?\d+\.\d+\.\d+$/.test(x.tag_name ?? ''));
            if (hit) {
              latest = hit.tag_name!.replace(/^v/, '');
              await ext.storage.local.set({ [UPDATE_KEY]: { at: Date.now(), latest } });
            }
          }
        } catch {
          /* offline: answer from the cache (or say "current"), never an error state */
        }
      }
      const updateAvailable = newerVersion(latest, current);
      // Nudge the store's own updater where one exists; sideloads rely on the notice.
      if (updateAvailable) {
        try {
          void (ext.runtime as { requestUpdateCheck?: () => Promise<unknown> }).requestUpdateCheck?.();
        } catch {
          /* not available on this browser/install kind */
        }
      }
      return { ok: true, current, latest, updateAvailable };
    }

    case 'openPopup': {
      // The glyph's "Unlock Ekko" — the popup is the only place the passphrase is
      // ever typed (never an in-page field: key events leak out of shadow roots).
      try {
        await ext.action.openPopup();
        return { ok: true };
      } catch {
        return { error: 'no-popup' }; // API unavailable/no gesture — caller shows a hint
      }
    }
  }
}

ext.runtime.onMessage.addListener((req: Req, sender, sendResponse) => {
  handle(req, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String((e as Error)?.message ?? e) }));
  return true; // async response
});

// First install: open the full-tab onboarding experience (create/import, passphrase, back up
// your recovery phrase, claim a handle) rather than leaving the user to find the tiny popup.
ext.runtime.onInstalled?.addListener((details) => {
  if (details.reason === 'install') void ext.tabs.create({ url: ext.runtime.getURL('onboarding.html') });
});

// The seal-anywhere shortcut (⌘⇧E / Ctrl+Shift+E): open the in-page "Seal for a contact"
// flow on the active tab. A tab already running our content script answers the message
// itself; any other page gets the standalone overlay injected — legal without host
// permissions exactly because the user pressed the shortcut (activeTab). Pages scripts
// can't touch (chrome://, the store) fall back to opening the popup's manual tools.
ext.commands?.onCommand.addListener((cmd: string, tab?: chrome.tabs.Tab) => {
  if (cmd !== 'seal-anywhere' || !tab?.id) return;
  void (async (tabId: number) => {
    const res = (await ext.tabs.sendMessage(tabId, { type: 'sealAnywhere' }).catch(() => null)) as { ok?: boolean } | null;
    if (res?.ok) return;
    try {
      await ext.scripting.executeScript({ target: { tabId }, files: ['manual.js'] });
    } catch {
      try {
        await ext.action.openPopup();
      } catch {
        /* no gesture context left — nothing sane to do */
      }
    }
  })(tab.id);
});
