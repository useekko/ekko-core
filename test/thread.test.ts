import { describe, expect, it } from 'vitest';
import { MANUAL_PLATFORMS, isScopedThreadId, manualThreadId, scopedThreadId } from '../src/core/thread.js';

describe('manual thread IDs', () => {
  it('keeps each copy/paste platform in a distinct popup-owned session context', () => {
    const ids = MANUAL_PLATFORMS.map((platform) => manualThreadId(platform.id));
    expect(ids.every(isScopedThreadId)).toBe(true);
    expect(new Set(ids).size).toBe(MANUAL_PLATFORMS.length);
    expect(ids.every((id) => id.startsWith('popup:manual:'))).toBe(true);
  });

  it('rejects malformed or oversized runtime thread IDs before persistence', () => {
    expect(isScopedThreadId('instagram:')).toBe(false);
    expect(isScopedThreadId('instagram:has space')).toBe(false);
    expect(isScopedThreadId('Instagram!:chat')).toBe(false);
    expect(isScopedThreadId('instagram:' + 'x'.repeat(512))).toBe(false);
    expect(isScopedThreadId(null)).toBe(false);
  });

  // The WhatsApp adapter derives a LOCAL thread id from the peer's display name (no account
  // id is in the DOM anymore). A raw name with a space or non-ASCII char fails the scoped-id
  // regex and gets rejected as bad-thread — leaving the chat stuck on "identifying" forever.
  // The adapter must encodeURIComponent the name; this guards that it stays valid.
  it('accepts WhatsApp name-derived thread IDs for spaced and non-ASCII names', () => {
    const waThread = (name: string) => scopedThreadId('whatsapp', `name:${encodeURIComponent(name.toLowerCase())}`);
    for (const name of ['Matteo Negri', 'Бабуля', 'Ali Narin', "O'Brien (work)"]) {
      expect(isScopedThreadId(waThread(name))).toBe(true);
    }
    // Stable per name, distinct across names.
    expect(waThread('Matteo Negri')).toBe(waThread('matteo negri'));
    expect(waThread('Matteo Negri')).not.toBe(waThread('Ali Narin'));
  });
});
