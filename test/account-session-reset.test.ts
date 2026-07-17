import { describe, it, expect, beforeAll } from 'vitest';
import type { Req, Res } from '../src/core/rpc.js';

// create() must not inherit a stale account session. A brand-new identity is signed into nobody, so
// acctStatus must say so — otherwise the popup claims "signed in as kvasilev" for an account this
// identity never touched (the exact bug: create left an old Google session sitting in storage).
// adopt=true is the one exception: a deliberate reset that keeps the account and republishes onto it.

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`;
}
const TOKEN = jwt({ sub: 'uid-1', email: 'kvasilev@berkeley.edu' });

globalThis.fetch = (async (input: string | URL) => {
  const url = String(input);
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
  if (url.includes('/auth/v1/verify')) return json({ access_token: TOKEN, refresh_token: 'r', expires_in: 3600 });
  if (url.includes('/rest/v1/key_backups')) return json([]); // no backup
  return json([]); // profiles / connections / account_handles: empty is fine for this test
}) as typeof fetch;

function area() {
  const m = new Map<string, unknown>();
  return {
    async get(k: string | string[]) {
      const o: Record<string, unknown> = {};
      for (const x of Array.isArray(k) ? k : [k]) if (m.has(x)) o[x] = m.get(x);
      return o;
    },
    async set(o: Record<string, unknown>) {
      for (const x of Object.keys(o)) m.set(x, o[x]);
    },
    async remove(k: string) {
      m.delete(k);
    },
  };
}
let listener: ((req: Req, s: unknown, r: (x: Res) => void) => boolean) | null = null;
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: { local: area(), session: area() },
  tabs: { create: async () => ({}) },
  runtime: {
    onMessage: { addListener: (fn: typeof listener) => (listener = fn) },
    getManifest: () => ({ version: '0.6.3' }),
  },
};
const call = (req: Req): Promise<Res> => new Promise((res) => listener!(req, {}, res));

describe('create() does not inherit a stale account session', () => {
  beforeAll(async () => {
    await import('../src/background.js');
  });

  it('a brand-new identity is signed into nobody, even with a session sitting in storage', async () => {
    // A session is in storage (as if a Google sign-in happened in an earlier test round).
    await call({ type: 'acctVerify', email: 'kvasilev@berkeley.edu', code: '12345678' });
    expect((await call({ type: 'acctStatus' })).signedIn).toBe(true);

    // Create a fresh identity WITHOUT adopt. The phantom must be gone.
    const created = await call({ type: 'create', passphrase: 'a password for this browser' });
    expect(created.ok).toBe(true);
    expect((await call({ type: 'acctStatus' })).signedIn).toBe(false);
  });
});
