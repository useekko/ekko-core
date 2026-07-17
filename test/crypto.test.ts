import { describe, it, expect } from 'vitest';
import {
  generateIdentity,
  startHandshake,
  acceptHandshake,
  sealMessage,
  openMessage,
  parseBundle,
  safetyNumber,
  BUNDLE_LEN,
} from '../src/core/crypto.js';
import { formatMessage, formatHandshake, classify, classifyStandalone, decodeBody, EKKO_TAGLINE } from '../src/core/wire.js';

function pair() {
  const alice = generateIdentity();
  const bob = generateIdentity();
  const { session: aSess, wire } = startHandshake(alice, bob.bundle);
  const { session: bSess, peerBundle } = acceptHandshake(bob, wire);
  return { alice, bob, aSess, bSess, wire, peerBundle };
}

describe('handshake', () => {
  it('derives identical session keys on both sides', () => {
    const { aSess, bSess } = pair();
    expect(Buffer.from(aSess.id)).toEqual(Buffer.from(bSess.id));
    expect(Buffer.from(aSess.key0to1)).toEqual(Buffer.from(bSess.key0to1));
    expect(Buffer.from(aSess.key1to0)).toEqual(Buffer.from(bSess.key1to0));
    expect(aSess.myParty).not.toBe(bSess.myParty); // canonical parties are opposite
  });

  it('embeds the initiator bundle so the responder pastes nothing', () => {
    const { alice, peerBundle } = pair();
    expect(peerBundle.length).toBe(BUNDLE_LEN);
    expect(Buffer.from(peerBundle)).toEqual(Buffer.from(alice.bundle));
  });
});

describe('messages', () => {
  it('round-trips both directions', () => {
    const { aSess, bSess } = pair();
    expect(openMessage(bSess, sealMessage(aSess, 'hi bob 👋'))).toBe('hi bob 👋');
    expect(openMessage(aSess, sealMessage(bSess, 'hi alice'))).toBe('hi alice');
  });

  it('lets the sender decrypt their own echoed bubble', () => {
    // On Instagram your own sent message also renders in the thread; must decrypt it.
    const { aSess } = pair();
    const sealed = sealMessage(aSess, 'my own message');
    expect(openMessage(aSess, sealed)).toBe('my own message');
  });

  it('rejects a single-bit tamper', () => {
    const { aSess, bSess } = pair();
    const sealed = sealMessage(aSess, 'authentic');
    const last = sealed.length - 1;
    sealed[last] = sealed[last]! ^ 1;
    expect(() => openMessage(bSess, sealed)).toThrow();
  });

  it('rejects a message from an unrelated session', () => {
    const { bSess } = pair();
    const other = pair();
    expect(() => openMessage(bSess, sealMessage(other.aSess, 'x'))).toThrow(/session/);
  });

  it('survives the full wire round-trip (format → classify → decode → open)', () => {
    const { aSess, bSess } = pair();
    const line = formatMessage(sealMessage(aSess, 'over the wire'));
    const c = classify('noise before ' + line + ' noise after');
    expect(c?.kind).toBe('message');
    expect(openMessage(bSess, decodeBody(c!.raw))).toBe('over the wire');
  });

  it('classifies a handshake token', () => {
    const { wire } = pair();
    const c = classify(formatHandshake(wire));
    expect(c?.kind).toBe('handshake');
    expect(Buffer.from(decodeBody(c!.raw))).toEqual(Buffer.from(wire));
  });

  it('only treats a standalone payload as safe to pass through a composer', () => {
    const token = formatMessage(pair().aSess.id);
    expect(classifyStandalone(token)?.raw).toBe(token);
    expect(classifyStandalone(token + EKKO_TAGLINE)?.raw).toBe(token);
    expect(classifyStandalone('please inspect ' + token)).toBeNull();
    expect(classifyStandalone(token + ' and tell me what it says')).toBeNull();
  });
});

describe('identity', () => {
  it('rejects a malformed bundle', () => {
    expect(() => parseBundle(new Uint8Array(10))).toThrow();
  });

  it('safety number is symmetric between the two parties', () => {
    const { alice, bob } = pair();
    expect(safetyNumber(alice.fingerprint, bob.fingerprint)).toBe(
      safetyNumber(bob.fingerprint, alice.fingerprint),
    );
    expect(safetyNumber(alice.fingerprint, bob.fingerprint)).toMatch(/^[\d ]+$/);
  });
});
