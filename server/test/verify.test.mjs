import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, diffieHellman, createPublicKey, createHash } from 'node:crypto';
import { openStore } from '../src/store.mjs';
import { createApp } from '../src/app.mjs';
import { makeVerifier } from '../src/verify.mjs';
import { startTelegramPoller } from '../src/telegram.mjs';

// Same real-X25519 harness as directory-v2.test.mjs: the proof is a genuine ECDH answer.
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
function answer(id, challengeB64) {
  const shared = diffieHellman({ privateKey: id.priv, publicKey: rawToPub(challengeB64) });
  return Buffer.from(sha(new Uint8Array(shared))).toString('base64url');
}

// Server + verifier pair, so tests can drive HTTP like the extension AND the inbound bot
// path like the poller.
async function withVerifyServer(fn, opts = {}) {
  const store = openStore(':memory:');
  const verifier = makeVerifier(store, opts.verifier);
  verifier.setBot('telegram', 'EkkoVerifyBot');
  const server = http.createServer(
    createApp(store, { rateLimit: { max: 10_000, windowMs: 60_000 }, verifier, ...opts.app }),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, verifier, store);
  } finally {
    server.close();
    store.close();
  }
}
const post = (base, path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function claim(base, dev, username, rec) {
  const ch = await (await post(base, '/auth/challenge', { invite: dev.invite })).json();
  return post(base, '/u/claim', { challengeId: ch.challengeId, proof: answer(dev, ch.challenge), username, recovery: rec.invite });
}
async function authed(base, dev, path, extra) {
  const ch = await (await post(base, '/auth/challenge', { invite: dev.invite })).json();
  return post(base, path, { challengeId: ch.challengeId, proof: answer(dev, ch.challenge), ...extra });
}

test('verify: full ceremony — start, bot inbound, lookup flips verified, check returns the handle once', async () => {
  await withVerifyServer(async (base, verifier) => {
    const dev = realIdentity(1);
    await claim(base, dev, 'maya', realIdentity(2));

    const started = await authed(base, dev, '/verify/start', { platform: 'telegram' });
    assert.equal(started.status, 200);
    const { code, checkId, bot } = await started.json();
    assert.match(code, /^EKKO-[A-HJ-KM-NP-Z2-9]{6}$/);
    assert.equal(bot.username, 'EkkoVerifyBot');

    // Pending until the bot hears from the claimed account.
    assert.deepEqual(await (await fetch(`${base}/verify/check?id=${checkId}`)).json(), {
      status: 'pending',
      platform: 'telegram',
    });

    // Inbound message from @Maya_TG carrying the code — what the poller forwards.
    const outcome = verifier.consumeInbound('telegram', 'Maya_TG', `hi ${code}`);
    assert.deepEqual(outcome, { status: 'verified', handle: 'maya_tg' });

    // The mapping is verified and resolves to the account's device key.
    const look = await (await fetch(`${base}/lookup?platform=telegram&handle_hash=${handleHash('telegram', 'maya_tg')}`)).json();
    assert.equal(look.invite, dev.invite);
    assert.equal(look.verified, true);

    // check returns the platform-asserted handle exactly once (heals the client's local copy)...
    const first = await (await fetch(`${base}/verify/check?id=${checkId}`)).json();
    assert.deepEqual(first, { status: 'verified', platform: 'telegram', handle: 'maya_tg' });
    // ...and stays "verified" (without replaying the plaintext) afterwards.
    const second = await (await fetch(`${base}/verify/check?id=${checkId}`)).json();
    assert.deepEqual(second, { status: 'verified', platform: 'telegram' });
  });
});

test('verify: codes are one-time, platform-bound, and expire', async () => {
  await withVerifyServer(async (base, verifier, store) => {
    const dev = realIdentity(1);
    await claim(base, dev, 'kai', realIdentity(2));
    const { code } = await (await authed(base, dev, '/verify/start', { platform: 'telegram' })).json();

    // Wrong platform: a telegram code sent to a hypothetical instagram bot proves nothing.
    assert.equal(verifier.consumeInbound('instagram', 'kai_ig', code).status, 'bad-code');
    // No sender username: nothing to verify.
    assert.equal(verifier.consumeInbound('telegram', undefined, code).status, 'no-handle');
    // Garbage text: politely asked for a code.
    assert.equal(verifier.consumeInbound('telegram', 'kai_tg', 'hello?').status, 'no-code');

    assert.equal(verifier.consumeInbound('telegram', 'kai_tg', code).status, 'verified');
    // Replay is dead.
    assert.equal(verifier.consumeInbound('telegram', 'other_tg', code).status, 'bad-code');

    // Expiry: issue directly with a clock we control, then consume after TTL.
    const user = store.userIdByUsername('kai');
    const issued = verifier.issue(user.id, 'telegram', 1000);
    assert.equal(verifier.consumeInbound('telegram', 'kai_tg', issued.code, issued.expiresAt + 1).status, 'bad-code');
    // And an expired pending check reads as gone.
    assert.equal((await fetch(`${base}/verify/check?id=${issued.checkId}`)).status, 404);
  });
});

test('verify: fresh platform proof displaces an unverified squatter and retires own stale mappings', async () => {
  await withVerifyServer(async (base, verifier) => {
    // Squatter reserves telegram:@zoe_tg without owning it.
    const squatter = realIdentity(1);
    await claim(base, squatter, 'squatter', realIdentity(2));
    assert.equal((await authed(base, squatter, '/handles/link', { platform: 'telegram', handle: 'zoe_tg' })).status, 200);

    // Zoe proves control of the real account: she wins the mapping.
    const zoe = realIdentity(5);
    await claim(base, zoe, 'zoe', realIdentity(6));
    const { code } = await (await authed(base, zoe, '/verify/start', { platform: 'telegram' })).json();
    assert.equal(verifier.consumeInbound('telegram', 'zoe_tg', code).status, 'verified');
    const look = await (await fetch(`${base}/lookup?platform=telegram&handle_hash=${handleHash('telegram', 'zoe_tg')}`)).json();
    assert.equal(look.invite, zoe.invite);
    assert.equal(look.verified, true);

    // Zoe renames on Telegram and re-verifies: the old verified mapping must not linger.
    const again = await (await authed(base, zoe, '/verify/start', { platform: 'telegram' })).json();
    assert.equal(verifier.consumeInbound('telegram', 'zoe_renamed', again.code).status, 'verified');
    assert.equal((await fetch(`${base}/lookup?platform=telegram&handle_hash=${handleHash('telegram', 'zoe_tg')}`)).status, 404);
    assert.equal(
      (await (await fetch(`${base}/lookup?platform=telegram&handle_hash=${handleHash('telegram', 'zoe_renamed')}`)).json()).verified,
      true,
    );
  });
});

test('verify: start requires a proven key with an account, and an off verifier says so', async () => {
  await withVerifyServer(async (base, verifier) => {
    const dev = realIdentity(1);
    // No account yet → 404, same as the other authenticated writes.
    assert.equal((await authed(base, dev, '/verify/start', { platform: 'telegram' })).status, 404);
    await claim(base, dev, 'ana', realIdentity(2));
    // Bad proof → 401.
    const ch = await (await post(base, '/auth/challenge', { invite: dev.invite })).json();
    const forged = await post(base, '/verify/start', {
      challengeId: ch.challengeId,
      proof: answer(realIdentity(9), ch.challenge),
      platform: 'telegram',
    });
    assert.equal(forged.status, 401);
    // A platform nobody verifies → 503 verify-unavailable.
    const insta = await authed(base, dev, '/verify/start', { platform: 'instagram' });
    assert.equal(insta.status, 503);
    assert.equal((await insta.json()).error, 'verify-unavailable');
  });
});

test('unlink: a user can remove their own mapping; proof required; idempotent', async () => {
  await withVerifyServer(async (base) => {
    const dev = realIdentity(1);
    await claim(base, dev, 'rob', realIdentity(2));
    assert.equal((await authed(base, dev, '/handles/link', { platform: 'instagram', handle: 'rob_ig' })).status, 200);
    assert.equal((await fetch(`${base}/lookup?platform=instagram&handle_hash=${handleHash('instagram', 'rob_ig')}`)).status, 200);

    // A different key cannot unlink Rob's mapping (it has no account → 404).
    assert.equal((await authed(base, realIdentity(5), '/handles/unlink', { platform: 'instagram' })).status, 404);

    assert.equal((await authed(base, dev, '/handles/unlink', { platform: 'instagram' })).status, 200);
    assert.equal((await fetch(`${base}/lookup?platform=instagram&handle_hash=${handleHash('instagram', 'rob_ig')}`)).status, 404);
    // Unlinking again stays 200 — gone is gone.
    assert.equal((await authed(base, dev, '/handles/unlink', { platform: 'instagram' })).status, 200);
    // Freed by unlink: someone else may now claim it.
    const eve = realIdentity(6);
    await claim(base, eve, 'eve', realIdentity(7));
    assert.equal((await authed(base, eve, '/handles/link', { platform: 'instagram', handle: 'rob_ig' })).status, 200);
  });
});

test('admin: absent token = the namespace does not exist; with it, attest + unlink work', async () => {
  // No adminToken configured → 404 even with a bearer.
  await withVerifyServer(async (base) => {
    const r = await post(base, '/admin/verify', { username: 'x', platform: 'instagram', handle: 'y' }, { authorization: 'Bearer nope' });
    assert.equal(r.status, 404);
  });

  await withVerifyServer(
    async (base) => {
      const dev = realIdentity(1);
      await claim(base, dev, 'demo1', realIdentity(2));

      const auth = { authorization: 'Bearer s3cret' };
      // Wrong/missing token is indistinguishable from absent routes.
      assert.equal((await post(base, '/admin/verify', { username: 'demo1', platform: 'instagram', handle: 'rabbit' }, { authorization: 'Bearer wrong' })).status, 404);
      assert.equal((await post(base, '/admin/verify', { username: 'demo1', platform: 'instagram', handle: 'rabbit' })).status, 404);

      // Attest: this is how early-access platforms without a bot get verified.
      const ok = await post(base, '/admin/verify', { username: 'demo1', platform: 'instagram', handle: '@Rabbit' }, auth);
      assert.equal(ok.status, 200);
      const look = await (await fetch(`${base}/lookup?platform=instagram&handle_hash=${handleHash('instagram', 'rabbit')}`)).json();
      assert.equal(look.invite, dev.invite);
      assert.equal(look.verified, true);

      // Unknown ekko handle → 404 no-account.
      assert.equal((await post(base, '/admin/verify', { username: 'ghost', platform: 'instagram', handle: 'z' }, auth)).status, 404);

      // Admin unlink removes it whoever owns it.
      const gone = await post(base, '/admin/unlink', { platform: 'instagram', handle: 'rabbit' }, auth);
      assert.equal((await gone.json()).removed, 1);
      assert.equal((await fetch(`${base}/lookup?platform=instagram&handle_hash=${handleHash('instagram', 'rabbit')}`)).status, 404);
    },
    { app: { adminToken: 's3cret' } },
  );
});

test('telegram poller: getMe registers the bot, inbound codes verify, and the sender is answered', async () => {
  const store = openStore(':memory:');
  const verifier = makeVerifier(store);
  store.createAccount('lena', 'fp', 'RB', 'EKK1I:x', 'dh', Date.now());
  const user = store.userIdByUsername('lena');
  const { code } = verifier.issue(user.id, 'telegram');

  const calls = [];
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const fetchImpl = async (url, init) => {
    const method = url.match(/\/(getMe|getUpdates|sendMessage)$/)?.[1];
    const params = JSON.parse(init.body);
    calls.push({ method, params });
    const respond = (result) => new Response(JSON.stringify({ ok: true, result }));
    if (method === 'getMe') return respond({ username: 'EkkoVerifyBot' });
    if (method === 'getUpdates') {
      if (calls.filter((c) => c.method === 'getUpdates').length === 1)
        return respond([{ update_id: 7, message: { from: { username: 'Lena_TG', is_bot: false }, chat: { id: 42 }, text: `/start ${code}` } }]);
      resolveDone();
      await new Promise(() => {}); // park: the test stops the poller
    }
    if (method === 'sendMessage') return respond({});
    throw new Error(`unexpected ${url}`);
  };

  const poller = startTelegramPoller({ token: 'T', verifier, fetchImpl, log: () => {} });
  await done;
  poller.stop();

  assert.equal(verifier.botUsername('telegram'), 'EkkoVerifyBot');
  // The deep-link /start payload carried the code; the mapping is now verified.
  assert.ok(store.resolveByHandleHash(handleHash('telegram', 'lena_tg'))?.verified_at);
  const reply = calls.find((c) => c.method === 'sendMessage');
  assert.equal(reply.params.chat_id, 42);
  assert.match(reply.params.text, /Verified\. @lena_tg/);
  // The second poll confirmed the update (offset advanced past it).
  assert.equal(calls.filter((c) => c.method === 'getUpdates')[1].params.offset, 8);
  store.close();
});
