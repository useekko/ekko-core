import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, diffieHellman, createPublicKey, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openStore } from '../src/store.mjs';
import { createApp } from '../src/app.mjs';

// The v2 directory authenticates publish via an X25519 ECDH ownership challenge, so these
// tests use REAL X25519 keys (node:crypto, which interoperates with the extension's noble
// X25519) and answer the challenge exactly as the client would. The 1184-byte ML-KEM half of
// the bundle is filler here — only the X25519 half participates in the proof.
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const rawToPub = (b64u) => createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(b64u, 'base64url')]), format: 'der', type: 'spki' });
const pubToRaw = (ko) => Buffer.from(new Uint8Array(ko.export({ type: 'spki', format: 'der' })).slice(12));
const sha = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const handleHash = (platform, handle) =>
  Buffer.from(sha(new TextEncoder().encode(`${platform}:${handle.toLowerCase().replace(/^@/, '')}`))).toString('hex');

function realIdentity(kFill = 1) {
  const kp = generateKeyPairSync('x25519');
  const bundle = Buffer.concat([Buffer.from([1]), pubToRaw(kp.publicKey), Buffer.alloc(1184, kFill)]);
  return { priv: kp.privateKey, invite: 'EKK1I:' + bundle.toString('base64url') };
}
// Answer an ownership challenge: ECDH(xPriv, ephPub) → sha256 → base64url (== the client's answerKeyChallenge).
function answer(id, challengeB64) {
  const shared = diffieHellman({ privateKey: id.priv, publicKey: rawToPub(challengeB64) });
  return Buffer.from(sha(new Uint8Array(shared))).toString('base64url');
}

async function withServer(fn, opts = {}) {
  const store = openStore(':memory:');
  const server = http.createServer(createApp(store, { rateLimit: { max: 10_000, windowMs: 60_000 }, ...opts }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
    store.close();
  }
}
const post = (base, path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Full authenticated claim: challenge → prove device key → create account.
async function claim(base, dev, username, rec) {
  const ch = await (await post(base, '/auth/challenge', { invite: dev.invite })).json();
  return post(base, '/u/claim', { challengeId: ch.challengeId, proof: answer(dev, ch.challenge), username, recovery: rec.invite });
}

test('v2: authenticated claim succeeds with a real proof and resolves the handle', async () => {
  await withServer(async (base) => {
    const dev = realIdentity(1);
    const rec = realIdentity(2);
    assert.equal((await claim(base, dev, 'alice', rec)).status, 200);
    const byName = await (await fetch(`${base}/u/alice`)).json();
    assert.equal(byName.invite, dev.invite);
    assert.equal(byName.verified, false);
  });
});

test('v2: a wrong proof is rejected (401), so handles cannot be hijacked', async () => {
  await withServer(async (base) => {
    const ch = await (await post(base, '/auth/challenge', { invite: realIdentity(3).invite })).json();
    // Answer with a DIFFERENT key than the one challenged.
    const bad = await post(base, '/u/claim', {
      challengeId: ch.challengeId,
      proof: answer(realIdentity(9), ch.challenge),
      username: 'bob',
      recovery: realIdentity(4).invite,
    });
    assert.equal(bad.status, 401);
    assert.equal((await bad.json()).error, 'bad-proof');
  });
});

test('v2: a challenge is one-time and a taken handle is 409', async () => {
  await withServer(async (base) => {
    const dev = realIdentity(1);
    const rec = realIdentity(2);
    const ch = await (await post(base, '/auth/challenge', { invite: dev.invite })).json();
    const proof = answer(dev, ch.challenge);
    assert.equal((await post(base, '/u/claim', { challengeId: ch.challengeId, proof, username: 'zoe', recovery: rec.invite })).status, 200);
    // Reusing the same challenge id fails (consumed).
    assert.equal((await post(base, '/u/claim', { challengeId: ch.challengeId, proof, username: 'zoe2', recovery: rec.invite })).status, 401);
    // A fresh, valid claim to the same handle by a different key is 409.
    assert.equal((await claim(base, realIdentity(5), 'zoe', realIdentity(6))).status, 409);
  });
});

test('v2: ownership challenges have a hard memory ceiling', async () => {
  await withServer(async (base) => {
    assert.equal((await post(base, '/auth/challenge', { invite: realIdentity(1).invite })).status, 200);
    const busy = await post(base, '/auth/challenge', { invite: realIdentity(2).invite });
    assert.equal(busy.status, 503);
    assert.equal((await busy.json()).error, 'directory-busy');
  }, { challengeLimit: 1 });
});

test('v2: an authenticated claim cannot shadow an existing legacy @handle', async () => {
  await withServer(async (base) => {
    const legacy = realIdentity(1);
    // Legacy unauthenticated claim (old /keys path).
    assert.equal((await post(base, '/keys', { invite: legacy.invite, username: 'bob' })).status, 200);
    // A v2 claim of the same name by a DIFFERENT key must be rejected.
    assert.equal((await claim(base, realIdentity(2), 'bob', realIdentity(3))).status, 409);
    // The legacy handle still resolves to the legacy key.
    assert.equal((await (await fetch(`${base}/u/bob`)).json()).invite, legacy.invite);
  });
});

test('v2: platform-handle link is first-claim-wins (no silent cross-account overwrite)', async () => {
  await withServer(async (base) => {
    const a = realIdentity(1);
    await claim(base, a, 'anna', realIdentity(2));
    const chA = await (await post(base, '/auth/challenge', { invite: a.invite })).json();
    assert.equal((await post(base, '/handles/link', { challengeId: chA.challengeId, proof: answer(a, chA.challenge), platform: 'instagram', handle: 'maya' })).status, 200);
    // A second account cannot steal the mapping — and is TOLD so, not silently ignored.
    const b = realIdentity(5);
    await claim(base, b, 'ben3', realIdentity(6));
    const chB = await (await post(base, '/auth/challenge', { invite: b.invite })).json();
    const steal = await post(base, '/handles/link', { challengeId: chB.challengeId, proof: answer(b, chB.challenge), platform: 'instagram', handle: 'maya' });
    assert.equal(steal.status, 409);
    assert.equal((await steal.json()).error, 'handle-taken');
    // Re-linking your own handle stays an idempotent success.
    const chA2 = await (await post(base, '/auth/challenge', { invite: a.invite })).json();
    assert.equal((await post(base, '/handles/link', { challengeId: chA2.challengeId, proof: answer(a, chA2.challenge), platform: 'instagram', handle: 'maya' })).status, 200);
    // Lookup still resolves to the first claimant.
    assert.equal(
      (await (await fetch(`${base}/lookup?platform=instagram&handle_hash=${handleHash('instagram', 'maya')}`)).json()).invite,
      a.invite,
    );
  });
});

test('v2: platform-handle link + hashed lookup resolves to the device key', async () => {
  await withServer(async (base) => {
    const dev = realIdentity(1);
    await claim(base, dev, 'maya', realIdentity(2));
    const ch = await (await post(base, '/auth/challenge', { invite: dev.invite })).json();
    const link = await post(base, '/handles/link', {
      challengeId: ch.challengeId,
      proof: answer(dev, ch.challenge),
      platform: 'instagram',
      handle: '@Maya',
    });
    assert.equal(link.status, 200);
    // The client hashes before transport, keeping the raw handle out of URL/proxy logs.
    const look = await (
      await fetch(`${base}/lookup?platform=instagram&handle_hash=${handleHash('instagram', 'maya')}`)
    ).json();
    assert.equal(look.invite, dev.invite);
    assert.equal(look.verified, false);
    assert.equal(
      (await fetch(`${base}/lookup?platform=instagram&handle_hash=${handleHash('instagram', 'nobody')}`)).status,
      404,
    );
    assert.equal((await fetch(`${base}/lookup?platform=instagram&handle=maya`)).status, 400);
  });
});

test('v2: recovery rotates the device key but keeps the handle', async () => {
  await withServer(async (base) => {
    const dev0 = realIdentity(1);
    const rec = realIdentity(2);
    await claim(base, dev0, 'kirill', rec);

    // Phrase restore: prove the recovery key and recover account metadata without rotating.
    const ch = await (await post(base, '/auth/challenge', { invite: rec.invite })).json();
    const metadata = await post(base, '/recover', { challengeId: ch.challengeId, proof: answer(rec, ch.challenge) });
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json()).username, 'kirill');
    assert.equal((await (await fetch(`${base}/u/kirill`)).json()).invite, dev0.invite);

    // A separate recovery proof may rotate to a fresh device key after real key loss.
    const rotateChallenge = await (await post(base, '/auth/challenge', { invite: rec.invite })).json();
    const dev1 = realIdentity(5);
    const rr = await post(base, '/recover', {
      challengeId: rotateChallenge.challengeId,
      proof: answer(rec, rotateChallenge.challenge),
      newBundle: dev1.invite,
    });
    assert.equal(rr.status, 200);

    // The handle now resolves to the NEW device key.
    assert.equal((await (await fetch(`${base}/u/kirill`)).json()).invite, dev1.invite);

    // A valid proof for a key that anchors NO account cannot rotate anyone (404).
    const stranger = realIdentity(8);
    const ch2 = await (await post(base, '/auth/challenge', { invite: stranger.invite })).json();
    const bad = await post(base, '/recover', {
      challengeId: ch2.challengeId,
      proof: answer(stranger, ch2.challenge),
      newBundle: realIdentity(9).invite,
    });
    assert.equal(bad.status, 404);
  });
});

test('deployment vhost proxies every v2 route and restores Cloudflare visitor IPs', () => {
  const nginx = readFileSync(new URL('../deploy/nginx-directory.conf', import.meta.url), 'utf8');
  for (const route of ['/auth/challenge', '/handles/link', '/handles/unlink', '/recover', '/verify/start', '/verify/check'])
    assert.match(nginx, new RegExp(`location = ${route.replace('/', '\\/')}`));
  assert.match(nginx, /location \^~ \/u\//); // covers POST /u/claim and GET /u/:handle
  assert.match(nginx, /real_ip_header CF-Connecting-IP;/);
  // Operator attestation must never be exposed through the public proxy.
  assert.doesNotMatch(nginx, /location[^\n]*\/admin/);
});
