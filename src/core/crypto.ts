// Ekko crypto core. Pure functions, zero I/O — everything here is unit-testable.
//
// Hybrid post-quantum session establishment (PQXDH-shaped):
//   ikm = X25519(eph, peer_id) ‖ X25519(my_id, peer_id) ‖ ML-KEM-768(shared)
// The ML-KEM term gives post-quantum confidentiality *now* (defeats harvest-now-
// decrypt-later); the static-static X25519 term gives classical implicit
// authentication of identities. Per-message AEAD is XChaCha20-Poly1305.
//
// ponytail: static per-session keys, random nonces, no double-ratchet. Stateless on
// purpose — platform reordering/deletion can't desync, and history stays decryptable.
// Upgrade to a ratchet only if the project earns real users who need PCS.

import { x25519 } from '@noble/curves/ed25519.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { concatBytes, randomBytes } from '@noble/hashes/utils.js';

const VERSION = 1;
const XPUB = 32;
const KPUB = 1184;
const KCT = 1088;
const NONCE = 24;
const SID = 8;
export const BUNDLE_LEN = 1 + XPUB + KPUB; // 1217

const HKDF_INFO = new TextEncoder().encode('Resonance/v1');
const HKDF_SALT = new TextEncoder().encode('Resonance/v1/session');

export interface Identity {
  xPriv: Uint8Array;
  xPub: Uint8Array;
  kPriv: Uint8Array;
  kPub: Uint8Array;
  bundle: Uint8Array; // public: version ‖ xPub ‖ kPub
  fingerprint: Uint8Array; // sha256(bundle)
}

export interface Session {
  id: Uint8Array; // 8 bytes, appears on every message
  key0to1: Uint8Array; // 32 — used by canonical party 0 when sending
  key1to0: Uint8Array; // 32 — used by canonical party 1 when sending
  myParty: 0 | 1;
  peerFingerprint: Uint8Array;
  // Local, encrypted vault metadata. It is not sent on the wire; the broker uses it to
  // keep a session negotiated for one direct conversation out of another conversation.
  threadId?: string;
  // Established through the account mailbox (session_setups): per-contact, deliberately
  // thread-less — it serves any chat bound to this peer. The marker exempts it from the
  // legacy migration that treats a missing threadId as a pre-scoping artifact.
  acct?: boolean;
  // Local, encrypted transport state. Retained until authenticated peer traffic proves
  // the initial handshake arrived, so a failed first send never strands the peer.
  handshakeWire?: Uint8Array;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function generateIdentity(): Identity {
  const x = x25519.keygen();
  const k = ml_kem768.keygen();
  const bundle = concatBytes(Uint8Array.of(VERSION), x.publicKey, k.publicKey);
  return {
    xPriv: x.secretKey,
    xPub: x.publicKey,
    kPriv: k.secretKey,
    kPub: k.publicKey,
    bundle,
    fingerprint: sha256(bundle),
  };
}

// Deterministic identity from raw key material — recovery/import derive their keys from a
// seed phrase instead of the RNG, but the bundle and fingerprint are built identically to
// generateIdentity(). `xSeed` is a 32-byte X25519 private scalar (noble clamps it); `kSeed`
// is a 64-byte ML-KEM seed. See core/recovery.ts for the phrase → seed derivation.
export function identityFromKeyMaterial(xSeed: Uint8Array, kSeed: Uint8Array): Identity {
  const xPub = x25519.getPublicKey(xSeed);
  const k = ml_kem768.keygen(kSeed);
  const bundle = concatBytes(Uint8Array.of(VERSION), xPub, k.publicKey);
  return { xPriv: xSeed, xPub, kPriv: k.secretKey, kPub: k.publicKey, bundle, fingerprint: sha256(bundle) };
}

// Directory ownership proof (client side). To prove control of this identity's private key
// without revealing it, answer an X25519 ECDH challenge: the directory sends an ephemeral
// public key, and only the key-holder can compute the shared secret. This lives entirely at
// the directory layer and never touches the encrypted payload format. The server computes the same
// value with its ephemeral private key against this identity's published X25519 public key.
export function answerKeyChallenge(xPriv: Uint8Array, ephemeralPub: Uint8Array): Uint8Array {
  return sha256(x25519.getSharedSecret(xPriv, ephemeralPub));
}

export function parseBundle(bundle: Uint8Array): { xPub: Uint8Array; kPub: Uint8Array } {
  if (bundle.length !== BUNDLE_LEN || bundle[0] !== VERSION) throw new Error('bad identity bundle');
  return { xPub: bundle.subarray(1, 1 + XPUB), kPub: bundle.subarray(1 + XPUB) };
}

export function fingerprint(bundle: Uint8Array): Uint8Array {
  return sha256(bundle);
}

// Canonical, order-independent session derivation: both parties feed the SAME ikm and
// info (fingerprints sorted) so they land on the same keys regardless of who initiated.
function deriveSession(
  fpMe: Uint8Array,
  fpPeer: Uint8Array,
  dhEph: Uint8Array,
  dhStatic: Uint8Array,
  kemSs: Uint8Array,
): Session {
  const meFirst = compareBytes(fpMe, fpPeer) < 0;
  const fp0 = meFirst ? fpMe : fpPeer;
  const fp1 = meFirst ? fpPeer : fpMe;
  const ikm = concatBytes(dhEph, dhStatic, kemSs);
  const info = concatBytes(HKDF_INFO, fp0, fp1);
  const out = hkdf(sha256, ikm, HKDF_SALT, info, 32 + 32 + SID);
  return {
    key0to1: out.slice(0, 32),
    key1to0: out.slice(32, 64),
    id: out.slice(64, 64 + SID),
    myParty: meFirst ? 0 : 1,
    peerFingerprint: fpPeer.slice(),
  };
}

// Initiator: A holds B's public bundle. Returns the session and the handshake wire bytes.
export function startHandshake(me: Identity, peerBundle: Uint8Array): { session: Session; wire: Uint8Array } {
  const peer = parseBundle(peerBundle);
  const fpPeer = sha256(peerBundle);
  const eph = x25519.keygen();
  const dhEph = x25519.getSharedSecret(eph.secretKey, peer.xPub);
  const dhStatic = x25519.getSharedSecret(me.xPriv, peer.xPub);
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(peer.kPub);
  const session = deriveSession(me.fingerprint, fpPeer, dhEph, dhStatic, sharedSecret);
  const wire = concatBytes(Uint8Array.of(VERSION), me.bundle, eph.publicKey, cipherText);
  return { session, wire };
}

// Responder: B receives A's handshake wire. A's bundle is embedded, so B pastes nothing.
export function acceptHandshake(me: Identity, wire: Uint8Array): { session: Session; peerBundle: Uint8Array } {
  if (wire.length !== 1 + BUNDLE_LEN + XPUB + KCT) throw new Error('bad handshake length');
  let o = 0;
  if (wire[o++] !== VERSION) throw new Error('bad handshake version');
  const peerBundle = wire.slice(o, o + BUNDLE_LEN);
  o += BUNDLE_LEN;
  const ephPub = wire.slice(o, o + XPUB);
  o += XPUB;
  const kemCt = wire.slice(o, o + KCT);
  const peer = parseBundle(peerBundle);
  const fpPeer = sha256(peerBundle);
  const dhEph = x25519.getSharedSecret(me.xPriv, ephPub);
  const dhStatic = x25519.getSharedSecret(me.xPriv, peer.xPub);
  const kemSs = ml_kem768.decapsulate(kemCt, me.kPriv);
  const session = deriveSession(me.fingerprint, fpPeer, dhEph, dhStatic, kemSs);
  return { session, peerBundle };
}

// Message body: version ‖ flags ‖ sessionId ‖ nonce ‖ AEAD(pt). The header (first
// 2+SID bytes) is also the AEAD associated data, binding version/direction/session.
export function sealMessage(session: Session, plaintext: string): Uint8Array {
  const nonce = randomBytes(NONCE);
  const key = session.myParty === 0 ? session.key0to1 : session.key1to0;
  const header = concatBytes(Uint8Array.of(VERSION, session.myParty), session.id);
  const ct = xchacha20poly1305(key, nonce, header).encrypt(new TextEncoder().encode(plaintext));
  return concatBytes(header, nonce, ct);
}

// Read the session id from a message body before we know which session it belongs to,
// so the broker can look the session up. Returns null if the body is too short.
export function readSessionId(body: Uint8Array): Uint8Array | null {
  if (body.length < 2 + SID) return null;
  return body.slice(2, 2 + SID);
}

export function openMessage(session: Session, body: Uint8Array): string {
  if (body.length < 2 + SID + NONCE + 16) throw new Error('short message');
  let o = 0;
  if (body[o++] !== VERSION) throw new Error('bad message version');
  const senderParty = (body[o++]! & 1) as 0 | 1;
  const id = body.slice(o, o + SID);
  o += SID;
  if (!bytesEqual(id, session.id)) throw new Error('wrong session');
  const nonce = body.slice(o, o + NONCE);
  o += NONCE;
  const ct = body.slice(o);
  const key = senderParty === 0 ? session.key0to1 : session.key1to0;
  const header = body.slice(0, 2 + SID);
  const pt = xchacha20poly1305(key, nonce, header).decrypt(ct); // throws on tamper
  return new TextDecoder().decode(pt);
}

// Signal-style numeric safety number over BOTH identities — symmetric, read aloud to
// verify no MITM. 60 digits in groups of 5. Not a secret; forging a match needs ~2^199 work.
export function safetyNumber(fpMe: Uint8Array, fpPeer: Uint8Array): string {
  const [a, b] = compareBytes(fpMe, fpPeer) < 0 ? [fpMe, fpPeer] : [fpPeer, fpMe];
  const h = sha256(concatBytes(a, b));
  let digits = '';
  for (let i = 0; i < 30; i++) digits += String(h[i]! % 100).padStart(2, '0');
  return digits.replace(/(\d{5})(?=\d)/g, '$1 ');
}

// Grouped-hex rendering of one identity's fingerprint, for popup display.
export function fingerprintHex(fp: Uint8Array): string {
  return Array.from(fp.slice(0, 16), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, '$1 ');
}
