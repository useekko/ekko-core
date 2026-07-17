import { describe, it, expect, beforeAll } from 'vitest';
import { sealBackup, openBackup, type BackupBlob } from '../src/core/backup.js';
import { deviceIdentity, generateMnemonic } from '../src/core/recovery.js';
import { fingerprintHex } from '../src/core/crypto.js';
import { b64uEncode } from '../src/core/b64.js';
import type { Req, Res } from '../src/core/rpc.js';

// The promise this file exists to keep: **the extension and the iOS app are interchangeable.**
// A blob sealed on the phone must reconstruct the same identity, with the same people, in the
// browser — otherwise "sync" is a word on a slide.
//
// So the flow below is deliberately the NEW-BROWSER one: a fresh extension with no vault signs in,
// finds a backup that something else wrote, and becomes that identity. The blob is sealed here with
// the plain `src/core/backup.ts` — the exact code the iOS app runs through its Swift port, which
// `npm run ios:interop` pins byte for byte.

// --- the identity that already exists somewhere else (say, the phone) ---
const MNEMONIC = generateMnemonic();
const IDENTITY = deviceIdentity(MNEMONIC, 0);
const BACKUP_PASS = 'lens marble orbit tunnel garden vivid';
const VAULT_PASS = 'a passphrase for this browser';

const PEER_A = deviceIdentity(generateMnemonic(), 0);
const PEER_B = deviceIdentity(generateMnemonic(), 0);

// --- a fake Supabase, holding exactly one row ---
let claimedHandle: string | null = null;
let publishedKey: string | null = null;
let serverBlob: BackupBlob | null = sealBackup(
  {
    mnemonic: MNEMONIC,
    contacts: [
      { bundle: b64uEncode(PEER_A.bundle), label: 'Mara', verified: true, addedAt: 1_700_000_000_000 },
      { bundle: b64uEncode(PEER_B.bundle), label: 'Ivan', verified: false, addedAt: 1_700_000_001_000 },
    ],
  },
  BACKUP_PASS,
);

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`;
}

const TOKEN = jwt({ sub: '11111111-2222-3333-4444-555555555555', email: 'kirill@useekko.app' });

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  if (url.includes('/auth/v1/verify')) {
    const body = JSON.parse(String(init?.body)) as { token: string };
    if (body.token !== '12345678') return json({ error_code: 'otp_expired' }, 403);
    return json({ access_token: TOKEN, refresh_token: 'refresh-me', expires_in: 3600 });
  }
  if (url.includes('/auth/v1/otp')) return json({});
  if (url.includes('/rest/v1/profiles')) {
    // One row, one handle — the account handle the onboarding "@you" road claims.
    if (method === 'GET') {
      return json(
        claimedHandle
          ? [{ user_id: 'uid', handle: claimedHandle, display_name: null, public_key: publishedKey }]
          : [],
      );
    }
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { handle: string };
      if (body.handle === 'taken')
        return json({ code: '23505', message: 'duplicate key value violates unique constraint "profiles_handle_key"' }, 409);
      claimedHandle = body.handle;
      return json([{ user_id: 'uid', handle: body.handle, display_name: null, public_key: null }], 201);
    }
    if (method === 'PATCH') {
      publishedKey = (JSON.parse(String(init?.body)) as { public_key: string }).public_key;
      return json([]);
    }
  }
  // syncAccount touches these after a claim publishes the key; empty is a fine answer here.
  if (url.includes('/rest/v1/connections')) return json([]);
  if (url.includes('/rest/v1/session_setups')) return json([]);
  if (url.includes('/rest/v1/key_backups')) {
    if (method === 'GET') return json(serverBlob ? [{ blob: serverBlob }] : []);
    if (method === 'POST') {
      serverBlob = (JSON.parse(String(init?.body)) as { blob: BackupBlob }).blob;
      return json([{ blob: serverBlob }], 201);
    }
    if (method === 'DELETE') {
      serverBlob = null;
      return json([]);
    }
  }
  return json({ message: `unexpected ${method} ${url}` }, 500);
}) as typeof fetch;

// --- in-memory chrome, installed before the service worker binds to it ---
function area() {
  const m = new Map<string, unknown>();
  return {
    async get(key: string | string[]) {
      const out: Record<string, unknown> = {};
      for (const k of Array.isArray(key) ? key : [key]) if (m.has(k)) out[k] = m.get(k);
      return out;
    },
    async set(obj: Record<string, unknown>) {
      for (const k of Object.keys(obj)) m.set(k, obj[k]);
    },
    async remove(key: string) {
      m.delete(key);
    },
  };
}

let listener: ((req: Req, sender: unknown, sendResponse: (r: Res) => void) => boolean) | null = null;
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: { local: area(), session: area() },
  runtime: {
    onMessage: { addListener: (fn: typeof listener) => (listener = fn) },
    getManifest: () => ({ version: '0.6.3' }),
  },
};

const call = (req: Req): Promise<Res> => new Promise((resolve) => listener!(req, {}, resolve));

beforeAll(async () => {
  await import('../src/background.js');
});

describe('a new browser adopts the identity from the account', () => {
  it('starts with nothing', async () => {
    expect((await call({ type: 'status' })).state).toBe('no-vault');
    expect((await call({ type: 'acctStatus' })).signedIn).toBe(false);
  });

  it('refuses a bad sign-in code instead of pretending', async () => {
    const bad = await call({ type: 'acctVerify', email: 'kirill@useekko.app', code: '00000000' });
    expect(bad.error).toBeTruthy();
    expect(bad.signedIn).toBeFalsy();
  });

  it('signs in and sees that a backup is waiting', async () => {
    const ok = await call({ type: 'acctVerify', email: 'kirill@useekko.app', code: '12345678' });
    expect(ok.ok).toBe(true);

    const status = await call({ type: 'acctStatus' });
    expect(status.signedIn).toBe(true);
    expect(status.email).toBe('kirill@useekko.app');
    expect(status.hasBackup).toBe(true);
  });

  it('will not open the backup with the wrong passphrase', async () => {
    const bad = await call({
      type: 'acctRestore',
      backupPassphrase: 'not the passphrase',
      passphrase: VAULT_PASS,
    });
    expect(bad.error).toBeTruthy();
    expect(bad.ok).toBeFalsy();
    // And it must not have half-restored anything on the way out.
    expect((await call({ type: 'status' })).state).toBe('no-vault');
  });

  it('restores the SAME identity the phone had, with its people', async () => {
    const done = await call({
      type: 'acctRestore',
      backupPassphrase: BACKUP_PASS,
      passphrase: VAULT_PASS,
    });
    expect(done.ok).toBe(true);

    // The whole point: same keys, so the same contacts can still reach this person.
    expect(done.fingerprintHex).toBe(fingerprintHex(IDENTITY.fingerprint));
    expect(done.restoredContacts).toBe(2);
    expect((await call({ type: 'status' })).state).toBe('unlocked');

    const { contacts } = await call({ type: 'contacts' });
    expect(contacts?.map((c) => c.label).sort()).toEqual(['Ivan', 'Mara']);
    // The verification a user did by comparing safety numbers has to survive the trip, or the
    // restore quietly downgrades every contact back to trust-on-first-use.
    expect(contacts?.find((c) => c.label === 'Mara')?.verified).toBe(true);
    expect(contacts?.find((c) => c.label === 'Ivan')?.verified).toBe(false);
  });

  it('will not clobber the identity it now has', async () => {
    const again = await call({
      type: 'acctRestore',
      backupPassphrase: BACKUP_PASS,
      passphrase: VAULT_PASS,
    });
    expect(again.error).toBe('vault-exists');
  });
});

describe('and can back up again, from here', () => {
  it('seals what this browser holds, and only ciphertext leaves', async () => {
    const NEW_PASS = 'a different backup passphrase';
    const up = await call({ type: 'acctBackup', backupPassphrase: NEW_PASS });
    expect(up.ok).toBe(true);

    // What the server now holds must open — with the new passphrase, to the same identity.
    const opened = openBackup(serverBlob!, NEW_PASS);
    expect(opened.mnemonic).toBe(MNEMONIC);
    expect(opened.contacts).toHaveLength(2);

    // …and must not contain the phrase in the clear.
    const onTheWire = JSON.stringify(serverBlob);
    for (const word of MNEMONIC.split(' ')) expect(onTheWire).not.toContain(word);
  });

  it('refuses to back up behind a passphrase too short to be worth it', async () => {
    const bad = await call({ type: 'acctBackup', backupPassphrase: 'short' });
    expect(bad.error).toBeTruthy();
  });

  it('can delete the copy from the account', async () => {
    expect((await call({ type: 'acctDeleteBackup' })).ok).toBe(true);
    expect(serverBlob).toBeNull();
    expect((await call({ type: 'acctStatus' })).hasBackup).toBe(false);
    // The keys are still right here — deleting the backup is not deleting the identity.
    expect((await call({ type: 'status' })).state).toBe('unlocked');
  });
});

// Onboarding's "@you, everywhere" road: the handle lives on the account, so a session is the
// PRECONDITION of claiming — the whole point of the fork is that no handle exists without
// registration.
describe('the account handle', () => {
  it('refuses a handle someone else got to first, in words a person can read', async () => {
    const res = await call({ type: 'acctClaim', handle: 'taken' });
    expect(res.error).toContain('taken');
    expect(res.error).not.toContain('23505'); // raw Postgres noise stays out of the UI
  });

  it('claims, surfaces through acctStatus, and fills the empty display username', async () => {
    const res = await call({ type: 'acctClaim', handle: 'kirill' });
    expect(res.ok).toBe(true);
    expect(res.handle).toBe('kirill');

    expect((await call({ type: 'acctStatus' })).handle).toBe('kirill');
    // Mirrored into the vault's display label — the slot was empty, so the claim may fill it.
    expect((await call({ type: 'invite' })).username).toBe('kirill');
  });

  it('never clobbers a display username that already exists', async () => {
    claimedHandle = null; // the server forgot; the vault did not
    const res = await call({ type: 'acctClaim', handle: 'someone_new' });
    expect(res.ok).toBe(true);
    expect((await call({ type: 'invite' })).username).toBe('kirill');
  });

  it('is gated on the session — signed out, there is no claim', async () => {
    await call({ type: 'acctSignOut' });
    const res = await call({ type: 'acctClaim', handle: 'ghost' });
    expect(res.error).toBe('signed-out');
  });
});
