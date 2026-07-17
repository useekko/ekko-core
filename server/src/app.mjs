import { timingSafeEqual } from 'node:crypto';
import { validateInvite, normalizeUsername, normalizeEmail } from './validate.mjs';
import { bundleXPub, makeChallenge, verifyProof, newChallengeId, handleHash, sha256 } from './crypto.mjs';

const inviteOf = (bundle) => 'EKK1I:' + Buffer.from(bundle).toString('base64url');
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const PLATFORM_RE = /^[a-z][a-z0-9]{1,19}$/;

// Short-lived, one-time ownership challenges (proof-of-key-control for authenticated publish).
// In-memory: they live ~2 minutes and there is no value in persisting them.
function makeChallengeStore(max = 4096) {
  const CHALLENGE_TTL = 120_000;
  const m = new Map();
  return {
    issue(bundle) {
      const xpub = bundleXPub(bundle);
      if (!xpub) return null;
      if (m.size >= max) {
        for (const [k, v] of m) if (Date.now() > v.expiry) m.delete(k);
        if (m.size >= max) return { busy: true };
      }
      const { ephPub, expected } = makeChallenge(xpub);
      const id = newChallengeId();
      m.set(id, { expected, bundle, expiry: Date.now() + CHALLENGE_TTL });
      return { id, challenge: Buffer.from(ephPub).toString('base64url') };
    },
    // One-time: consume the challenge and verify the proof. Returns the proven bundle or null.
    take(id, proofB64) {
      const e = m.get(String(id));
      if (!e) return null;
      m.delete(String(id));
      if (Date.now() > e.expiry) return null;
      let proof;
      try {
        proof = Buffer.from(String(proofB64), 'base64url');
      } catch {
        return null;
      }
      return verifyProof(e.expected, proof) ? { bundle: e.bundle } : null;
    },
  };
}

// Directory HTTP handler. Pure over its store, so tests drive it without a real socket.
//
// SECURITY POSTURE: legacy /keys publishing is unauthenticated TOFU. V2 account creation
// proves device-key control, but linked platform handles are only reserved, not ownership-
// verified. Every username response and every unverified platform mapping therefore remains
// untrusted; the client refuses automatic platform offers unless verified_at is present.
// The directory is discovery, never a root of trust. See docs/DIRECTORY.md.
export function createApp(store, opts = {}) {
  const limit = makeLimiter(opts.rateLimit ?? { max: 30, windowMs: 60_000 });
  // The waitlist is a pure write sink; keep its budget tighter than key publishing.
  const waitlistLimit = makeLimiter(opts.waitlistRateLimit ?? { max: 5, windowMs: 600_000 });
  // Reads (handle/key resolution) get their own looser budget so a scraper can't run an
  // unmetered membership/enumeration sweep, and reads never share the publish budget.
  const readLimit = makeLimiter(opts.readRateLimit ?? { max: 120, windowMs: 60_000 });
  const challenges = makeChallengeStore(opts.challengeLimit);
  const verifier = opts.verifier ?? null; // platform ownership verification (verify.mjs); null = feature off
  const adminToken = opts.adminToken || null; // unset = /admin/* does not exist (fail closed)

  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();

    let url;
    try {
      url = new URL(req.url, 'http://d');
    } catch {
      return json(res, 400, { error: 'bad-request' });
    }

    try {
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });

      // Meter all resolution reads (not /health, which monitoring hits).
      if (req.method === 'GET' && !readLimit(clientIp(req))) return json(res, 429, { error: 'rate-limited' });

      if (req.method === 'GET' && url.pathname === '/lookup') return lookup(store, url, res);

      if (req.method === 'GET' && url.pathname === '/verify/check') return verifyCheck(verifier, url, res);

      const um = url.pathname.match(/^\/u\/([^/]+)$/);
      if (req.method === 'GET' && um) return resolveUsername(store, um[1], res);

      const km = url.pathname.match(/^\/keys\/([0-9a-f]{64})$/);
      if (req.method === 'GET' && km) return resolveFingerprint(store, km[1], res);

      if (req.method === 'POST' && url.pathname === '/keys') {
        if (!limit(clientIp(req))) return json(res, 429, { error: 'rate-limited' });
        let body;
        try {
          body = await readBody(req, 8192);
        } catch {
          return json(res, 413, { error: 'too-large' });
        }
        return publish(store, body, res);
      }

      if (req.method === 'POST' && url.pathname === '/waitlist') {
        if (!waitlistLimit(clientIp(req))) return json(res, 429, { error: 'rate-limited' });
        let body;
        try {
          body = await readBody(req, 512);
        } catch {
          return json(res, 413, { error: 'too-large' });
        }
        return joinWaitlist(store, body, res);
      }

      // —— v2 directory: authenticated publish, discovery, recovery, verification ——
      const V2_POST = ['/auth/challenge', '/u/claim', '/handles/link', '/handles/unlink', '/recover', '/verify/start'];
      if (req.method === 'POST' && V2_POST.includes(url.pathname)) {
        if (!limit(clientIp(req))) return json(res, 429, { error: 'rate-limited' });
        let body;
        try {
          body = await readBody(req, 8192);
        } catch {
          return json(res, 413, { error: 'too-large' });
        }
        if (url.pathname === '/auth/challenge') return authChallenge(challenges, body, res);
        if (url.pathname === '/u/claim') return claimAccount(store, challenges, body, res);
        if (url.pathname === '/handles/link') return linkHandle(store, challenges, body, res);
        if (url.pathname === '/handles/unlink') return unlinkHandle(store, challenges, body, res);
        if (url.pathname === '/verify/start') return verifyStart(store, challenges, verifier, body, res);
        return recoverKey(store, challenges, body, res);
      }

      // —— operator attestation (admin token, meant for localhost/tunnel — not proxied by nginx).
      // With no token configured the whole namespace is indistinguishable from absent.
      if (req.method === 'POST' && url.pathname.startsWith('/admin/')) {
        if (!adminToken || !bearerMatches(req, adminToken)) return json(res, 404, { error: 'not-found' });
        let body;
        try {
          body = await readBody(req, 8192);
        } catch {
          return json(res, 413, { error: 'too-large' });
        }
        if (url.pathname === '/admin/verify') return adminVerify(store, body, res);
        if (url.pathname === '/admin/unlink') return adminUnlink(store, body, res);
        return json(res, 404, { error: 'not-found' });
      }

      return json(res, 404, { error: 'not-found' });
    } catch {
      return json(res, 500, { error: 'server-error' });
    }
  };
}

function publish(store, body, res) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(res, 400, { error: 'bad-json' });
  }
  const v = validateInvite(parsed?.invite);
  if (!v) return json(res, 400, { error: 'bad-invite' });

  let username = null;
  if (parsed.username != null && parsed.username !== '') {
    username = normalizeUsername(parsed.username);
    if (!username) return json(res, 400, { error: 'bad-username' });
  }

  const now = Date.now();
  store.putKey(v.fingerprint, parsed.invite, now);
  if (username) {
    const claim = store.claimUsername(username, v.fingerprint, now);
    if (claim === 'taken') return json(res, 409, { error: 'username-taken' });
    if (claim === 'already-claimed') return json(res, 409, { error: 'username-exists' });
  }
  return json(res, 200, { fingerprint: v.fingerprint, username, verified: false });
}

function joinWaitlist(store, body, res) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(res, 400, { error: 'bad-json' });
  }
  const email = normalizeEmail(parsed?.email);
  if (!email) return json(res, 400, { error: 'bad-email' });
  store.addWaitlist(email, Date.now());
  // 204 for new and duplicate alike — the endpoint must not confirm membership.
  res.writeHead(204).end();
}

// Issue an ownership challenge for a published bundle (step 1 of authenticated publish).
function authChallenge(challenges, body, res) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(res, 400, { error: 'bad-json' });
  }
  const v = validateInvite(parsed?.invite);
  if (!v) return json(res, 400, { error: 'bad-invite' });
  const c = challenges.issue(v.bundle);
  if (!c) return json(res, 400, { error: 'bad-invite' });
  if (c.busy) return json(res, 503, { error: 'directory-busy' });
  return json(res, 200, { challengeId: c.id, challenge: c.challenge });
}

// Create an account: prove control of the device key (via the challenge), attach a recovery
// anchor, and claim an @handle. This is the authenticated replacement for the old TOFU claim.
function claimAccount(store, challenges, body, res) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(res, 400, { error: 'bad-json' });
  }
  const proven = challenges.take(parsed?.challengeId, parsed?.proof);
  if (!proven) return json(res, 401, { error: 'bad-proof' });
  const username = normalizeUsername(parsed?.username);
  if (!username) return json(res, 400, { error: 'bad-username' });
  const rec = validateInvite(parsed?.recovery);
  if (!rec) return json(res, 400, { error: 'bad-recovery' });
  const r = store.createAccount(username, rec.fingerprint, parsed.recovery, inviteOf(proven.bundle), hex(sha256(proven.bundle)), Date.now());
  if (r === 'taken') return json(res, 409, { error: 'username-taken' });
  return json(res, 200, { ok: true, username });
}

// Link an opt-in platform handle (hashed) to the account that owns the proven device key.
function linkHandle(store, challenges, body, res) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(res, 400, { error: 'bad-json' });
  }
  const proven = challenges.take(parsed?.challengeId, parsed?.proof);
  if (!proven) return json(res, 401, { error: 'bad-proof' });
  const owner = store.userByDeviceBundle(inviteOf(proven.bundle));
  if (!owner) return json(res, 404, { error: 'no-account' });
  const platform = String(parsed?.platform ?? '').toLowerCase();
  const handle = String(parsed?.handle ?? '').trim();
  if (!PLATFORM_RE.test(platform) || handle.length < 1 || handle.length > 100) return json(res, 400, { error: 'bad-handle' });
  const r = store.linkPlatformHandle(owner.user_id, platform, handleHash(platform, handle), Date.now());
  if (r === 'taken') return json(res, 409, { error: 'handle-taken' });
  return json(res, 200, { ok: true });
}

// Remove the caller's own mapping(s) for a platform, proving control of the device key —
// the missing half of "edit your linked accounts" (a typo'd reservation was forever).
function unlinkHandle(store, challenges, body, res) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(res, 400, { error: 'bad-json' });
  }
  const proven = challenges.take(parsed?.challengeId, parsed?.proof);
  if (!proven) return json(res, 401, { error: 'bad-proof' });
  const owner = store.userByDeviceBundle(inviteOf(proven.bundle));
  if (!owner) return json(res, 404, { error: 'no-account' });
  const platform = String(parsed?.platform ?? '').toLowerCase();
  if (!PLATFORM_RE.test(platform)) return json(res, 400, { error: 'bad-handle' });
  store.unlinkPlatform(owner.user_id, platform);
  return json(res, 200, { ok: true }); // idempotent: gone is gone, however it got there
}

// Start platform ownership verification: authenticate the device key, get a one-time code
// to send to the Ekko bot from the platform account being claimed. The bot's inbound
// webhook/poller is what actually verifies (verify.mjs consumeInbound) — this only issues.
function verifyStart(store, challenges, verifier, body, res) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(res, 400, { error: 'bad-json' });
  }
  const proven = challenges.take(parsed?.challengeId, parsed?.proof);
  if (!proven) return json(res, 401, { error: 'bad-proof' });
  const owner = store.userByDeviceBundle(inviteOf(proven.bundle));
  if (!owner) return json(res, 404, { error: 'no-account' });
  const platform = String(parsed?.platform ?? '').toLowerCase();
  if (!PLATFORM_RE.test(platform)) return json(res, 400, { error: 'bad-platform' });
  if (!verifier?.supports(platform)) return json(res, 503, { error: 'verify-unavailable' });
  const issued = verifier.issue(owner.user_id, platform);
  return json(res, 200, { ...issued, bot: { platform, username: verifier.botUsername(platform) } });
}

// Poll a pending verification by capability id. 404 for unknown/expired — the id itself is
// the secret, so there is nothing else to authenticate.
function verifyCheck(verifier, url, res) {
  const out = verifier?.check(url.searchParams.get('id'));
  if (!out) return json(res, 404, { error: 'not-found' });
  return json(res, 200, out);
}

// Operator attestation: mark a mapping verified without the bot ceremony (early-access
// support, platforms with no verifier yet). Same write path as the bot — verifyPlatformHandle
// is the single door to verified_at.
function adminVerify(store, body, res) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(res, 400, { error: 'bad-json' });
  }
  const username = normalizeUsername(parsed?.username);
  if (!username) return json(res, 400, { error: 'bad-username' });
  const platform = String(parsed?.platform ?? '').toLowerCase();
  const handle = String(parsed?.handle ?? '').trim();
  if (!PLATFORM_RE.test(platform) || handle.length < 1 || handle.length > 100) return json(res, 400, { error: 'bad-handle' });
  const user = store.userIdByUsername(username);
  if (!user) return json(res, 404, { error: 'no-account' });
  store.verifyPlatformHandle(user.id, platform, handleHash(platform, handle), Date.now());
  return json(res, 200, { ok: true, username, platform });
}

function adminUnlink(store, body, res) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(res, 400, { error: 'bad-json' });
  }
  const platform = String(parsed?.platform ?? '').toLowerCase();
  const handle = String(parsed?.handle ?? '').trim();
  if (!PLATFORM_RE.test(platform) || handle.length < 1 || handle.length > 100) return json(res, 400, { error: 'bad-handle' });
  const removed = store.deleteHandleByHash(handleHash(platform, handle));
  return json(res, 200, { ok: true, removed });
}

// Constant-time bearer check (hash both sides to equalize length first).
function bearerMatches(req, token) {
  const got = String(req.headers.authorization ?? '');
  if (!got.startsWith('Bearer ')) return false;
  return timingSafeEqual(Buffer.from(sha256(got.slice(7))), Buffer.from(sha256(token)));
}

// Rotate to a new device key after device loss, proving control of the RECOVERY key. The
// @handle is preserved; the key change surfaces to peers via the existing keyChanged guard.
function recoverKey(store, challenges, body, res) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(res, 400, { error: 'bad-json' });
  }
  const proven = challenges.take(parsed?.challengeId, parsed?.proof);
  if (!proven) return json(res, 401, { error: 'bad-proof' });
  const owner = store.userByRecoveryFp(hex(sha256(proven.bundle)));
  if (!owner) return json(res, 404, { error: 'no-account' });
  // Phrase restore re-derives the same device key but the public @handle is not encoded
  // in the phrase. Recovery-key proof identifies the account, so return its handle without
  // rotating any key. This also prevents a restored identity from creating a duplicate account.
  if (parsed?.newBundle == null) {
    if (!owner.username) return json(res, 404, { error: 'no-account' });
    return json(res, 200, { ok: true, username: owner.username });
  }
  const nd = validateInvite(parsed?.newBundle);
  if (!nd) return json(res, 400, { error: 'bad-invite' });
  store.rotateDevice(owner.id, parsed.newBundle, hex(sha256(nd.bundle)), Date.now());
  return json(res, 200, { ok: true });
}

function resolveUsername(store, raw, res) {
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return json(res, 400, { error: 'bad-username' });
  }
  const u = normalizeUsername(decoded);
  if (!u) return json(res, 400, { error: 'bad-username' });
  // Prefer a v2 account (authenticated) over a legacy TOFU username claim.
  const v2 = store.resolveHandle(u);
  if (v2) return json(res, 200, { username: u, invite: v2.bundle, verified: false });
  const row = store.resolveUsername(u);
  if (!row) return json(res, 404, { error: 'not-found' });
  return json(res, 200, { username: u, fingerprint: row.fingerprint, invite: row.invite, verified: false });
}

function resolveFingerprint(store, fp, res) {
  const row = store.getKey(fp);
  if (!row) return json(res, 404, { error: 'not-found' });
  return json(res, 200, { fingerprint: fp, invite: row.invite, verified: false });
}

function lookup(store, url, res) {
  const platform = url.searchParams.get('platform');
  const handleHashParam = url.searchParams.get('handle_hash');
  if (platform && handleHashParam) {
    if (!PLATFORM_RE.test(platform.toLowerCase()) || !/^[0-9a-f]{64}$/.test(handleHashParam))
      return json(res, 400, { error: 'bad-query' });
    const row = store.resolveByHandleHash(handleHashParam);
    if (!row) return json(res, 404, { error: 'not-found' });
    return json(res, 200, { invite: row.bundle, verified: !!row.verified_at });
  }
  const un = url.searchParams.get('username');
  const fp = url.searchParams.get('fingerprint');
  if (un) return resolveUsername(store, un, res);
  if (fp && /^[0-9a-f]{64}$/.test(fp)) return resolveFingerprint(store, fp, res);
  return json(res, 400, { error: 'bad-query' });
}

// —— helpers ——

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('too-large'));
        req.destroy();
      } else data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
}

function makeLimiter({ max, windowMs }) {
  const seen = new Map();
  return (ip) => {
    const now = Date.now();
    // Expired entries are dead weight; sweep them once the map grows past a working set.
    // Without this, one entry per distinct client IP lives for the process lifetime —
    // unbounded growth on a long-running box.
    if (seen.size > 4096) {
      for (const [k, v] of seen) if (now > v.reset) seen.delete(k);
    }
    const e = seen.get(ip);
    if (!e || now > e.reset) {
      seen.set(ip, { n: 1, reset: now + windowMs });
      return true;
    }
    if (e.n >= max) return false;
    e.n++;
    return true;
  };
}
