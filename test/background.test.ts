import { describe, it, expect, beforeAll, vi } from 'vitest';
import { generateIdentity, startHandshake, acceptHandshake, openMessage, sealMessage } from '../src/core/crypto.js';
import { formatInvite, formatHandshake, formatMessage, classify, decodeBody } from '../src/core/wire.js';
import { b64uDecode, b64uEncode } from '../src/core/b64.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { manualThreadId, scopedThreadId } from '../src/core/thread.js';
import { generateMnemonic } from '../src/core/recovery.js';
import { decryptVault, deriveMaster, encryptVault } from '../src/core/vault.js';
import type { Req, Res } from '../src/core/rpc.js';

// In-memory chrome shim. Installed on globalThis BEFORE importing the service worker so
// its top-level `const ext = chrome` and onMessage registration bind to it.
function area() {
  const m = new Map<string, unknown>();
  return {
    // Real chrome.storage.get accepts a string or an array of keys.
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
const tabsOpened: string[] = [];
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: { local: area(), session: area() },
  tabs: {
    create: async (o: { url: string }) => {
      tabsOpened.push(o.url);
      return {};
    },
  },
  runtime: {
    onMessage: { addListener: (fn: typeof listener) => (listener = fn) },
    getManifest: () => ({ version: '0.2.0' }),
  },
};

function call(req: Req): Promise<Res> {
  return new Promise((resolve) => listener!(req, {}, resolve));
}

function callFromTab(req: Req): Promise<Res> {
  return new Promise((resolve) => listener!(req, { tab: {} }, resolve));
}

/// A message arriving from a content script on a real web page.
function callFromPage(req: Req, origin: string): Promise<Res> {
  return new Promise((resolve) => listener!(req, { tab: {}, origin, url: `${origin}/` }, resolve));
}

let reconcileContactKeys: typeof import('../src/background.js').reconcileContactKeys;
beforeAll(async () => {
  ({ reconcileContactKeys } = await import('../src/background.js')); // registers the message listener against the shim
});

const PASS = 'correct horse battery staple';
const thread = (id: string) => scopedThreadId('instagram', id);

describe('background handler', () => {
  it('onboards, then reports unlocked with a fingerprint', async () => {
    expect((await call({ type: 'status' })).state).toBe('no-vault');
    const created = await call({ type: 'create', passphrase: PASS });
    expect(created.ok).toBe(true);
    expect(created.invite?.startsWith('EKK1I:')).toBe(true);
    const st = await call({ type: 'status' });
    expect(st.state).toBe('unlocked');
    expect(st.fingerprintHex).toBeTruthy();
  });

  it('adds a contact with a chosen label and rejects your own invite', async () => {
    const bob = generateIdentity();
    const added = await call({ type: 'addContact', invite: formatInvite(bob.bundle), label: 'Bob' });
    expect(added.contact?.label).toBe('Bob');
    expect(added.contact?.verified).toBe(false);

    const me = await call({ type: 'invite' });
    const self = await call({ type: 'addContact', invite: me.invite! });
    expect(self.error).toBe('thats-you');

    // QR import only extracts a standalone token; the background remains the
    // authority that rejects a lexical-looking but cryptographically invalid invite.
    expect((await call({ type: 'addContact', invite: 'RSN1I:damaged' })).error).toBe('bad-invite');
  });

  it('reports the configured directory and only ever calls it over https', async () => {
    expect((await call({ type: 'getSettings' })).directory).toBe('https://useekko.app');

    // No test should hit the real network — stub fetch and confirm both RPCs actually reach
    // out (proving the directory isn't silently disabled) using nothing but an https URL.
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      seen.push(String(url));
      throw new Error('network disabled in tests');
    }) as typeof fetch;
    try {
      expect((await call({ type: 'dirClaim', username: 'alice' })).error).toBe('directory-unreachable');
      expect((await call({ type: 'dirAdd', username: 'alice' })).error).toBe('directory-unreachable');
    } finally {
      globalThis.fetch = realFetch;
    }
    // dirClaim is now authenticated: it starts the ownership challenge (phrase-derived vault).
    expect(seen).toEqual(['https://useekko.app/auth/challenge', 'https://useekko.app/u/alice']);
  });

  it('setDirectory points this install at a self-hosted directory — https or nothing', async () => {
    // Plaintext is refused outright; nothing changes.
    expect((await call({ type: 'setDirectory', url: 'http://my-directory.example' })).error).toBe('directory-insecure');
    expect((await call({ type: 'getSettings' })).directory).toBe('https://useekko.app');

    // An https override takes effect for every directory call that follows.
    const set = await call({ type: 'setDirectory', url: 'https://my-directory.example/' });
    expect(set.directory).toBe('https://my-directory.example');
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      seen.push(String(url));
      throw new Error('network disabled in tests');
    }) as typeof fetch;
    try {
      await call({ type: 'dirAdd', username: 'alice' });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toEqual(['https://my-directory.example/u/alice']);

    // Empty string resets to the built-in default.
    expect((await call({ type: 'setDirectory', url: '' })).directory).toBe('https://useekko.app');
    expect((await call({ type: 'getSettings' })).directory).toBe('https://useekko.app');
  });

  it('dirLookup previews a handle — with its security code — and adds NOTHING', async () => {
    const maya = generateIdentity();
    const before = (await call({ type: 'contacts' })).contacts!.length;
    const me = await call({ type: 'invite' });

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/u/maya'))
        return new Response(JSON.stringify({ invite: formatInvite(maya.bundle) }), { status: 200 });
      if (u.endsWith('/u/myself')) return new Response(JSON.stringify({ invite: me.invite }), { status: 200 });
      return new Response('', { status: 404 });
    }) as typeof fetch;
    try {
      const seen = await call({ type: 'dirLookup', username: 'maya' });
      expect(seen.contact?.label).toBe('@maya');
      // The point of the preview: you are shown the code that names their key BEFORE you take it.
      expect(seen.contact?.safetyNumber).toBeTruthy();

      // …and looking is not trusting. The vault is untouched.
      expect((await call({ type: 'contacts' })).contacts!.length).toBe(before);

      // Only the explicit add commits — and it commits the very key that was previewed. If these
      // two ever diverged, the preview would be a lie and the code you compared would be the
      // wrong one.
      const added = await call({ type: 'dirAdd', username: 'maya' });
      expect(added.contact?.fingerprint).toBe(seen.contact?.fingerprint);
      expect(added.contact?.safetyNumber).toBe(seen.contact?.safetyNumber);
      expect((await call({ type: 'contacts' })).contacts!.length).toBe(before + 1);

      expect((await call({ type: 'dirLookup', username: 'nobody' })).error).toBe('not-found');
      // Your own handle is not a stranger, even in a preview.
      expect((await call({ type: 'dirLookup', username: 'myself' })).error).toBe('thats-you');

      // Leave the vault as we found it: the tests below this one count contacts.
      await call({ type: 'removeContact', fingerprint: added.contact!.fingerprint });
      expect((await call({ type: 'contacts' })).contacts!.length).toBe(before);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('REGRESSION: never auto-encrypts an unlinked chat to the sole contact', async () => {
    // With exactly one contact (Bob, just added) an unbound thread must NOT auto-bind —
    // that used to silently encrypt to Bob when you opened a chat with someone else.
    expect((await call({ type: 'contacts' })).contacts!.length).toBe(1);
    const res = await call({ type: 'encrypt', threadId: thread('brand-new-chat'), plaintext: 'hi' });
    expect(res.error).toBe('no-contact');
    expect(res.tokens).toBeUndefined();
  });

  it('adds and links an in-chat invite only after an explicit tab action', async () => {
    const peer = generateIdentity();
    const t = thread('invite-link');
    const req: Req = { type: 'acceptInvite', threadId: t, invite: formatInvite(peer.bundle), label: 'Invite peer' };

    // The popup/manual path must keep using addContact + explicit linking; it cannot turn
    // arbitrary pasted text into a live chat binding through this convenience endpoint.
    expect((await call(req)).error).toBe('invite-only');
    const linked = await callFromTab(req);
    expect(linked.contact?.label).toBe('Invite peer');
    expect((await call({ type: 'threadContact', threadId: t })).contact?.fingerprint).toBe(linked.contact?.fingerprint);

    // A stale second click cannot overwrite a link that another Ekko view made.
    const other = generateIdentity();
    expect(
      (await callFromTab({ type: 'acceptInvite', threadId: t, invite: formatInvite(other.bundle), label: 'Other' })).error,
    ).toBe('already-linked');
    expect((await call({ type: 'threadContact', threadId: t })).contact?.fingerprint).toBe(linked.contact?.fingerprint);
  });

  it('renames and verifies a contact', async () => {
    const list = (await call({ type: 'contacts' })).contacts!;
    const fp = list[0]!.fingerprint;
    expect((await call({ type: 'renameContact', fingerprint: fp, label: 'Bobby' })).contact?.label).toBe('Bobby');
    expect((await call({ type: 'verifyContact', fingerprint: fp })).contact?.verified).toBe(true);
  });

  // Decode our own identity bundle so tests can act as a peer handshaking toward us.
  async function myBundle(): Promise<Uint8Array> {
    const raw = classify((await call({ type: 'invite' })).invite!)!.raw;
    return b64uDecode(raw.slice(raw.indexOf(':') + 1));
  }

  it('auto-labels a contact created from an explicit manual handshake paste', async () => {
    const cameron = generateIdentity();
    const hs = startHandshake(cameron, await myBundle());
    const t = 'popup:manual';
    const res = await call({ type: 'ingest', threadId: t, kind: 'handshake', raw: formatHandshake(hs.wire), peerLabel: 'Cameron', manual: true });
    expect(res.added?.label).toBe('Cameron');
    const token = formatMessage(sealMessage(hs.session, 'manual works'));
    expect((await call({ type: 'ingest', threadId: t, kind: 'message', raw: classify(token)!.raw, manual: true })).plaintext).toBe('manual works');
    const next = formatMessage(sealMessage(hs.session, 'manual works again'));
    expect((await call({ type: 'ingest', threadId: t, kind: 'message', raw: classify(next)!.raw, manual: true })).plaintext).toBe('manual works again');
  });

  it('manual paste can establish another peer without changing its manual-send binding', async () => {
    const outbound = generateIdentity();
    const outboundContact = await call({ type: 'addContact', invite: formatInvite(outbound.bundle), label: 'Manual outbound' });
    const t = 'popup:manual:telegram';
    await call({ type: 'bindThread', threadId: t, fingerprint: outboundContact.contact!.fingerprint });

    const incoming = generateIdentity();
    const hs = startHandshake(incoming, await myBundle());
    const established = await call({ type: 'ingest', threadId: t, kind: 'handshake', raw: formatHandshake(hs.wire), manual: true });
    expect(established.keyChanged).toBeUndefined();
    expect(established.ok).toBe(true);
    const message = formatMessage(sealMessage(hs.session, 'manual second peer'));
    expect((await call({ type: 'ingest', threadId: t, kind: 'message', raw: classify(message)!.raw, manual: true })).plaintext).toBe(
      'manual second peer',
    );
    expect((await call({ type: 'threadContact', threadId: t })).contact?.fingerprint).toBe(outboundContact.contact!.fingerprint);
  });

  it('an explicit unlink is sticky: recognition may not rebind it, a click may', async () => {
    const peer = generateIdentity();
    const c = await call({ type: 'addContact', invite: formatInvite(peer.bundle), label: 'Sticky' });
    const t = thread('tSticky');
    await call({ type: 'bindThread', threadId: t, fingerprint: c.contact!.fingerprint });
    await call({ type: 'unbindThread', threadId: t });
    expect((await call({ type: 'threadContact', threadId: t })).contact).toBeNull();

    // Recognition (auto) respects the opt-out tombstone…
    const auto = await call({ type: 'bindThread', threadId: t, fingerprint: c.contact!.fingerprint, auto: true });
    expect(auto.error).toBe('opted-out');
    expect((await call({ type: 'threadContact', threadId: t })).contact).toBeNull();

    // …the user's own click overrides it…
    expect((await call({ type: 'bindThread', threadId: t, fingerprint: c.contact!.fingerprint })).ok).toBe(true);

    // …and once bound, recognition never swaps the person out from under the user.
    const other = await call({ type: 'addContact', invite: formatInvite(generateIdentity().bundle), label: 'Other' });
    expect((await call({ type: 'bindThread', threadId: t, fingerprint: other.contact!.fingerprint, auto: true })).ok).toBe(true);
    expect((await call({ type: 'threadContact', threadId: t })).contact?.fingerprint).toBe(c.contact!.fingerprint);
  });

  it('manual encryption atomically chooses the selected contact', async () => {
    const stale = generateIdentity();
    const staleContact = await call({ type: 'addContact', invite: formatInvite(stale.bundle), label: 'Stale manual contact' });
    const target = generateIdentity();
    const targetContact = await call({ type: 'addContact', invite: formatInvite(target.bundle), label: 'Selected manual contact' });
    const t = 'popup:manual:whatsapp';
    await call({ type: 'bindThread', threadId: t, fingerprint: staleContact.contact!.fingerprint });

    const encrypted = await call({ type: 'manualEncrypt', threadId: t, fingerprint: targetContact.contact!.fingerprint, plaintext: 'for selected contact' });
    expect((await call({ type: 'threadContact', threadId: t })).contact?.fingerprint).toBe(targetContact.contact!.fingerprint);
    const handshake = classify(encrypted.tokens!.find((token) => token.startsWith('EKK1H:'))!)!;
    const peer = acceptHandshake(target, decodeBody(handshake.raw));
    const message = classify(encrypted.tokens!.find((token) => token.startsWith('EKK1M:'))!)!;
    expect(openMessage(peer.session, decodeBody(message.raw))).toBe('for selected contact');
    expect(
      (await callFromTab({ type: 'manualEncrypt', threadId: t, fingerprint: targetContact.contact!.fingerprint, plaintext: 'blocked' })).error,
    ).toBe('manual-only');
  });

  it('REGRESSION: ignores your own echoed handshake instead of adding yourself', async () => {
    const bob = generateIdentity();
    const peer = await call({ type: 'addContact', invite: formatInvite(bob.bundle), label: 'BobPeer' });
    await call({ type: 'bindThread', threadId: thread('tSelf'), fingerprint: peer.contact!.fingerprint });
    const before = (await call({ type: 'contacts' })).contacts!.length;

    // Encrypting to Bob emits our own handshake; that same bubble echoes back to us.
    const enc = await call({ type: 'encrypt', threadId: thread('tSelf'), plaintext: 'hi' });
    const myHandshake = enc.tokens!.find((t) => t.startsWith('EKK1H:'))!;
    const boundBefore = (await call({ type: 'threadContact', threadId: thread('tSelf') })).contact?.fingerprint;

    const c = classify(myHandshake)!;
    const res = await call({ type: 'ingest', threadId: thread('tSelf'), kind: 'handshake', raw: c.raw });
    expect(res.ok).toBe(true);
    expect(res.added).toBeUndefined(); // did NOT add self
    expect((await call({ type: 'contacts' })).contacts!.length).toBe(before); // count unchanged
    expect((await call({ type: 'threadContact', threadId: thread('tSelf') })).contact?.fingerprint).toBe(boundBefore);
  });

  it('replays initial setup until an authenticated peer reply confirms receipt', async () => {
    const peer = generateIdentity();
    const added = await call({ type: 'addContact', invite: formatInvite(peer.bundle), label: 'Retry peer' });
    const t = thread('retry-handshake');
    await call({ type: 'bindThread', threadId: t, fingerprint: added.contact!.fingerprint });

    const first = await call({ type: 'encrypt', threadId: t, plaintext: 'first try' });
    const handshake = first.tokens!.find((token) => token.startsWith('EKK1H:'))!;
    const retry = await call({ type: 'encrypt', threadId: t, plaintext: 'retry' });
    expect(retry.tokens).toContain(handshake);

    const peerSession = acceptHandshake(peer, decodeBody(classify(handshake)!.raw)).session;
    const reply = formatMessage(sealMessage(peerSession, 'received'));
    expect((await call({ type: 'ingest', threadId: t, kind: 'message', raw: classify(reply)!.raw })).plaintext).toBe('received');

    const settled = await call({ type: 'encrypt', threadId: t, plaintext: 'after reply' });
    expect(settled.tokens!.some((token) => token.startsWith('EKK1H:'))).toBe(false);
  });

  it('names a dead channel honestly: unknown session beside a live one is old-session, not waiting', async () => {
    const peer = generateIdentity();
    const added = await call({ type: 'addContact', invite: formatInvite(peer.bundle), label: 'Rotato' });
    const t = thread('tOldSession');
    await call({ type: 'bindThread', threadId: t, fingerprint: added.contact!.fingerprint });

    // A live channel with this peer exists…
    const hs = startHandshake(peer, await myBundle());
    await call({ type: 'ingest', threadId: t, kind: 'handshake', raw: formatHandshake(hs.wire) });

    // …but this message was sealed under a session this vault never held (pre-restore /
    // pre-rotation history). Beside a live channel for the same peer, that is dead — say so.
    const lost = startHandshake(peer, await myBundle()).session;
    const token = formatMessage(sealMessage(lost, 'ghost'));
    expect((await call({ type: 'ingest', threadId: t, kind: 'message', raw: classify(token)!.raw })).error).toBe('old-session');

    // The same unknown session with NO channel for the peer stays plain no-session (still waiting).
    const stranger = generateIdentity();
    const addedS = await call({ type: 'addContact', invite: formatInvite(stranger.bundle), label: 'No channel yet' });
    const t2 = thread('tNoChannel');
    await call({ type: 'bindThread', threadId: t2, fingerprint: addedS.contact!.fingerprint });
    const early = formatMessage(sealMessage(startHandshake(stranger, await myBundle()).session, 'early'));
    expect((await call({ type: 'ingest', threadId: t2, kind: 'message', raw: classify(early)!.raw })).error).toBe('no-session');
  });

  it('refuses to overwrite an existing vault', async () => {
    expect((await call({ type: 'create', passphrase: 'different' })).error).toBe('vault-exists');
  });

  it('SECURITY: an inbound handshake never silently rebinds a verified thread (key substitution)', async () => {
    // Bind thread tKC to a verified contact Xavier.
    const xavier = generateIdentity();
    const addX = await call({ type: 'addContact', invite: formatInvite(xavier.bundle), label: 'Xavier' });
    const fpX = addX.contact!.fingerprint;
    await call({ type: 'bindThread', threadId: thread('tKC'), fingerprint: fpX });
    await call({ type: 'verifyContact', fingerprint: fpX });

    // An attacker forges a handshake into that thread, spoofing Xavier's display name.
    const attacker = generateIdentity();
    const hs = startHandshake(attacker, await myBundle());

    const res = await call({ type: 'ingest', threadId: thread('tKC'), kind: 'handshake', raw: formatHandshake(hs.wire), peerLabel: 'Xavier' });
    expect(res.keyChanged).toBe(true); // signalled, not silently accepted
    expect(res.added).toBeUndefined();
    expect(res.contact!.label).not.toBe('Xavier'); // no masquerade under the real peer's name

    // Binding stays on the verified contact; sending still targets Xavier, not the attacker.
    expect((await call({ type: 'threadContact', threadId: thread('tKC') })).contact?.fingerprint).toBe(fpX);
  });

  it('SECURITY: a message decryptable under one session can’t be replayed into another thread', async () => {
    // A real peer establishes a session with us in their own thread.
    const peer = generateIdentity();
    const hs = startHandshake(peer, await myBundle());
    const contact = await call({ type: 'addContact', invite: formatInvite(peer.bundle), label: 'Peer' });
    await call({ type: 'bindThread', threadId: thread('tPeer'), fingerprint: contact.contact!.fingerprint });
    await call({ type: 'ingest', threadId: thread('tPeer'), kind: 'handshake', raw: formatHandshake(hs.wire) });
    const token = formatMessage(sealMessage(hs.session, 'sneaky'));
    const raw = classify(token)!.raw;

    // In its own (correctly-bound) thread it decrypts…
    expect((await call({ type: 'ingest', threadId: thread('tPeer'), kind: 'message', raw })).plaintext).toBe('sneaky');
    // …and a second direct thread explicitly linked to the SAME contact still cannot
    // reuse the first thread's session.
    await call({ type: 'bindThread', threadId: thread('tPeerCopy'), fingerprint: contact.contact!.fingerprint });
    expect((await call({ type: 'ingest', threadId: thread('tPeerCopy'), kind: 'message', raw })).error).toBe('wrong-thread');
    // The user-invoked popup fallback may still read the copied handshake/message without
    // moving the stored session out of its real chat.
    expect((await call({ type: 'ingest', threadId: 'popup:manual', kind: 'handshake', raw: formatHandshake(hs.wire), manual: true })).ok).toBe(true);
    expect((await call({ type: 'ingest', threadId: 'popup:manual', kind: 'message', raw, manual: true })).plaintext).toBe('sneaky');
    // …but pasted into another bound thread it's rejected, not shown.
    const res = await call({ type: 'ingest', threadId: thread('tKC'), kind: 'message', raw });
    expect(res.error).toBe('wrong-thread');
    expect(res.plaintext).toBeUndefined();
  });

  it('allows an explicit manual paste despite a different manual-send binding', async () => {
    const peer = generateIdentity();
    const peerContact = await call({ type: 'addContact', invite: formatInvite(peer.bundle), label: 'Manual source' });
    const source = thread('tManualSource');
    await call({ type: 'bindThread', threadId: source, fingerprint: peerContact.contact!.fingerprint });
    const hs = startHandshake(peer, await myBundle());
    await call({ type: 'ingest', threadId: source, kind: 'handshake', raw: formatHandshake(hs.wire) });
    const raw = classify(formatMessage(sealMessage(hs.session, 'manual cross-contact read')))!.raw;

    const other = generateIdentity();
    const otherContact = await call({ type: 'addContact', invite: formatInvite(other.bundle), label: 'Manual destination' });
    const popupThread = 'popup:manual:telegram';
    await call({ type: 'bindThread', threadId: popupThread, fingerprint: otherContact.contact!.fingerprint });

    expect((await call({ type: 'ingest', threadId: popupThread, kind: 'message', raw, manual: true })).plaintext).toBe(
      'manual cross-contact read',
    );
  });

  it('exports a backup that only the right passphrase can import', async () => {
    const blob = (await call({ type: 'export' })).invite!;
    expect((await call({ type: 'import', blob, passphrase: 'wrong' })).error).toBe('wrong-passphrase');
    expect((await call({ type: 'import', blob, passphrase: PASS })).ok).toBe(true);
  });

  it('SECURITY: while locked, threadContact still knows which chats encrypt (fail-safe cache)', async () => {
    await call({ type: 'lock' });
    // tSelf was bound while unlocked; the plain cache must answer for it when locked so
    // the content script BLOCKS sends there instead of silently going plaintext.
    const linked = await call({ type: 'threadContact', threadId: thread('tSelf') });
    expect(linked.error).toBe('locked');
    expect(linked.wasLinked).toBe(true);
    const never = await call({ type: 'threadContact', threadId: thread('never-linked') });
    expect(never.error).toBe('locked');
    expect(never.wasLinked).toBe(false);
    expect((await call({ type: 'unlock', passphrase: PASS })).ok).toBe(true);
  });

  it('SECURITY: a locked vault with no fail-safe cache fails closed, not open', async () => {
    await call({ type: 'lock' });
    // A vault that predates the fail-safe feature has no rsn.linked until its first
    // unlock. Until then every chat must read as previously-linked (sends blocked) —
    // the alternative is a silent plaintext send in a chat the user believes encrypts.
    await (globalThis as unknown as { chrome: { storage: { local: { remove(k: string): Promise<void> } } } }).chrome.storage.local.remove(
      'rsn.linked',
    );
    const res = await call({ type: 'threadContact', threadId: thread('was-linked-before-upgrade') });
    expect(res.error).toBe('locked');
    expect(res.wasLinked).toBe(true);
    expect((await call({ type: 'unlock', passphrase: PASS })).ok).toBe(true);
  });

  it('SECURITY: inbound protocol data never auto-binds an unlinked chat', async () => {
    const mallory = generateIdentity();
    const hs = startHandshake(mallory, await myBundle());
    const t = thread('tMute');
    const contactsBefore = (await call({ type: 'contacts' })).contacts!.length;
    const invite = await call({ type: 'ingest', threadId: t, kind: 'invite', raw: classify(formatInvite(mallory.bundle))!.raw, peerLabel: 'Mallory' });
    expect(invite.error).toBe('no-contact');
    expect((await call({ type: 'contacts' })).contacts).toHaveLength(contactsBefore);
    const handshake = await call({ type: 'ingest', threadId: t, kind: 'handshake', raw: formatHandshake(hs.wire), peerLabel: 'Mallory' });
    expect(handshake.error).toBe('no-contact');
    expect((await call({ type: 'threadContact', threadId: t })).contact).toBeNull();

    const contact = await call({ type: 'addContact', invite: formatInvite(mallory.bundle), label: 'Mallory' });
    await call({ type: 'bindThread', threadId: t, fingerprint: contact.contact!.fingerprint });
    expect((await call({ type: 'ingest', threadId: t, kind: 'handshake', raw: formatHandshake(hs.wire) })).ok).toBe(true);
    const token = formatMessage(sealMessage(hs.session, 'still readable'));
    expect((await call({ type: 'ingest', threadId: t, kind: 'message', raw: classify(token)!.raw })).plaintext).toBe('still readable');

    await call({ type: 'unbindThread', threadId: t });
    const replay = await call({ type: 'ingest', threadId: t, kind: 'message', raw: classify(token)!.raw });
    expect(replay.error).toBe('no-contact');
    expect((await call({ type: 'threadContact', threadId: t })).contact).toBeNull();
  });

  it('accepts manual decrypt only from an extension page', async () => {
    const res = await callFromTab({
      type: 'ingest',
      threadId: thread('tManual'),
      kind: 'message',
      raw: 'RSN1M:abc',
      manual: true,
    });
    expect(res.error).toBe('manual-only');
  });

  it('migrates a legacy session to its direct chat instead of a popup helper binding', async () => {
    const peer = generateIdentity();
    const contact = await call({ type: 'addContact', invite: formatInvite(peer.bundle), label: 'Legacy peer' });
    const rawBlob = JSON.parse((await call({ type: 'export' })).invite!);
    const salt = b64uDecode(rawBlob.salt);
    const vault = decryptVault(rawBlob, await deriveMaster(PASS, salt));
    const legacySession = startHandshake(vault.identity, peer.bundle).session;
    vault.sessions = [legacySession];
    vault.threadBindings['legacy-thread'] = contact.contact!.fingerprint;
    vault.threadBindings[`popup:${contact.contact!.fingerprint}`] = contact.contact!.fingerprint;
    const blob = JSON.stringify(encryptVault(vault, await deriveMaster(PASS, salt), salt));

    expect((await call({ type: 'import', blob, passphrase: PASS })).ok).toBe(true);
    expect((await call({ type: 'threadContact', threadId: thread('legacy-thread') })).contact?.label).toBe('Legacy peer');
    const raw = classify(formatMessage(sealMessage(legacySession, 'legacy history')))!.raw;
    expect((await call({ type: 'ingest', threadId: thread('legacy-thread'), kind: 'message', raw })).plaintext).toBe('legacy history');
    await call({ type: 'bindThread', threadId: thread('legacy-copy'), fingerprint: contact.contact!.fingerprint });
    expect((await call({ type: 'ingest', threadId: thread('legacy-copy'), kind: 'message', raw })).error).toBe('wrong-thread');
  });

  it('accepts a first-contact handshake from the glyph: adds, binds, and decrypts its messages', async () => {
    const maya = generateIdentity();
    const hs = startHandshake(maya, await myBundle());
    const t = thread('maya-first-contact');
    // Tab-only, exactly like accepting an invite.
    expect((await call({ type: 'acceptInvite', threadId: t, invite: formatHandshake(hs.wire), label: 'Maya' })).error).toBe('invite-only');
    const res = await callFromTab({ type: 'acceptInvite', threadId: t, invite: formatHandshake(hs.wire), label: 'Maya' });
    expect(res.contact?.label).toBe('Maya');
    expect((await call({ type: 'threadContact', threadId: t })).contact?.fingerprint).toBe(res.contact!.fingerprint);
    // The session stored by the accept reads her message immediately — no extra round trip.
    const token = formatMessage(sealMessage(hs.session, 'first contact'));
    expect((await call({ type: 'ingest', threadId: t, kind: 'message', raw: classify(token)!.raw })).plaintext).toBe('first contact');
  });

  it('SECURITY: accepting a handshake replayed from another chat refuses to bind', async () => {
    const peer = generateIdentity();
    const hs = startHandshake(peer, await myBundle());
    const home = thread('replay-home');
    expect((await callFromTab({ type: 'acceptInvite', threadId: home, invite: formatHandshake(hs.wire), label: 'P' })).ok).toBe(true);
    const other = thread('replay-other');
    expect((await callFromTab({ type: 'acceptInvite', threadId: other, invite: formatHandshake(hs.wire), label: 'P' })).error).toBe('bad-invite');
    expect((await call({ type: 'threadContact', threadId: other })).contact).toBeNull();
  });

  it('REGRESSION: an own echoed handshake in an UNLINKED chat reads as ours, never a chat request', async () => {
    const peer = generateIdentity();
    const added = await call({ type: 'addContact', invite: formatInvite(peer.bundle), label: 'Echo peer' });
    const t = thread('echo-unlinked');
    await call({ type: 'bindThread', threadId: t, fingerprint: added.contact!.fingerprint });
    const enc = await call({ type: 'encrypt', threadId: t, plaintext: 'hi' });
    const myHs = enc.tokens!.find((x) => x.startsWith('EKK1H:'))!;
    await call({ type: 'unbindThread', threadId: t });

    // Not 'no-contact': the controller must never surface our own echo as an offer.
    const res = await call({ type: 'ingest', threadId: t, kind: 'handshake', raw: classify(myHs)!.raw });
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    // And explicitly accepting it is refused.
    expect((await callFromTab({ type: 'acceptInvite', threadId: t, invite: myHs })).error).toBe('thats-you');
    expect((await call({ type: 'threadContact', threadId: t })).contact).toBeNull();
  });

  it('auto-discovery: resolvePeer is gated by the setting, canonicalizes, and never persists', async () => {
    const peer = generateIdentity();
    const server = generateIdentity();
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      seen.push(u);
      if (u.endsWith('/auth/challenge'))
        return new Response(JSON.stringify({ challengeId: 'discover-c1', challenge: b64uEncode(server.xPub) }), {
          status: 200,
        });
      if (u.endsWith('/recover')) return new Response(JSON.stringify({ error: 'no-account' }), { status: 404 });
      if (u.endsWith('/u/claim')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ invite: formatInvite(peer.bundle), verified: true }), { status: 200 });
    }) as typeof fetch;
    try {
      // OFF by default, and anonymous mode cannot be opted in accidentally.
      expect((await call({ type: 'getSettings' })).discover).toBe(false);
      expect((await call({ type: 'setDiscover', enabled: true })).error).toBe('no-handle');
      expect((await call({ type: 'resolvePeer', platform: 'instagram', handle: 'maya' })).error).toBe('discovery-off');
      expect(seen).toHaveLength(0);

      // Claiming an Ekko handle makes explicit opt-in available.
      expect((await call({ type: 'dirClaim', username: 'kirill' })).ok).toBe(true);
      seen.length = 0;
      expect((await call({ type: 'setDiscover', enabled: true })).ok).toBe(true);
      const before = (await call({ type: 'contacts' })).contacts!.length;
      const res = await call({ type: 'resolvePeer', platform: 'Instagram', handle: '@Maya' });
      expect(res.invite).toBe(formatInvite(peer.bundle));
      const hash = bytesToHex(sha256(new TextEncoder().encode('instagram:maya')));
      expect(seen).toEqual([`https://useekko.app/lookup?platform=instagram&handle_hash=${hash}`]);
      expect((await call({ type: 'contacts' })).contacts!.length).toBe(before);

      // Unverified first-claim mappings never become identity offers.
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ invite: formatInvite(peer.bundle), verified: false }), { status: 200 })) as typeof fetch;
      expect((await call({ type: 'resolvePeer', platform: 'instagram', handle: 'unverified' })).error).toBe(
        'unverified-handle',
      );

      // A lookup that resolves to OUR OWN key is reported, not offered.
      const mine = (await call({ type: 'invite' })).invite!;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ invite: mine, verified: true }), { status: 200 })) as typeof fetch;
      expect((await call({ type: 'resolvePeer', platform: 'instagram', handle: 'me' })).error).toBe('thats-you');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('setContactHandles edits a contact’s apps: canonicalized in, empty means remove, all-empty clears', async () => {
    const carol = generateIdentity();
    const fp = (await call({ type: 'addContact', invite: formatInvite(carol.bundle), label: 'Carol' })).contact!.fingerprint;

    const set = await call({
      type: 'setContactHandles',
      fingerprint: fp,
      handles: { instagram: '@Carol.G', whatsapp: '+1 (222) 333-4444', telegram: '   ' },
    });
    expect(set.ok).toBe(true);
    // Same canonical form as discovery — or recognition would never match what sync and
    // the adapters produce. Blank telegram never landed.
    expect(set.contact!.handles).toEqual({ instagram: 'carol.g', whatsapp: '12223334444' });
    const listed = (await call({ type: 'contacts' })).contacts!.find((c) => c.fingerprint === fp)!;
    expect(listed.handles).toEqual({ instagram: 'carol.g', whatsapp: '12223334444' });

    // Junk is refused, unknown contacts are named as such.
    expect((await call({ type: 'setContactHandles', fingerprint: fp, handles: { 'Not A Platform!': 'x' } })).error).toBe('bad-platform');
    expect((await call({ type: 'setContactHandles', fingerprint: 'f'.repeat(64), handles: {} })).error).toBe('unknown-contact');

    // Clearing every field clears the map entirely (chips disappear, no empty object lingers).
    const cleared = await call({ type: 'setContactHandles', fingerprint: fp, handles: {} });
    expect(cleared.ok).toBe(true);
    expect(cleared.contact!.handles).toBeUndefined();
  });

  // Google sign-in in the extension is a TAB, not launchWebAuthFlow — Safari has no
  // browser.identity, so the canonical Chrome road does not exist. The session therefore comes back
  // from a WEB PAGE, carrying a bearer token, which makes these two gates the whole security story.
  describe('Google sign-in arrives from a page, so it is gated twice', () => {
    // A syntactically real JWT: the background reads `email` out of it to report who signed in.
    const jwt = (email: string) => {
      const b64 = (o: unknown) => b64uEncode(new TextEncoder().encode(JSON.stringify(o)));
      return `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', email })}.sig`;
    };
    const session = { accessToken: jwt('kirill@example.com'), refreshToken: 'r1', expiresAt: Date.now() + 3.6e6 };

    it('refuses a session it never asked for, so visiting the page cannot sign you in', async () => {
      await call({ type: 'acctSignOut' });
      // No acctGoogle first. A page pushing a session at us out of the blue is exactly what the
      // await flag exists to refuse — otherwise merely opening account.useekko.app would sign the
      // extension in, possibly as somebody else.
      const unasked = await callFromPage(
        { type: 'acctAdoptSession', session }, 'https://account.useekko.app');
      expect(unasked.error).toBe('not-expected');
      expect((await call({ type: 'acctStatus' })).signedIn).toBeFalsy();
    });

    it('refuses any other origin, and a rejected attempt does not burn the pending sign-in', async () => {
      expect((await call({ type: 'acctGoogle' })).ok).toBe(true);

      const evil = await callFromPage({ type: 'acctAdoptSession', session }, 'https://evil.example');
      expect(evil.error).toBe('bad-origin');
      expect((await call({ type: 'acctStatus' })).signedIn).toBeFalsy();

      // The origin gate deliberately returns BEFORE consuming the flag. If it did not, any page you
      // happened to have open could spend your pending sign-in and leave you staring at a Google
      // flow that silently no longer lands — a denial of service with no error to show for it.
      const real = await callFromPage(
        { type: 'acctAdoptSession', session }, 'https://account.useekko.app');
      expect(real.signedIn).toBe(true);
      await call({ type: 'acctSignOut' });
    });

    it('opens the Google flow and adopts exactly one session from the account page', async () => {
      tabsOpened.length = 0;
      expect((await call({ type: 'acctGoogle' })).ok).toBe(true);

      // It is a plain tab at the same authorize URL the account page's own button uses, landing on
      // a redirect target Supabase already allows. No identity permission, and nothing Safari lacks.
      expect(tabsOpened).toHaveLength(1);
      expect(tabsOpened[0]).toContain('/auth/v1/authorize?provider=google');
      expect(tabsOpened[0]).toContain(encodeURIComponent('https://account.useekko.app/'));

      const ok = await callFromPage(
        { type: 'acctAdoptSession', session }, 'https://account.useekko.app');
      expect(ok.signedIn).toBe(true);
      expect(ok.email).toBe('kirill@example.com');

      // One-shot: the flag is consumed on a successful handoff, so the page cannot keep pushing
      // sessions at us for the rest of its life.
      const again = await callFromPage(
        { type: 'acctAdoptSession', session: { ...session, refreshToken: 'r2' } },
        'https://account.useekko.app');
      expect(again.error).toBe('not-expected');

      await call({ type: 'acctSignOut' });
    });
  });

  it('REGRESSION: phrase restore hydrates the owned handle and can re-enable discovery', async () => {
    const phrase = generateMnemonic();
    const server = generateIdentity();
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/auth/challenge'))
        return new Response(JSON.stringify({ challengeId: 'restore-c1', challenge: b64uEncode(server.xPub) }), {
          status: 200,
        });
      if (u.endsWith('/recover')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(typeof body.proof).toBe('string');
        expect(body.newBundle).toBeUndefined();
        return new Response(JSON.stringify({ ok: true, username: 'kirill' }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    try {
      // A fresh browser profile gets fresh extension storage and a fresh service worker.
      vi.resetModules();
      listener = null;
      (globalThis as unknown as { chrome: unknown }).chrome = {
        storage: { local: area(), session: area() },
        runtime: {
          onMessage: { addListener: (fn: typeof listener) => (listener = fn) },
          getManifest: () => ({ version: '0.5.0' }),
        },
      };
      await import('../src/background.js');

      const restored = await call({ type: 'importIdentity', passphrase: PASS, mnemonic: phrase });
      expect(restored.ok).toBe(true);
      // Restore adopts the handle the phrase owns immediately — the popup must show @kirill,
      // not an empty claim prompt right after onboarding said "You are @kirill".
      expect((await call({ type: 'invite' })).username).toBe('kirill');
      // Even if the user types a different candidate, the already-adopted handle wins over
      // creating a duplicate account.
      const recovered = await call({ type: 'dirClaim', username: 'another' });
      expect(recovered.username).toBe('kirill');
      expect((await call({ type: 'invite' })).username).toBe('kirill');
      expect((await call({ type: 'setDiscover', enabled: true })).ok).toBe(true);
      expect(calls).toEqual(['https://useekko.app/auth/challenge', 'https://useekko.app/recover']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

});

// The in-page manual seal ("Seal for a contact") and the glyph power button's session
// pause. sealFor is the ONE encrypt request a tab may aim at an explicit recipient; these
// pin its gates — allowed from a tab, no thread side effects — and the pause plumbing.
describe('sealFor and the session pause', () => {
  it('seals for an explicit contact FROM A TAB, and the peer opens it from the two blocks alone', async () => {
    await call({ type: 'unlock', passphrase: PASS });
    const peer = generateIdentity();
    const added = await call({ type: 'addContact', invite: formatInvite(peer.bundle), label: 'Pat' });
    const fp = added.contact!.fingerprint;

    const first = await callFromTab({ type: 'sealFor', fingerprint: fp, plaintext: 'meet at 6' });
    expect(first.error).toBeUndefined();
    expect(first.tokens).toHaveLength(2);
    const hs = classify(first.tokens![0]!)!;
    const msg = classify(first.tokens![1]!)!;
    expect(hs.kind).toBe('handshake');
    expect(msg.kind).toBe('message');
    // The manual contract: the recipient needs nothing but the pasted blocks.
    const accepted = acceptHandshake(peer, decodeBody(hs.raw));
    expect(openMessage(accepted.session, decodeBody(msg.raw))).toBe('meet at 6');

    // Sealing again for the same person reuses the session: the handshake replays
    // byte-identically until authenticated peer traffic arrives, so the recipient's
    // session keeps opening later messages.
    const second = await callFromTab({ type: 'sealFor', fingerprint: fp, plaintext: 'bring the dog' });
    expect(second.tokens).toHaveLength(2);
    expect(second.tokens![0]).toBe(first.tokens![0]);
    expect(openMessage(accepted.session, decodeBody(classify(second.tokens![1]!)!.raw))).toBe('bring the dog');
  });

  it('never binds a thread, and the old gates hold: manualEncrypt from a tab, unknown recipients, locked vault', async () => {
    const peer = generateIdentity();
    const added = await call({ type: 'addContact', invite: formatInvite(peer.bundle), label: 'Rae' });
    const fp = added.contact!.fingerprint;

    const tid = thread('seal-no-side-effects');
    await callFromTab({ type: 'sealFor', fingerprint: fp, plaintext: 'x' });
    const bound = await call({ type: 'threadContact', threadId: tid });
    expect(bound.contact ?? null).toBeNull(); // sealing bound nothing anywhere

    expect(
      (await callFromTab({ type: 'manualEncrypt', threadId: manualThreadId('instagram'), fingerprint: fp, plaintext: 'x' })).error,
    ).toBe('manual-only'); // the popup-only gate did not loosen
    expect((await callFromTab({ type: 'sealFor', fingerprint: 'f'.repeat(64), plaintext: 'x' })).error).toBe('no-contact');

    await call({ type: 'lock' });
    expect((await callFromTab({ type: 'sealFor', fingerprint: fp, plaintext: 'x' })).error).toBe('locked');
    await call({ type: 'unlock', passphrase: PASS });
  });

  it('the sealed message lands readable: an unbound chat names the key owner, and the bind decrypts it', async () => {
    const peer = generateIdentity();
    const added = await call({ type: 'addContact', invite: formatInvite(peer.bundle), label: 'Бабуля' });
    const fp = added.contact!.fingerprint;
    const sealed = await callFromTab({ type: 'sealFor', fingerprint: fp, plaintext: 'позвони мне' });
    const msg = classify(sealed.tokens!.at(-1)!)!;

    // The manual-seal landing: the sealed bubble sits in a chat that isn't linked yet.
    // The vault knows whose key sealed it — the answer names them so the glyph can offer
    // the one-tap link instead of dead-ending on "set up Ekko with X to read".
    const tid = thread('babulya-chat');
    const blocked = await callFromTab({ type: 'ingest', threadId: tid, kind: 'message', raw: msg.raw });
    expect(blocked.error).toBe('no-contact');
    expect(blocked.contact?.label).toBe('Бабуля');

    // The offered tap binds — and the SAME bubble decrypts, because the seal session is
    // per-contact (threadless), not pinned to the manual context it was born in.
    await call({ type: 'bindThread', threadId: tid, fingerprint: fp });
    const read = await callFromTab({ type: 'ingest', threadId: tid, kind: 'message', raw: msg.raw });
    expect(read.error).toBeUndefined();
    expect(read.plaintext).toBe('позвони мне');
  });

  it('session pause: set from a tab, reported by getSettings, lifted by turning the platform on', async () => {
    expect((await call({ type: 'getSettings' })).sessionOff).toEqual([]);
    const off = await callFromTab({ type: 'setSiteSession', platform: 'instagram', enabled: false });
    expect(off.sessionOff).toEqual(['instagram']);
    expect((await call({ type: 'getSettings' })).sessionOff).toEqual(['instagram']);

    // The popup's Home toggle is the master switch: enabling the platform lifts the pause.
    await call({ type: 'setSite', platform: 'instagram', enabled: true });
    expect((await call({ type: 'getSettings' })).sessionOff).toEqual([]);

    // And the pause is reversible from the page too.
    await callFromTab({ type: 'setSiteSession', platform: 'telegram', enabled: false });
    await callFromTab({ type: 'setSiteSession', platform: 'telegram', enabled: true });
    expect((await call({ type: 'getSettings' })).sessionOff).toEqual([]);
  });
});

// A peer who re-onboards gets a new device key. Contacts are keyed by fingerprint, so account-sync
// would spawn a second contact for the same person (the "two @kirill" report). reconcileContactKeys
// folds the old-key look-alike into the current-key contact. This is destructive (it deletes a
// contact), so the matching has to be exact-or-well-guarded — that is what these cases pin.
describe('reconcileContactKeys — a re-keyed peer folds into one contact', () => {
  const fp = (n: number) => new Uint8Array([n]);
  const fpHex = (n: number) => bytesToHex(fp(n));
  type C = ReturnType<typeof mkContact>;
  const mkContact = (n: number, label: string, extra: Partial<{ handles: Record<string, string>; userId: string; verified: boolean }> = {}) => ({
    bundle: fp(n),
    fingerprint: fp(n),
    label,
    verified: extra.verified ?? false,
    addedAt: 0,
    handles: extra.handles,
    userId: extra.userId,
  });
  const mkVault = (contacts: C[], threadBindings: Record<string, string> = {}, sessions: { peerFingerprint: Uint8Array }[] = []) =>
    ({ contacts, threadBindings, sessions } as unknown as Parameters<typeof reconcileContactKeys>[0]);

  it('LEGACY (no userId): folds by the globally-unique @handle + a shared linked social', () => {
    // The exact reported state: an old-key @kirill {instagram: demo1} beside the current-key
    // @kirill {instagram: demo1, telegram: demotg}. A chat is bound to the old key.
    const orphan = mkContact(1, '@kirill', { handles: { instagram: 'demo1' } });
    const survivor = mkContact(2, '@kirill', { handles: { instagram: 'demo1', telegram: 'demotg' } });
    const v = mkVault([orphan, survivor], { 'telegram:5293': fpHex(1) }, [{ peerFingerprint: fp(1) }, { peerFingerprint: fp(2) }]);

    expect(reconcileContactKeys(v, survivor as never, 'kirill-uuid', 'kirill')).toBe(true);
    expect(v.contacts).toEqual([survivor]); // the orphan is gone
    expect(survivor.userId).toBe('kirill-uuid'); // and the account id is now stamped for next time
    expect(v.threadBindings['telegram:5293']).toBe(fpHex(2)); // the open chat follows the new key
    expect(v.sessions.map((s) => bytesToHex(s.peerFingerprint))).toEqual([fpHex(2)]); // dead key's session dropped
  });

  it('DURABLE (userId): folds regardless of handle/social, and carries a user-set name forward', () => {
    const orphan = mkContact(1, 'Maya at work', { userId: 'u1', verified: true }); // renamed + verified under old key
    const survivor = mkContact(2, '@maya', { userId: undefined });
    const v = mkVault([orphan, survivor]);

    expect(reconcileContactKeys(v, survivor as never, 'u1', 'maya')).toBe(true);
    expect(v.contacts).toEqual([survivor]);
    expect(survivor.label).toBe('Maya at work'); // the human name survives the key change
    expect(survivor.verified).toBe(false); // but verification does NOT — a new key is unverified
  });

  it('SAFETY: same @handle label but no shared social and no userId is NOT folded (handle reassignment)', () => {
    const stranger = mkContact(1, '@kirill', { handles: { instagram: 'someone_else' } });
    const survivor = mkContact(2, '@kirill', { handles: { instagram: 'demo1' } });
    const v = mkVault([stranger, survivor]);

    reconcileContactKeys(v, survivor as never, 'kirill-uuid', 'kirill');
    expect(v.contacts).toHaveLength(2); // the look-alike is left alone
  });

  it('SAFETY: never matches a user-renamed legacy contact by handle (only the system @handle label)', () => {
    const renamed = mkContact(1, 'Kirill (old phone)', { handles: { instagram: 'demo1' } }); // shares a social, but renamed
    const survivor = mkContact(2, '@kirill', { handles: { instagram: 'demo1' } });
    const v = mkVault([renamed, survivor]);

    reconcileContactKeys(v, survivor as never, 'kirill-uuid', 'kirill');
    expect(v.contacts).toHaveLength(2); // a curated name is never deleted on the fuzzy legacy path
  });

  it('no look-alike: just stamps the account id, deletes nothing', () => {
    const survivor = mkContact(2, '@solo');
    const v = mkVault([survivor]);
    expect(reconcileContactKeys(v, survivor as never, 'u9', 'solo')).toBe(true);
    expect(v.contacts).toHaveLength(1);
    expect(survivor.userId).toBe('u9');
  });
});
