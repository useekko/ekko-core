import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { validateInvite, normalizeUsername, normalizeEmail } from '../src/validate.mjs';
import { openStore } from '../src/store.mjs';
import { createApp } from '../src/app.mjs';

// A shape-valid (not cryptographically real) invite: 1217-byte bundle, version byte = 1.
function fakeInvite(seed = 7) {
  const bundle = Buffer.alloc(1217, seed);
  bundle[0] = 1;
  return 'EKK1I:' + bundle.toString('base64url');
}
const fpOf = (invite) => createHash('sha256').update(Buffer.from(invite.slice(6), 'base64url')).digest('hex');

test('validateInvite accepts a well-formed invite and rejects malformed ones', () => {
  const invite = fakeInvite();
  assert.equal(validateInvite(invite).fingerprint, fpOf(invite));
  const legacy = 'RSN1I:' + invite.slice(6);
  assert.equal(validateInvite(legacy).fingerprint, fpOf(legacy));
  assert.equal(validateInvite('EKK1I:' + Buffer.alloc(10).toString('base64url')), null); // wrong length
  assert.equal(validateInvite(invite.slice(0, -1) + '!'), null); // invalid base64url character
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const encoded = invite.slice(6);
  const last = alphabet.indexOf(encoded.at(-1));
  assert.equal(last & 3, 0); // 1217 bytes leave two unused bits in the final character
  assert.equal(validateInvite('EKK1I:' + encoded.slice(0, -1) + alphabet[last | 1]), null); // non-canonical padding bits
  assert.equal(validateInvite('nope'), null);
  const badVer = Buffer.alloc(1217, 3);
  assert.equal(validateInvite('EKK1I:' + badVer.toString('base64url')), null); // version byte != 1
});

test('normalizeUsername enforces the charset', () => {
  assert.equal(normalizeUsername('Alice_01'), 'alice_01');
  assert.equal(normalizeUsername('ab'), null); // too short
  assert.equal(normalizeUsername('has spaces'), null);
});

test('store: publish, resolve, and first-come username claims', () => {
  const s = openStore(':memory:');
  const inv = fakeInvite(9);
  const fp = fpOf(inv);
  s.putKey(fp, inv, 1);
  assert.equal(s.getKey(fp).invite, inv);
  assert.equal(s.claimUsername('alice', fp, 1), 'ok');
  assert.equal(s.claimUsername('alice', fp, 1), 'ok'); // re-claim by same key is fine
  assert.equal(s.claimUsername('alice', fpOf(fakeInvite(10)), 1), 'taken'); // different key blocked
  assert.equal(s.claimUsername('alice2', fp, 1), 'already-claimed'); // one username per key
  assert.equal(s.resolveUsername('alice').invite, inv);
  s.close();
});

// spin the real HTTP handler on an ephemeral port
async function withServer(fn) {
  const store = openStore(':memory:');
  const server = http.createServer(createApp(store));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
    store.close();
  }
}

test('HTTP: publish then resolve by username and fingerprint', async () => {
  await withServer(async (base) => {
    const inv = fakeInvite(11);
    const fp = fpOf(inv);

    const pub = await fetch(`${base}/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invite: inv, username: 'Bob' }),
    });
    assert.equal(pub.status, 200);
    const pj = await pub.json();
    assert.equal(pj.fingerprint, fp);
    assert.equal(pj.username, 'bob');
    assert.equal(pj.verified, false); // never claims verification

    const byName = await (await fetch(`${base}/u/bob`)).json();
    assert.equal(byName.invite, inv);

    const byFp = await (await fetch(`${base}/keys/${fp}`)).json();
    assert.equal(byFp.invite, inv);

    assert.equal((await fetch(`${base}/u/nobody`)).status, 404);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
});

test('HTTP: a taken username is rejected with 409', async () => {
  await withServer(async (base) => {
    const post = (invite, username) =>
      fetch(`${base}/keys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite, username }) });
    assert.equal((await post(fakeInvite(1), 'zoe')).status, 200);
    assert.equal((await post(fakeInvite(2), 'zoe')).status, 409); // different key, same name
  });
});

test('HTTP: one key cannot claim two usernames', async () => {
  await withServer(async (base) => {
    const invite = fakeInvite(4);
    const post = (username) =>
      fetch(`${base}/keys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite, username }) });
    assert.equal((await post('one')).status, 200);
    const second = await post('two');
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error, 'username-exists');
  });
});

test('HTTP: bad invite and bad username are rejected', async () => {
  await withServer(async (base) => {
    const post = (body) => fetch(`${base}/keys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ invite: 'garbage' })).status, 400);
    assert.equal((await post({ invite: fakeInvite(3), username: 'no' })).status, 400);
  });
});

test('HTTP: malformed username escapes are rejected as bad input', async () => {
  await withServer(async (base) => {
    for (const path of ['/u/%', '/u/%E0%A4%A']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'bad-username' });
    }
  });
});

test('waitlist: valid emails 204 (idempotent), junk 400, and no enumeration', async () => {
  await withServer(async (base) => {
    const post = (body) =>
      fetch(`${base}/waitlist`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ email: 'Ada@Example.COM ' })).status, 204);
    assert.equal((await post({ email: 'ada@example.com' })).status, 204); // duplicate is indistinguishable
    assert.equal((await post({ email: 'not-an-email' })).status, 400);
    assert.equal((await post({ email: 'x@nodot' })).status, 400);
    assert.equal((await post({})).status, 400); // five POSTs total — inside the 5/10min waitlist budget
    assert.equal((await fetch(`${base}/waitlist`)).status, 404); // no GET — the list is write-only
  });
});

test('waitlist: normalizeEmail bounds', () => {
  assert.equal(normalizeEmail(' User@Site.io '), 'user@site.io');
  assert.equal(normalizeEmail('a@' + 'b'.repeat(250) + '.io'), null); // over 254 total
  assert.equal(normalizeEmail(42), null);
  assert.equal(normalizeEmail('a b@example.com'), null);
  assert.equal(normalizeEmail('trailingdot@site.'), null);
});

test('bug reports are not the origin\'s job any more: /bug is gone (worker + Supabase own it)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/bug`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'the wire card overlaps the nav on iPad' }),
    });
    assert.equal(res.status, 404);
  });
});
