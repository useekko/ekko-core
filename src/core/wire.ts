// Wire envelope: every Ekko payload rides inside a normal DM as one token.
import { b64uEncode, b64uDecode } from './b64.js';

export const PREFIX = {
  invite: 'EKK1I:',
  handshake: 'EKK1H:',
  message: 'EKK1M:',
  chunk: 'EKK1C:',
} as const;

// Read the original Resonance tokens forever so an upgrade cannot strand existing contacts or
// ciphertext. New output is Ekko-branded via PREFIX above.
const LEGACY_PREFIX = {
  invite: 'RSN1I:',
  handshake: 'RSN1H:',
  message: 'RSN1M:',
  chunk: 'RSN1C:',
} as const;

export type WireKind = 'invite' | 'handshake' | 'message' | 'chunk';

// Instagram's hard per-message cap is 1000 chars; 900 leaves headroom. One source of
// truth shared by the Instagram adapter and the popup's manual encrypt.
export const IG_MAX_MESSAGE_LEN = 900;

// Optional one-line tag appended to a sent ciphertext so non-users see what it is (and a
// way to join). A recipient decrypts the token and the tag vanishes with it. Kept
// single-line and short so it barely touches the length budget.
export const EKKO_TAGLINE = ' · 🔒 Encrypted with Ekko (post-quantum) · useekko.app';

// Match a token in an arbitrary bubble of text. base64url is [A-Za-z0-9_-];
// chunk tokens additionally use ':' and '/'. Greedy match stops at whitespace.
export const TOKEN_RE = /(?:EKK1|RSN1)[IHMC]:[A-Za-z0-9_\-:/]+/;

export function classify(text: string): { kind: WireKind; raw: string } | null {
  const m = text.match(TOKEN_RE);
  if (!m) return null;
  const raw = m[0];
  if (raw.startsWith(PREFIX.invite) || raw.startsWith(LEGACY_PREFIX.invite)) return { kind: 'invite', raw };
  if (raw.startsWith(PREFIX.handshake) || raw.startsWith(LEGACY_PREFIX.handshake)) return { kind: 'handshake', raw };
  if (raw.startsWith(PREFIX.message) || raw.startsWith(LEGACY_PREFIX.message)) return { kind: 'message', raw };
  if (raw.startsWith(PREFIX.chunk) || raw.startsWith(LEGACY_PREFIX.chunk)) return { kind: 'chunk', raw };
  return null;
}

// Content scripts may pass through a manually pasted protocol payload, but must never
// mistake ordinary text *containing* an Ekko-token substring for ciphertext. The tag is
// the one fixed suffix the sender itself can add.
// Our tagline signature, matched LOOSELY on the remainder after the token. The old code
// required an EXACT `raw + EKKO_TAGLINE`, but messengers mangle the appended tagline in ways
// that are cosmetic yet break `===`: they linkify the trailing `useekko.app` URL (so the read
// text node ends at "· " with the URL now in a sibling <a>), swap the lock emoji's variation
// selector, or reflow the separators. A strict match then strands the bubble as raw ciphertext
// for the exact users who should see it decrypted. This signature — "Encrypted with Ekko (or
// Resonance) (post-quantum)" — is unmistakably ours and nobody types it by accident after an
// Ekko token, so matching it (or an empty remainder) is both robust and safe.
const TAGLINE_SIG = /Encrypted with (Ekko|Resonance) \(post-quantum\)/;

// A text made ONLY of our tokens, one per whitespace-separated piece. The manual seal
// writes handshake + message (or several chunks) into the composer as one multi-block
// draft; pure ciphertext must ride the native send untouched, exactly like a single
// standalone token. Each piece must BE a token, not merely contain one — a single word
// of prose disqualifies, so "look at EKK1M:…" stays an ordinary message about a token.
export function isWireBlob(text: string): boolean {
  const parts = text.trim().split(/\s+/);
  return parts[0] !== '' && parts.every((p) => classify(p)?.raw === p);
}

export function classifyStandalone(text: string): { kind: WireKind; raw: string } | null {
  const candidate = text.trim();
  const c = classify(candidate);
  if (!c) return null;
  // The token must START the bubble (no leading prose — "please inspect EKK1M:…" is a user
  // asking about a token, not ciphertext to decrypt), and only our tagline may follow it.
  const idx = candidate.indexOf(c.raw);
  const rest = candidate.slice(idx + c.raw.length);
  const ok = idx === 0 && (rest.trim() === '' || TAGLINE_SIG.test(rest));
  return ok ? c : null;
}

export function formatInvite(bundle: Uint8Array): string {
  return PREFIX.invite + b64uEncode(bundle);
}
export function formatHandshake(bytes: Uint8Array): string {
  return PREFIX.handshake + b64uEncode(bytes);
}
export function formatMessage(body: Uint8Array): string {
  return PREFIX.message + b64uEncode(body);
}

// Strip prefix and base64url-decode the body of a non-chunk token.
export function decodeBody(raw: string): Uint8Array {
  return b64uDecode(raw.slice(raw.indexOf(':') + 1));
}
