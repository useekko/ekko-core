import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { generateIdentity, startHandshake, acceptHandshake } from '../src/core/crypto.js';
import { encryptVault, decryptVault, deriveMaster, type VaultData } from '../src/core/vault.js';

function sampleVault(): VaultData {
  const me = generateIdentity();
  const peer = generateIdentity();
  const { session, wire } = startHandshake(me, peer.bundle);
  session.handshakeWire = wire;
  return {
    identity: me,
    username: 'alice',
    contacts: [{ bundle: peer.bundle, fingerprint: peer.fingerprint, label: 'peer', verified: true, addedAt: 1 }],
    sessions: [session],
    threadBindings: { 'thread-1': 'abcd' },
  };
}

describe('vault', () => {
  it('round-trips through encrypt/decrypt', () => {
    const master = randomBytes(32);
    const salt = randomBytes(16);
    const v = sampleVault();
    const out = decryptVault(encryptVault(v, master, salt), master);
    expect(Buffer.from(out.identity.xPriv)).toEqual(Buffer.from(v.identity.xPriv));
    expect(Buffer.from(out.identity.bundle)).toEqual(Buffer.from(v.identity.bundle));
    expect(out.username).toBe('alice');
    expect(out.contacts[0]!.label).toBe('peer');
    expect(out.contacts[0]!.verified).toBe(true);
    expect(Buffer.from(out.sessions[0]!.key0to1)).toEqual(Buffer.from(v.sessions[0]!.key0to1));
    expect(Buffer.from(out.sessions[0]!.handshakeWire!)).toEqual(Buffer.from(v.sessions[0]!.handshakeWire!));
    expect(out.threadBindings['thread-1']).toBe('abcd');
  });

  it('a restored session still decrypts real messages', async () => {
    // Prove the serialized session keys actually work end-to-end after a vault round-trip.
    const { sealMessage, openMessage } = await import('../src/core/crypto.js');
    const alice = generateIdentity();
    const bob = generateIdentity();
    const { session: aSess, wire } = startHandshake(alice, bob.bundle);
    const { session: bSess } = acceptHandshake(bob, wire);
    const master = randomBytes(32);
    const restored = decryptVault(
      encryptVault({ identity: alice, contacts: [], sessions: [aSess], threadBindings: {} }, master, randomBytes(16)),
      master,
    );
    expect(openMessage(bSess, sealMessage(restored.sessions[0]!, 'after reload'))).toBe('after reload');
  });

  it('wrong master fails to decrypt', () => {
    const blob = encryptVault(sampleVault(), randomBytes(32), randomBytes(16));
    expect(() => decryptVault(blob, randomBytes(32))).toThrow();
  });

  it('deriveMaster is deterministic for a passphrase+salt', async () => {
    const salt = randomBytes(16);
    const a = await deriveMaster('correct horse battery staple', salt);
    const b = await deriveMaster('correct horse battery staple', salt);
    expect(Buffer.from(a)).toEqual(Buffer.from(b));
  });
});
