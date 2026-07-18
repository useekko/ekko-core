// At-rest vault: identity secrets + contacts + sessions, encrypted under a
// scrypt(passphrase)-derived master key. scrypt runs only at create/unlock; the fast
// XChaCha layer re-seals on every change using the cached master.
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { b64uEncode, b64uDecode } from './b64.js';
import { parseBundle, type Identity, type Session } from './crypto.js';

export interface Contact {
  bundle: Uint8Array;
  fingerprint: Uint8Array;
  label: string;
  verified: boolean;
  addedAt: number;
  // A connected peer's linked messenger handles (platform -> handle, normalized), learned from
  // their account_handles when connections sync. Lets a messenger chat bind to this contact by
  // handle instead of a mis-hittable display name. See background acctSync.
  handles?: Record<string, string>;
  // The peer's account user_id, stamped when this contact comes from an account connection.
  // Contacts are keyed by cryptographic fingerprint, but an account is one identity across key
  // rotations — this is the durable link that lets a re-keyed peer fold into their existing
  // contact instead of spawning a look-alike. Absent for manually-added (invite/QR) contacts.
  userId?: string;
}

export interface VaultData {
  identity: Identity;
  username?: string;
  // The 24-word recovery phrase (present for phrase-derived identities; absent for legacy
  // random ones). Encrypted at rest like everything else here. It is the seed the identity
  // and recovery key derive from — showing it to the user is the "back up now" flow.
  mnemonic?: string;
  // My linked socials (platform -> handle, normalized): a read-only mirror of the account's
  // account_handles, refreshed on acctSync. Managed on the account (the phone, the account
  // page) — the extension only displays them.
  platformHandles?: Record<string, string>;
  contacts: Contact[];
  sessions: Session[];
  threadBindings: Record<string, string>; // threadId -> peer fingerprint (hex)
}

export interface VaultBlob {
  salt: string;
  nonce: string;
  ct: string;
}

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 } as const;

export async function deriveMaster(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  return scryptAsync(new TextEncoder().encode(passphrase.normalize('NFKC')), salt, SCRYPT);
}

// --- (de)serialization: Uint8Array <-> base64url in a plain JSON envelope ---

function serialize(v: VaultData): string {
  return JSON.stringify({
    username: v.username,
    mnemonic: v.mnemonic,
    platformHandles: v.platformHandles,
    identity: {
      xPriv: b64uEncode(v.identity.xPriv),
      kPriv: b64uEncode(v.identity.kPriv),
      bundle: b64uEncode(v.identity.bundle),
    },
    contacts: v.contacts.map((c) => ({
      bundle: b64uEncode(c.bundle),
      label: c.label,
      verified: c.verified,
      addedAt: c.addedAt,
      handles: c.handles,
      userId: c.userId,
    })),
    sessions: v.sessions.map((s) => ({
      id: b64uEncode(s.id),
      key0to1: b64uEncode(s.key0to1),
      key1to0: b64uEncode(s.key1to0),
      myParty: s.myParty,
      peerFingerprint: b64uEncode(s.peerFingerprint),
      threadId: s.threadId,
      acct: s.acct,
      handshakeWire: s.handshakeWire && b64uEncode(s.handshakeWire),
    })),
    threadBindings: v.threadBindings,
  });
}

function deserialize(json: string): VaultData {
  const o = JSON.parse(json);
  const bundle = b64uDecode(o.identity.bundle);
  const pub = parseBundle(bundle);
  const identity: Identity = {
    xPriv: b64uDecode(o.identity.xPriv),
    xPub: pub.xPub,
    kPriv: b64uDecode(o.identity.kPriv),
    kPub: pub.kPub,
    bundle,
    fingerprint: sha256(bundle),
  };
  const contacts: Contact[] = o.contacts.map((c: any) => {
    const b = b64uDecode(c.bundle);
    return {
      bundle: b,
      fingerprint: sha256(b),
      label: c.label,
      verified: c.verified,
      addedAt: c.addedAt,
      handles: c.handles && typeof c.handles === 'object' ? c.handles : undefined,
      userId: typeof c.userId === 'string' ? c.userId : undefined,
    };
  });
  const sessions: Session[] = o.sessions.map((s: any) => ({
    id: b64uDecode(s.id),
    key0to1: b64uDecode(s.key0to1),
    key1to0: b64uDecode(s.key1to0),
    myParty: s.myParty,
    peerFingerprint: b64uDecode(s.peerFingerprint),
    threadId: typeof s.threadId === 'string' ? s.threadId : undefined,
    acct: s.acct === true ? true : undefined,
    handshakeWire: typeof s.handshakeWire === 'string' ? b64uDecode(s.handshakeWire) : undefined,
  }));
  return {
    identity,
    username: typeof o.username === 'string' ? o.username : undefined,
    mnemonic: typeof o.mnemonic === 'string' ? o.mnemonic : undefined,
    platformHandles: o.platformHandles && typeof o.platformHandles === 'object' ? o.platformHandles : undefined,
    contacts,
    sessions,
    threadBindings: o.threadBindings ?? {},
  };
}

// --- fast layer: encrypt/decrypt an already-derived vault under the master key ---

export function encryptVault(data: VaultData, master: Uint8Array, salt: Uint8Array): VaultBlob {
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(master, nonce).encrypt(new TextEncoder().encode(serialize(data)));
  return { salt: b64uEncode(salt), nonce: b64uEncode(nonce), ct: b64uEncode(ct) };
}

export function decryptVault(blob: VaultBlob, master: Uint8Array): VaultData {
  const pt = xchacha20poly1305(master, b64uDecode(blob.nonce)).decrypt(b64uDecode(blob.ct));
  return deserialize(new TextDecoder().decode(pt));
}
