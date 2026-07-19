import { describe, it, expect, beforeAll } from 'vitest';
import { generateIdentity } from '../src/core/crypto.js';
import { formatInvite } from '../src/core/wire.js';
import type { Req, Res } from '../src/core/rpc.js';

// In-memory chrome shim, installed BEFORE importing the service worker (mirrors
// test/background.test.ts). Deliberately NO `chrome.action`: the handler's badge calls are
// try/catch-wrapped, so a missing badge API must never fail the stage — and this proves it.
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
  tabs: { create: async () => ({}) },
  runtime: {
    onMessage: { addListener: (fn: typeof listener) => (listener = fn) },
    getManifest: () => ({ version: '0.7.1' }),
  },
};

const call = (req: Req): Promise<Res> => new Promise((resolve) => listener!(req, {}, resolve));
// A message arriving from a content script on a real web page, carrying its origin.
const callFromPage = (req: Req, origin: string): Promise<Res> =>
  new Promise((resolve) => listener!(req, { tab: {}, origin, url: `${origin}/i` }, resolve));

const PASS = 'correct horse battery staple';
const peek = async () => (await call({ type: 'pendingInvite' })).pendingInvite;

beforeAll(async () => {
  await import('../src/background.js'); // registers the listener against the shim
  await call({ type: 'create', passphrase: PASS }); // previewInvite needs an unlocked vault
});

describe('web invite link pickup', () => {
  it('origin gating: stages a link from useekko.app, refuses any other origin and stages nothing', async () => {
    const token = formatInvite(generateIdentity().bundle);

    // Wrong origin → refused before anything is stored.
    const evil = await callFromPage({ type: 'adoptInvite', invite: token }, 'https://evil.example');
    expect(evil.error).toBe('bad-origin');
    expect(await peek()).toBeNull();

    // The directory origin → staged as a token (badge API absent, yet the stage still succeeds).
    const ok = await callFromPage({ type: 'adoptInvite', invite: token }, 'https://useekko.app');
    expect(ok.ok).toBe(true);
    expect(await peek()).toEqual({ kind: 'token', raw: token });

    await call({ type: 'clearPendingInvite' });
    expect(await peek()).toBeNull();
  });

  it('install-gap persistence: a staged link is peeked (not consumed), previewed without adding, then cleared', async () => {
    const token = formatInvite(generateIdentity().bundle);
    await callFromPage({ type: 'adoptInvite', invite: token }, 'https://useekko.app');

    // Peek does NOT consume — reopening the popup keeps offering the same invite.
    expect(await peek()).toEqual({ kind: 'token', raw: token });
    expect(await peek()).toEqual({ kind: 'token', raw: token });

    // previewInvite shows the key's security code WITHOUT adding a contact (look ≠ trust).
    const before = (await call({ type: 'contacts' })).contacts!.length;
    const preview = await call({ type: 'previewInvite', invite: token });
    expect(preview.contact?.safetyNumber).toBeTruthy();
    expect((await call({ type: 'contacts' })).contacts!.length).toBe(before);

    // Only clearing drops it and its badge.
    await call({ type: 'clearPendingInvite' });
    expect(await peek()).toBeNull();
  });

  it('stages a handle link (normalized), and refuses a payload that is neither handle nor token', async () => {
    const h = await callFromPage({ type: 'adoptInvite', invite: '@Kirill' }, 'https://useekko.app');
    expect(h.ok).toBe(true);
    expect(await peek()).toEqual({ kind: 'handle', raw: 'kirill' }); // '@' stripped, lower-cased
    await call({ type: 'clearPendingInvite' });

    const junk = await callFromPage({ type: 'adoptInvite', invite: 'not an invite at all !!!' }, 'https://useekko.app');
    expect(junk.error).toBe('bad-invite');
    expect(await peek()).toBeNull();
  });
});
