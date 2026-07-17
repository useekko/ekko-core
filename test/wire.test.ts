import { describe, expect, it } from 'vitest';
import {
  classify,
  classifyStandalone,
  EKKO_TAGLINE,
  formatHandshake,
  formatInvite,
  formatMessage,
  isWireBlob,
} from '../src/core/wire.js';

// A real ciphertext bubble is `<token>` optionally followed by our tagline. Messengers mangle
// the appended tagline cosmetically (linkify the trailing URL out of the text node, swap the
// lock emoji's variation selector, reflow whitespace) — a strict `=== token + TAGLINE` then
// leaves the bubble as RAW ciphertext for users who should see it decrypted. classifyStandalone
// must tolerate those while still rejecting ordinary prose that merely contains a token.
describe('classifyStandalone tagline robustness', () => {
  const token = formatMessage(new Uint8Array([1, 2, 3, 4, 5, 6]));

  it('accepts a bare token and the exact tagline', () => {
    expect(classifyStandalone(token)?.kind).toBe('message');
    expect(classifyStandalone(token + EKKO_TAGLINE)?.kind).toBe('message');
  });

  it('accepts real-world mangled taglines', () => {
    // trailing URL linkified out of the read text node
    expect(classifyStandalone(`${token} · 🔒 Encrypted with Ekko (post-quantum) · `)?.kind).toBe('message');
    // lock emoji gained a variation selector
    expect(classifyStandalone(`${token} · 🔒️ Encrypted with Ekko (post-quantum) · useekko.app`)?.kind).toBe('message');
    // whitespace reflowed where the link was
    expect(classifyStandalone(`${token} · 🔒 Encrypted with Ekko (post-quantum) ·  useekko.app`)?.kind).toBe('message');
    // a peer still on the old build
    expect(classifyStandalone(`${token} · 🔒 Encrypted with Resonance (post-quantum) · resonance.to`)?.kind).toBe('message');
  });

  it('still rejects ordinary prose containing a token', () => {
    expect(classifyStandalone(`${token} haha check this out`)).toBeNull();
    expect(classifyStandalone(`hey look ${token} lol`)).toBeNull();
    expect(classifyStandalone('just a normal message')).toBeNull();
  });
});

// The manual seal writes handshake + message (or several chunks) into one draft. That
// whole draft is ciphertext and must ride the native send untouched — while one word of
// prose keeps a message about a token an ordinary message.
describe('isWireBlob — a draft that is nothing but our tokens', () => {
  const hs = formatHandshake(new Uint8Array([1, 2, 3]));
  const msg = formatMessage(new Uint8Array([4, 5, 6]));

  it('accepts one token, and the manual seal’s multi-block output', () => {
    expect(isWireBlob(msg)).toBe(true);
    expect(isWireBlob(`${hs}\n\n${msg}`)).toBe(true);
    expect(isWireBlob(`  ${hs}\n\n${msg}\n`)).toBe(true);
  });

  it('rejects prose around or between tokens, empty text, and the tagline form', () => {
    expect(isWireBlob(`please inspect ${msg}`)).toBe(false);
    expect(isWireBlob(`${hs}\n\nsee you at 6`)).toBe(false);
    expect(isWireBlob('')).toBe(false);
    expect(isWireBlob(`${msg}${EKKO_TAGLINE}`)).toBe(false); // token + tagline is classifyStandalone's case
  });
});

describe('Ekko wire branding', () => {
  it('emits only EKK1 prefixes', () => {
    expect(formatInvite(new Uint8Array([1]))).toBe('EKK1I:AQ');
    expect(formatHandshake(new Uint8Array([1]))).toBe('EKK1H:AQ');
    expect(formatMessage(new Uint8Array([1]))).toBe('EKK1M:AQ');
  });

  it('still reads legacy Resonance tokens', () => {
    expect(classify('RSN1I:AQ')?.kind).toBe('invite');
    expect(classify('RSN1H:AQ')?.kind).toBe('handshake');
    expect(classify('RSN1M:AQ')?.kind).toBe('message');
    expect(classify('RSN1C:a:0/1:x')?.kind).toBe('chunk');
  });
});
