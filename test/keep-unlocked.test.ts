import { describe, it, expect, vi } from 'vitest';
import type { Req, Res } from '../src/core/rpc.js';

// "Keep me unlocked on this device" — the consumer-grade unlock model. storage.session dies
// with the browser, so these tests simulate a BROWSER RESTART for real: wipe the session
// area and the in-memory module state (vi.resetModules + re-import), keep storage.local.
// What must hold: opt-in survives the restart unlocked; the default stays locked; a
// deliberate Lock locks NOW but keeps the preference; disabling removes the persisted key.

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
    _m: m,
  };
}

let listener: ((req: Req, sender: unknown, sendResponse: (r: Res) => void) => boolean) | null = null;
const local = area();
const session = area();
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: { local, session },
  tabs: { create: async () => ({}) },
  runtime: {
    onMessage: { addListener: (fn: typeof listener) => (listener = fn) },
    getManifest: () => ({ version: '0.0.0' }),
  },
};

const call = (req: Req): Promise<Res> => new Promise((resolve) => listener!(req, {}, resolve));

// A browser restart: the service worker's module state and everything in storage.session
// are gone; storage.local survives. Re-importing registers a fresh listener.
async function restartBrowser() {
  session._m.clear();
  vi.resetModules();
  await import('../src/background.js');
}

const PASS = 'correct horse battery staple';

describe('keep unlocked on this device', () => {
  it('default (opted out): a browser restart locks Ekko, exactly as before', async () => {
    await restartBrowser(); // initial load
    expect((await call({ type: 'create', passphrase: PASS })).ok).toBe(true);
    expect((await call({ type: 'status' })).state).toBe('unlocked');

    await restartBrowser();
    expect((await call({ type: 'status' })).state).toBe('locked');
    // And nothing key-like sits in storage.local without the opt-in.
    expect(local._m.has('rsn.masterLocal')).toBe(false);
  });

  it('opting in at the unlock screen survives restarts; a wrong passphrase cannot opt in', async () => {
    // The choice rides the unlock request but lands only after the passphrase proves right.
    expect((await call({ type: 'unlock', passphrase: 'wrong-wrong-wrong', keepUnlocked: true })).error).toBe('wrong-passphrase');
    expect(local._m.has('rsn.masterLocal')).toBe(false);
    expect(local._m.get('rsn.keepUnlocked')).toBeUndefined();

    expect((await call({ type: 'unlock', passphrase: PASS, keepUnlocked: true })).ok).toBe(true);
    expect(local._m.has('rsn.masterLocal')).toBe(true);

    await restartBrowser();
    expect((await call({ type: 'status' })).state).toBe('unlocked');
    // Usable, not just nominally unlocked: the vault actually opens.
    expect((await call({ type: 'contacts' })).contacts).toBeDefined();
    expect((await call({ type: 'getSettings' })).keepUnlocked).toBe(true);
  });

  it('a passphrase change refreshes the persisted key, so the next restart still opens', async () => {
    const NEW = 'staple battery horse correct!';
    expect((await call({ type: 'changePassphrase', oldPassphrase: PASS, newPassphrase: NEW })).ok).toBe(true);
    await restartBrowser();
    expect((await call({ type: 'status' })).state).toBe('unlocked');
  });

  it('a deliberate Lock locks NOW (both key copies gone) but the preference survives', async () => {
    expect((await call({ type: 'lock' })).ok).toBe(true);
    expect(local._m.has('rsn.masterLocal')).toBe(false);
    expect((await call({ type: 'status' })).state).toBe('locked');
    expect((await call({ type: 'getSettings' })).keepUnlocked).toBe(true);

    // The next unlock (checkbox untouched → no field) re-persists from the standing pref.
    expect((await call({ type: 'unlock', passphrase: 'staple battery horse correct!' })).ok).toBe(true);
    expect(local._m.has('rsn.masterLocal')).toBe(true);
    await restartBrowser();
    expect((await call({ type: 'status' })).state).toBe('unlocked');
  });

  it('turning it off removes the persisted key immediately; the next restart locks', async () => {
    expect((await call({ type: 'setKeepUnlocked', enabled: false })).ok).toBe(true);
    expect(local._m.has('rsn.masterLocal')).toBe(false);
    expect((await call({ type: 'status' })).state).toBe('unlocked'); // this session is untouched

    await restartBrowser();
    expect((await call({ type: 'status' })).state).toBe('locked');
  });

  it('turning it on from Settings persists the live key without a re-unlock', async () => {
    expect((await call({ type: 'unlock', passphrase: 'staple battery horse correct!' })).ok).toBe(true);
    expect(local._m.has('rsn.masterLocal')).toBe(false); // pref is off; unlock alone persists nothing
    expect((await call({ type: 'setKeepUnlocked', enabled: true })).ok).toBe(true);
    expect(local._m.has('rsn.masterLocal')).toBe(true);
    await restartBrowser();
    expect((await call({ type: 'status' })).state).toBe('unlocked');
  });
});
