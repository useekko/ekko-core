// Encrypted key backup: the blob that may sit on a server without the server learning anything.
//
// The point of this file is a single property: **what we upload is opaque to whoever stores it.**
// Not opaque by policy, or by a promise in a privacy page, but because the key that opens it is
// derived from a passphrase that never leaves the device. A stolen database, a rogue admin, a
// subpoena and a compromised Google account all get the same thing out of it: noise.
//
// That property is also what makes the "prove the production server runs the code on GitHub"
// project unnecessary. You do not have to trust a server that cannot read what it holds.
//
// KDF is PBKDF2-HMAC-SHA256, not the scrypt the local vault uses (vault.ts). Two reasons, and the
// tradeoff is real so it is written down rather than buried:
//   - It has to run natively on BOTH sides. CryptoKit and swift-crypto ship no scrypt, and porting
//     it means hand-writing Salsa20/8 — this project hand-rolls crypto in exactly one place
//     (XChaCha, because it had to) and that is one place too many already.
//   - PBKDF2 is NOT memory-hard, so it is weaker per dollar against a GPU farm than scrypt is.
//     The answer is to stop relying on the KDF: `generatePassphrase()` mints SIX random words
//     (~77 bits), against which no KDF speed matters. A user-chosen passphrase is allowed, and is
//     the weak path — which is why the UI defaults to the generated one.
//
// ponytail: PBKDF2-600k + high-entropy passphrase. If we ever need to defend a WEAK user-chosen
// passphrase against an offline attacker, that is the moment to port scrypt or take an Argon2id
// dependency — not before.
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { wordlist } from '@scure/bip39/wordlists/english';
import { b64uEncode, b64uDecode } from './b64.js';

/** Bumped only for a format change that older clients cannot read. */
export const BACKUP_VERSION = 1;

/** OWASP's 2023 floor for PBKDF2-HMAC-SHA256. ~0.3s on a phone. */
export const PBKDF2_ITERATIONS = 600_000;

const KDF = 'pbkdf2-sha256';

export interface BackupBlob {
  v: number;
  kdf: string;
  iter: number;
  salt: string; // b64url
  nonce: string; // b64url, 24 bytes (XChaCha)
  ct: string; // b64url
}

/** A session, as it travels inside the blob (bytes as base64url — the vault's own wire shape,
 *  minus handshakeWire, which is pending-setup replay state, not history capability). threadId
 *  and acct ride along verbatim: a restored thread-less session without its `acct` marker would
 *  be quarantined as a legacy artifact by the thread migration. */
export interface BackupSession {
  id: string;
  key0to1: string;
  key1to0: string;
  myParty: number;
  peerFingerprint: string;
  threadId?: string;
  acct?: boolean;
}

/** What is actually inside the blob. `sessions` is optional both ways: blobs sealed by older
 *  clients open without it, and clients that don't understand it ignore the field. */
export interface BackupPayload {
  v: number;
  mnemonic: string;
  contacts: { bundle: string; label: string; verified: boolean; addedAt: number }[];
  sessions?: BackupSession[];
}

export class BackupError extends Error {}

/**
 * Six words from the BIP39 list: ~77 bits, which is past the point where any attacker cares how
 * fast the KDF is. Reuses the wordlist the recovery phrase already ships, so it adds nothing to
 * the bundle and the words are ones the user has already been taught to write down.
 */
export function generatePassphrase(words = 6): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    // 2048 divides 65536 exactly, so masking two random bytes to 11 bits is uniform over the
    // wordlist — no modulo bias, and no rejection loop needed to avoid it.
    const b = randomBytes(2);
    out.push(wordlist[(((b[0] as number) << 8) | (b[1] as number)) & 0x7ff] as string);
  }
  return out.join(' ');
}

/** Anything shorter than this, chosen by a human, is not worth encrypting with. */
export const MIN_PASSPHRASE_LENGTH = 12;

function deriveKey(passphrase: string, salt: Uint8Array, iter: number): Uint8Array {
  return pbkdf2(sha256, new TextEncoder().encode(passphrase.normalize('NFKC')), salt, {
    c: iter,
    dkLen: 32,
  });
}

/**
 * The KDF parameters are authenticated as AAD, not merely stored beside the ciphertext. Without
 * this, an attacker who can rewrite the row could hand a client back `iter: 1` and have it still
 * decrypt — the client would derive a trivially brute-forcible key and never notice. Binding them
 * makes any edit to the header an authentication failure.
 */
function header(v: number, kdf: string, iter: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v, kdf, iter }));
}

/**
 * Seal the identity (as its 24 words), the contact list, and the session keys.
 *
 * Sessions were originally excluded ("both sides re-establish from a fresh handshake") — that
 * rationale was wrong in practice: a fresh handshake opens a NEW channel, and history sealed
 * under the old one dies with it (2026-07: the "waiting for the secure channel" graveyard).
 * Sessions are the only capability that reads past messages, they are ~100 bytes each and
 * capped at four per peer, and the blob already carries the mnemonic — the master secret — so
 * including them adds no new exposure class.
 */
export function sealBackup(payload: Omit<BackupPayload, 'v'>, passphrase: string): BackupBlob {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new BackupError(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const key = deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const body: BackupPayload = { v: BACKUP_VERSION, ...payload };
  const aad = header(BACKUP_VERSION, KDF, PBKDF2_ITERATIONS);
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(
    new TextEncoder().encode(JSON.stringify(body)),
  );
  return {
    v: BACKUP_VERSION,
    kdf: KDF,
    iter: PBKDF2_ITERATIONS,
    salt: b64uEncode(salt),
    nonce: b64uEncode(nonce),
    ct: b64uEncode(ct),
  };
}

/** Throws BackupError on a wrong passphrase, a tampered blob, or a format we do not know. */
export function openBackup(blob: BackupBlob, passphrase: string): BackupPayload {
  if (blob.v !== BACKUP_VERSION) {
    throw new BackupError(`This backup was written by a newer version of Ekko (v${blob.v}).`);
  }
  if (blob.kdf !== KDF) throw new BackupError(`Unknown key derivation: ${blob.kdf}`);
  // A hostile row could ask for a billion iterations and hang the phone instead of failing.
  if (!Number.isInteger(blob.iter) || blob.iter < 1 || blob.iter > 10_000_000) {
    throw new BackupError('This backup has an unusable iteration count.');
  }
  const key = deriveKey(passphrase, b64uDecode(blob.salt), blob.iter);
  const aad = header(blob.v, blob.kdf, blob.iter);
  let pt: Uint8Array;
  try {
    pt = xchacha20poly1305(key, b64uDecode(blob.nonce), aad).decrypt(b64uDecode(blob.ct));
  } catch {
    // Poly1305 cannot tell "wrong key" from "tampered": both are a failed tag. The wrong key is
    // overwhelmingly the likely one, so say that, and do not imply the server attacked them.
    throw new BackupError('That passphrase does not open this backup.');
  }
  const o = JSON.parse(new TextDecoder().decode(pt)) as BackupPayload;
  if (!o?.mnemonic) throw new BackupError('This backup is missing its recovery phrase.');
  return o;
}
