import { createHash } from 'node:crypto';

// An Ekko identity bundle is version(1) ‖ x25519_pub(32) ‖ mlkem768_pub(1184) = 1217 B,
// shared as `EKK1I:` + base64url(bundle). The directory only ever handles this PUBLIC blob;
// it validates shape + derives the fingerprint, and stores nothing secret.
const BUNDLE_LEN = 1217;
const VERSION = 1;
const INVITE_PREFIXES = ['EKK1I:', 'RSN1I:'];
const ENCODED_BUNDLE_LEN = Math.ceil((BUNDLE_LEN * 4) / 3);
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export function validateInvite(invite) {
  if (typeof invite !== 'string') return null;
  const prefix = INVITE_PREFIXES.find((candidate) => invite.startsWith(candidate));
  if (!prefix) return null;
  const encoded = invite.slice(prefix.length);
  if (encoded.length !== ENCODED_BUNDLE_LEN || !BASE64URL_RE.test(encoded)) return null;
  let bundle;
  try {
    bundle = Buffer.from(encoded, 'base64url');
  } catch {
    return null;
  }
  if (bundle.length !== BUNDLE_LEN || bundle[0] !== VERSION || bundle.toString('base64url') !== encoded) return null;
  return { fingerprint: createHash('sha256').update(bundle).digest('hex'), bundle };
}

export function normalizeUsername(u) {
  const s = String(u).toLowerCase();
  return USERNAME_RE.test(s) ? s : null;
}

// Waitlist emails: we only need "plausibly deliverable", not RFC 5322 — one local part,
// one @, a dot in the domain, sane length. Normalized to lowercase for the PK.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@.]{2,63}$/;

export function normalizeEmail(e) {
  if (typeof e !== 'string' || e.length > 254) return null;
  const s = e.trim().toLowerCase();
  return EMAIL_RE.test(s) ? s : null;
}
