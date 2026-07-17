import { describe, it, expect } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  generateMnemonic,
  isValidMnemonic,
  normalizeMnemonic,
  recoveryIdentity,
  deviceIdentity,
} from '../src/core/recovery.js';
import {
  identityFromKeyMaterial,
  answerKeyChallenge,
  startHandshake,
  acceptHandshake,
  sealMessage,
  openMessage,
  generateIdentity,
  BUNDLE_LEN,
} from '../src/core/crypto.js';

describe('recovery: mnemonic', () => {
  it('generates a valid 24-word phrase (256-bit, full PQ margin)', () => {
    const m = generateMnemonic();
    expect(m.split(' ')).toHaveLength(24);
    expect(isValidMnemonic(m)).toBe(true);
  });

  it('rejects a tampered phrase and tolerates casing/whitespace', () => {
    const m = generateMnemonic();
    expect(isValidMnemonic(m + ' zoo')).toBe(false);
    expect(isValidMnemonic('  ' + m.toUpperCase() + '  ')).toBe(true);
    expect(normalizeMnemonic('  A  B\tC ')).toBe('a b c');
  });
});

describe('recovery: deterministic derivation', () => {
  const phrase = generateMnemonic();

  it('same phrase → same recovery identity (import restores it)', () => {
    expect(recoveryIdentity(phrase).fingerprint).toEqual(recoveryIdentity(phrase).fingerprint);
    expect(recoveryIdentity(phrase).bundle).toHaveLength(BUNDLE_LEN);
  });

  it('recovery, device-0, device-1 are all distinct keys (domain separation)', () => {
    const fps = [recoveryIdentity(phrase), deviceIdentity(phrase, 0), deviceIdentity(phrase, 1)].map((i) =>
      Buffer.from(i.fingerprint).toString('hex'),
    );
    expect(new Set(fps).size).toBe(3);
  });

  it('a different phrase → a different identity', () => {
    expect(deviceIdentity(generateMnemonic(), 0).fingerprint).not.toEqual(deviceIdentity(phrase, 0).fingerprint);
  });

  it('a derived identity works in a real handshake + message round-trip', () => {
    const me = deviceIdentity(phrase, 0); // seed-derived
    const peer = generateIdentity(); // random peer
    const { session: s1, wire } = startHandshake(me, peer.bundle);
    const { session: s2 } = acceptHandshake(peer, wire);
    expect(openMessage(s2, sealMessage(s1, 'from a recovered key'))).toBe('from a recovered key');
  });
});

describe('crypto: identityFromKeyMaterial', () => {
  it('is deterministic and matches a valid bundle shape', () => {
    const x = new Uint8Array(32).fill(3);
    const k = new Uint8Array(64).fill(9);
    const a = identityFromKeyMaterial(x, k);
    const b = identityFromKeyMaterial(x, k);
    expect(a.bundle).toEqual(b.bundle);
    expect(a.bundle).toHaveLength(BUNDLE_LEN);
    expect(a.fingerprint).toEqual(sha256(a.bundle));
  });
});

describe('crypto: ownership-proof challenge (X25519 ECDH)', () => {
  it('the key-holder computes the same secret the directory does; a wrong key does not', () => {
    const me = generateIdentity();
    const impostor = generateIdentity();
    // Directory side: ephemeral key + shared secret against the PUBLISHED x25519 pub.
    const eph = x25519.keygen();
    const serverProof = sha256(x25519.getSharedSecret(eph.secretKey, me.xPub));
    // Client side: only the holder of xPriv reproduces it.
    expect(answerKeyChallenge(me.xPriv, eph.publicKey)).toEqual(serverProof);
    expect(answerKeyChallenge(impostor.xPriv, eph.publicKey)).not.toEqual(serverProof);
  });
});
