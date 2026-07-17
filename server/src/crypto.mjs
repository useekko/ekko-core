// Directory-side crypto for authenticated publish + key ownership proofs. Zero dependencies:
// Node's built-in X25519 (node:crypto) interoperates with the extension's @noble X25519, so
// a client proves control of its private key by ECDH against a server ephemeral — no signing
// key, no change to the encrypted payload format. Public keys only ever cross the wire.
import { generateKeyPairSync, diffieHellman, createPublicKey, createHash, timingSafeEqual, randomBytes } from 'node:crypto';

const SPKI = Buffer.from('302a300506032b656e032100', 'hex'); // X25519 SPKI DER prefix (RFC 8410)
const BUNDLE_LEN = 1217; // version(1) ‖ x25519_pub(32) ‖ mlkem768_pub(1184)

// The raw 32-byte X25519 public key inside a published identity bundle, or null if malformed.
export function bundleXPub(bundle) {
  const b = Buffer.isBuffer(bundle) ? bundle : Buffer.from(bundle);
  if (b.length !== BUNDLE_LEN || b[0] !== 1) return null;
  return b.subarray(1, 33);
}

const rawToPub = (raw) => createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(raw)]), format: 'der', type: 'spki' });
const pubToRaw = (ko) => new Uint8Array(ko.export({ type: 'spki', format: 'der' })).subarray(12);

export function sha256(bytes) {
  return new Uint8Array(createHash('sha256').update(Buffer.from(bytes)).digest());
}

// Issue an ownership challenge for a raw X25519 pubkey. Returns the ephemeral public to hand
// the client and the expected proof to store; only the holder of the matching private key can
// reproduce `expected` (== the client's answerKeyChallenge output).
export function makeChallenge(xpubRaw) {
  const eph = generateKeyPairSync('x25519');
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: rawToPub(xpubRaw) });
  return { ephPub: pubToRaw(eph.publicKey), expected: sha256(new Uint8Array(shared)) };
}

// Constant-time proof check.
export function verifyProof(expected, proof) {
  const a = Buffer.from(expected);
  const b = Buffer.from(proof);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newChallengeId() {
  return randomBytes(16).toString('hex');
}

// Discovery lookups are keyed on a hash of the platform handle, not the plaintext. This keeps
// raw handles out of storage but does not prevent dictionary guesses; see DIRECTORY.md.
export function handleHash(platform, handle) {
  const norm = String(platform).toLowerCase() + ':' + String(handle).toLowerCase().replace(/^@/, '');
  return Buffer.from(sha256(new TextEncoder().encode(norm))).toString('hex');
}
