import { describe, expect, it } from 'vitest';
import { peerPhoneFromMessage } from '../src/content/whatsapp.js';
import { isScopedThreadId, scopedThreadId } from '../src/core/thread.js';

// The peer's phone is picked from a WhatsApp model-storage `message` record. Getting the
// direction wrong would encrypt to the WRONG party (yourself), so this is worth pinning.
describe('WhatsApp peerPhoneFromMessage', () => {
  const me = '15105551234';
  const peer = '34655551234';

  it('incoming message: peer is the sender (from)', () => {
    const rec = { from: `${peer}@c.us`, to: { _serialized: `${me}@c.us` } };
    expect(peerPhoneFromMessage(rec, false)).toBe(peer);
  });

  it('outgoing message: peer is the recipient (to)', () => {
    const rec = { from: `${me}@c.us`, to: { _serialized: `${peer}@c.us` } };
    expect(peerPhoneFromMessage(rec, true)).toBe(peer);
  });

  it('accepts a plain-string to/from as well as the {_serialized} shape', () => {
    expect(peerPhoneFromMessage({ from: `${peer}@c.us`, to: `${me}@c.us` }, false)).toBe(peer);
  });

  it('rejects non-phone parties (group, LID, status broadcast, missing)', () => {
    expect(peerPhoneFromMessage({ from: '0@c.us', to: { _serialized: `${me}@c.us` } }, false)).toBeNull();
    expect(peerPhoneFromMessage({ from: '120363000000000000@g.us' }, false)).toBeNull();
    expect(peerPhoneFromMessage({ from: '101600000000000@lid' }, false)).toBeNull();
    expect(peerPhoneFromMessage({}, false)).toBeNull();
    expect(peerPhoneFromMessage({ to: 42 as unknown as string }, true)).toBeNull();
  });

  it('the resulting pn: thread id is a valid scoped thread id', () => {
    const phone = peerPhoneFromMessage({ from: `${peer}@c.us`, to: `${me}@c.us` }, false)!;
    expect(isScopedThreadId(scopedThreadId('whatsapp', `pn:${phone}`))).toBe(true);
  });
});
