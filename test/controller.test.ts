import { describe, it, expect, vi } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  generateIdentity,
  startHandshake,
  acceptHandshake,
  sealMessage,
  openMessage,
  readSessionId,
  fingerprint,
  type Identity,
  type Session,
} from '../src/core/crypto.js';
import { formatInvite, formatHandshake, formatMessage, decodeBody } from '../src/core/wire.js';
import { scopedThreadId } from '../src/core/thread.js';
import type { Req } from '../src/core/rpc.js';
import { Controller } from '../src/content/controller.js';
import type { SiteAdapter, Bridge, SendHook, BubbleStatus, ChatState, ChatActions } from '../src/content/adapter.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A fake "background" backed by the REAL crypto core — proves the Controller integrates
// with actual encryption, not a stub.
function makeParty(identity: Identity, knownPeers: Identity[] = []) {
  const sessions: Session[] = [];
  const contacts = knownPeers.map((p) => ({ bundle: p.bundle, fingerprint: p.fingerprint }));
  const bindings: Record<string, string> = {};
  // Mirror background.storeSession: keep MULTIPLE sessions per peer, dedupe by id.
  const store = (s: Session) => {
    const id = bytesToHex(s.id);
    if (!sessions.some((x) => bytesToHex(x.id) === id)) sessions.push(s);
  };
  const bridge: Bridge = async (req) => {
    if (req.type === 'encrypt') {
      const fp = bindings[req.threadId];
      const contact = contacts.find((c) => bytesToHex(c.fingerprint) === fp);
      if (!contact) return { error: 'no-contact' };
      const tokens: string[] = [];
      let s = sessions.findLast((x) => bytesToHex(x.peerFingerprint) === fp && x.threadId === req.threadId);
      if (!s) {
        const hs = startHandshake(identity, contact.bundle);
        s = hs.session;
        s.threadId = req.threadId;
        store(s);
        tokens.push(formatHandshake(hs.wire));
      }
      tokens.push(formatMessage(sealMessage(s, req.plaintext)));
      return { ok: true, tokens };
    }
    if (req.type === 'ingest') {
      const body = decodeBody(req.raw);
      if (req.kind === 'handshake') {
        if (!req.manual && !bindings[req.threadId]) return { error: 'no-contact' };
        const { session, peerBundle } = acceptHandshake(identity, body);
        if (bytesToHex(fingerprint(peerBundle)) === bytesToHex(identity.fingerprint)) return { ok: true };
        session.threadId = req.threadId;
        store(session);
        if (!contacts.some((c) => bytesToHex(c.fingerprint) === bytesToHex(fingerprint(peerBundle))))
          contacts.push({ bundle: peerBundle, fingerprint: fingerprint(peerBundle) });
        return { ok: true };
      }
      const sid = readSessionId(body);
      if (!req.manual && !bindings[req.threadId]) return { error: 'no-contact' };
      const s = sid && sessions.find((x) => bytesToHex(x.id) === bytesToHex(sid));
      if (!s) return { error: 'no-session' };
      if (s.threadId !== req.threadId) return { error: 'wrong-thread' };
      try {
        return { ok: true, plaintext: openMessage(s, body) };
      } catch {
        return { error: 'decrypt-failed' };
      }
    }
    if (req.type === 'threadContact') {
      const fp = bindings[req.threadId];
      return { contact: fp ? { fingerprint: fp, label: 'peer', verified: false, safetyNumber: '0', fingerprintHex: '0' } : null };
    }
    if (req.type === 'bindThread') {
      bindings[req.threadId] = req.fingerprint;
      return { ok: true };
    }
    if (req.type === 'unbindThread') {
      delete bindings[req.threadId];
      return { ok: true };
    }
    return {};
  };
  return bridge;
}

type FakeBubble = { dataset: Record<string, string>; _text: string; _rendered?: string; _status?: BubbleStatus };

class FakeAdapter implements SiteAdapter {
  platform = 'fake';
  platformLabel = 'Fake';
  wire: string[] = [];
  bubbles: FakeBubble[] = [];
  hook?: SendHook;
  toasts: string[] = [];
  states: ChatState[] = [];
  lastActions?: ChatActions;
  tid: string | null = 't1'; // mutable: tests simulate navigating away mid-send
  failSend = false;
  direct: boolean | null = true;
  peer: string | null = null;
  handle: string | null | undefined;
  phone: string | null = null;
  constructor(readonly maxMessageLen = 900) {}
  peerPhone() {
    return this.phone;
  }
  threadId() {
    return this.tid;
  }
  isDirectChat() {
    return this.direct;
  }
  peerName() {
    return this.peer;
  }
  peerHandle() {
    return this.handle === undefined ? this.peer : this.handle;
  }
  findBubbles() {
    return this.bubbles as unknown as HTMLElement[];
  }
  bubbleText(el: HTMLElement) {
    const b = el as unknown as FakeBubble;
    return b.dataset.rsnSrc ?? b._text;
  }
  replaceBubbleText(el: HTMLElement, text: string, status: BubbleStatus) {
    const b = el as unknown as FakeBubble;
    b._rendered = text;
    b._status = status;
  }
  async injectAndSend(text: string) {
    if (this.failSend) throw new Error('send-failed');
    this.wire.push(text);
  }
  onSend(hook: SendHook) {
    this.hook = hook;
  }
  notify(message: string) {
    this.toasts.push(message);
  }
  setChatState(state: ChatState, actions: ChatActions) {
    this.states.push(state);
    this.lastActions = actions;
  }
  add(text: string) {
    this.bubbles.push({ dataset: {}, _text: text });
  }
  rendered() {
    return this.bubbles.map((b) => b._rendered);
  }
}

const deliver = (from: FakeAdapter, to: FakeAdapter) => from.wire.forEach((t) => to.add(t));
const thread = (id = 't1') => scopedThreadId('fake', id);
const bind = (bridge: Bridge, fingerprint: string, id = 't1') => bridge({ type: 'bindThread', threadId: thread(id), fingerprint });

describe('controller end-to-end', () => {
  it('encrypts on send and decrypts in place on receive', async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const aAdapter = new FakeAdapter();
    const bAdapter = new FakeAdapter();
    const aBridge = makeParty(alice, [bob]);
    const bBridge = makeParty(bob, [alice]);
    await bind(aBridge, bytesToHex(bob.fingerprint));
    await bind(bBridge, bytesToHex(alice.fingerprint));
    const aCtrl = new Controller(aAdapter, aBridge);
    const bCtrl = new Controller(bAdapter, bBridge);

    await aCtrl.sendHook().handle('hello bob 🔐');
    // At the 900-char cap the handshake chunks (EKK1C) and the message rides whole (EKK1M).
    expect(aAdapter.wire.every((t) => /^EKK1[HMC]:/.test(t))).toBe(true);
    expect(aAdapter.wire.some((t) => t.startsWith('EKK1C:'))).toBe(true); // handshake was chunked

    deliver(aAdapter, bAdapter);
    await bCtrl.scan();
    expect(bAdapter.rendered()).toContain('hello bob 🔐');
  });

  it('a sent bubble renders straight to plaintext — no decrypt round-trip, and re-mounts stay stable', async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const aAdapter = new FakeAdapter(10000);
    let messageIngests = 0;
    const real = makeParty(alice, [bob]);
    const aBridge: Bridge = async (req: Req) => {
      if (req.type === 'ingest' && req.kind === 'message') messageIngests++;
      return real(req);
    };
    await bind(aBridge, bytesToHex(bob.fingerprint));
    const aCtrl = new Controller(aAdapter, aBridge);

    await aCtrl.sendHook().handle('mine');
    deliver(aAdapter, aAdapter); // the platform echoes the sent tokens back as bubbles
    await aCtrl.scan();
    const sent = aAdapter.bubbles.find((b) => b._text.startsWith('EKK1M:'))!;
    expect(sent._rendered).toBe('mine');
    expect(sent._status).toBe('decrypted');

    // React re-mounts the bubbles (send confirm / receipts): same text, fresh elements.
    aAdapter.bubbles = aAdapter.bubbles.map((b) => ({ dataset: {}, _text: b._text }));
    await aCtrl.scan();
    const remounted = aAdapter.bubbles.find((b) => b._text.startsWith('EKK1M:'))!;
    expect(remounted._rendered).toBe('mine'); // straight to plaintext, never back to a cover
    expect(remounted._status).toBe('decrypted');
    expect(messageIngests).toBe(0); // seeded at send — the sent message NEVER round-trips

    // Receiver: first decrypt goes through ingest once; a re-mount is served from cache.
    let bobIngests = 0;
    const bReal = makeParty(bob, [alice]);
    const bBridge: Bridge = async (req: Req) => {
      if (req.type === 'ingest' && req.kind === 'message') bobIngests++;
      return bReal(req);
    };
    await bind(bBridge, bytesToHex(alice.fingerprint));
    const bAdapter = new FakeAdapter();
    const bCtrl = new Controller(bAdapter, bBridge);
    aAdapter.wire.forEach((t) => bAdapter.add(t));
    await bCtrl.scan();
    expect(bAdapter.rendered()).toContain('mine');
    bAdapter.bubbles = bAdapter.bubbles.map((b) => ({ dataset: {}, _text: b._text }));
    await bCtrl.scan();
    expect(bAdapter.rendered()).toContain('mine');
    expect(bobIngests).toBe(1); // decrypted once; the re-mount hit the plaintext cache
  });

  it('requestCover renders pre-paint: cached plaintext lands final, unknown tokens get the cover, no RPC', async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const aAdapter = new FakeAdapter(10000);
    let rpcs = 0;
    const real = makeParty(alice, [bob]);
    const aBridge: Bridge = async (req: Req) => {
      if (req.type === 'ingest') rpcs++;
      return real(req);
    };
    await bind(aBridge, bytesToHex(bob.fingerprint));
    const aCtrl = new Controller(aAdapter, aBridge);

    await aCtrl.sendHook().handle('pre-paint');
    // The platform mounts the echoed bubbles; ONLY the cover pass runs (the 150ms scan
    // hasn't fired) — the sent message must render final with zero round-trips.
    deliver(aAdapter, aAdapter);
    const rpcsBefore = rpcs;
    aCtrl.requestCover();
    await new Promise((r) => setTimeout(r, 0)); // flush the microtask
    const sent = aAdapter.bubbles.find((b) => b._text.startsWith('EKK1M:'))!;
    expect(sent._rendered).toBe('pre-paint');
    expect(sent._status).toBe('decrypted');
    expect(rpcs).toBe(rpcsBefore); // render-only: ingest stays with the debounced scan

    // A token we cannot resolve yet is covered generically — never painted as raw base64 —
    // and the bubble stays unclaimed so the scan's ingest still owns it.
    const stranger = startHandshake(generateIdentity(), bob.bundle).session;
    aAdapter.add(formatMessage(sealMessage(stranger, 'not for us')));
    aCtrl.requestCover();
    await new Promise((r) => setTimeout(r, 0));
    const covered = aAdapter.bubbles.at(-1)!;
    expect(covered._rendered).toBe('Encrypted message');
    expect(covered._status).toBe('pending');
    expect(covered.dataset.rsn).toBeUndefined();
  });

  it('holds a message that arrives before its handshake, then decrypts on retry', async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const aAdapter = new FakeAdapter(10000); // large cap keeps the handshake in one token
    const bAdapter = new FakeAdapter();
    const aBridge = makeParty(alice, [bob]);
    const bBridge = makeParty(bob, [alice]);
    await bind(aBridge, bytesToHex(bob.fingerprint));
    await bind(bBridge, bytesToHex(alice.fingerprint));
    const aCtrl = new Controller(aAdapter, aBridge);
    const bCtrl = new Controller(bAdapter, bBridge);

    await aCtrl.sendHook().handle('out of order');
    const [handshake, message] = aAdapter.wire; // [EKK1H, EKK1M], handshake first

    bAdapter.add(message!); // message arrives first
    await bCtrl.scan();
    expect(bAdapter.rendered()).toContain('Encrypted — waiting for the secure channel');

    bAdapter.add(handshake!); // handshake catches up; ingest triggers a debounced retry
    await bCtrl.scan();
    await sleep(220); // let the debounced rescan fire
    expect(bAdapter.rendered()).toContain('out of order');
  });

  it('chunks an oversized message and reassembles it on the far side', async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const aAdapter = new FakeAdapter(120); // tiny cap forces chunking
    const bAdapter = new FakeAdapter();
    const aBridge = makeParty(alice, [bob]);
    const bBridge = makeParty(bob, [alice]);
    await bind(aBridge, bytesToHex(bob.fingerprint));
    await bind(bBridge, bytesToHex(alice.fingerprint));
    const aCtrl = new Controller(aAdapter, aBridge);
    const bCtrl = new Controller(bAdapter, bBridge);

    const long = 'z'.repeat(600);
    await aCtrl.sendHook().handle(long);
    expect(aAdapter.wire.some((t) => t.startsWith('EKK1C:'))).toBe(true);
    for (const t of aAdapter.wire) expect(t.length).toBeLessThanOrEqual(120);

    deliver(aAdapter, bAdapter);
    await bCtrl.scan();
    expect(bAdapter.rendered()).toContain(long);
  });

  it('REGRESSION: crossed first-contact handshakes still converge (no permanent deadlock)', async () => {
    // Both know each other and both message first before scanning the other's handshake.
    const alice = generateIdentity();
    const bob = generateIdentity();
    const aAdapter = new FakeAdapter(10000); // whole handshake tokens for a clean swap
    const bAdapter = new FakeAdapter(10000);
    const aBridge = makeParty(alice, [bob]);
    const bBridge = makeParty(bob, [alice]);
    await bind(aBridge, bytesToHex(bob.fingerprint));
    await bind(bBridge, bytesToHex(alice.fingerprint));
    const aCtrl = new Controller(aAdapter, aBridge);
    const bCtrl = new Controller(bAdapter, bBridge);

    await aCtrl.sendHook().handle('hi from alice'); // A creates session S_A, emits [H_A, M_A]
    await bCtrl.sendHook().handle('hi from bob'); //   B creates session S_B, emits [H_B, M_B]

    // Each delivers its handshake+message to the other; both ingest.
    deliver(aAdapter, bAdapter);
    deliver(bAdapter, aAdapter);
    await bCtrl.scan();
    await aCtrl.scan();
    await sleep(240); // debounced retries settle
    expect(bAdapter.rendered()).toContain('hi from alice');
    expect(aAdapter.rendered()).toContain('hi from bob');

    // The real test of convergence: a SECOND message each way must also decrypt.
    aAdapter.wire.length = 0;
    bAdapter.wire.length = 0;
    await aCtrl.sendHook().handle('second from alice');
    await bCtrl.sendHook().handle('second from bob');
    deliver(aAdapter, bAdapter);
    deliver(bAdapter, aAdapter);
    await bCtrl.scan();
    await aCtrl.scan();
    await sleep(240);
    expect(bAdapter.rendered()).toContain('second from alice');
    expect(aAdapter.rendered()).toContain('second from bob');
  });

  it('appends the tagline to a whole message but never to a chunk', async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const TAG = ' · 🔒 tag';

    // Short message → single EKK1M token → tagline appended.
    const a1 = new FakeAdapter();
    const b1 = makeParty(alice, [bob]);
    await bind(b1, bytesToHex(bob.fingerprint));
    const c1 = new Controller(a1, b1);
    c1.setTagline(TAG);
    await c1.sendHook().handle('short');
    const lastMsg = a1.wire.filter((t) => t.startsWith('EKK1M:')).at(-1)!;
    expect(lastMsg.endsWith(TAG)).toBe(true);

    // Long message → chunked (EKK1C) → tag must NOT ride on any chunk (would corrupt reassembly).
    const a2 = new FakeAdapter(120);
    const b2 = makeParty(alice, [bob]);
    await bind(b2, bytesToHex(bob.fingerprint));
    const c2 = new Controller(a2, b2);
    c2.setTagline(TAG);
    await c2.sendHook().handle('z'.repeat(600));
    expect(a2.wire.some((t) => t.startsWith('EKK1C:'))).toBe(true);
    expect(a2.wire.some((t) => t.includes(TAG))).toBe(false);
  });

  it('never sends plaintext when the backend errors', async () => {
    const alice = generateIdentity();
    const aAdapter = new FakeAdapter();
    const aCtrl = new Controller(aAdapter, makeParty(alice)); // no contacts -> encrypt errors
    await aCtrl.sendHook().handle('secret');
    expect(aAdapter.wire).toHaveLength(0); // suppressed, not leaked
  });

  it('only intercepts sends in a linked chat — plain DMs to non-Ekko people go through', async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const a = new FakeAdapter();
    const bridge = makeParty(alice, [bob]);
    const ctrl = new Controller(a, bridge);

    // Unlinked chat: shouldHandle is false → the native plain message sends normally.
    await ctrl.scan();
    expect(ctrl.sendHook().shouldHandle('hey there')).toBe(false);

    // Link it, tell the controller to refresh: now it intercepts to encrypt.
    await bind(bridge, bytesToHex(bob.fingerprint));
    ctrl.retryPending();
    await sleep(20);
    expect(ctrl.sendHook().shouldHandle('hey there')).toBe(true);
  });

  it('does not let token-looking plaintext bypass a protected chat', async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const a = new FakeAdapter();
    const bridge = makeParty(alice, [bob]);
    await bind(bridge, bytesToHex(bob.fingerprint));
    const ctrl = new Controller(a, bridge);
    await ctrl.scan();

    expect(ctrl.sendHook().shouldHandle('please inspect RSN1M:not-a-real-message')).toBe(true);
  });

  it('renders an untrusted invite as an offer card and links it only after the glyph action', async () => {
    const a = new FakeAdapter();
    a.peer = 'Taylor';
    let accepted: Extract<Req, { type: 'acceptInvite' }> | undefined;
    const ctrl = new Controller(a, async (req) => {
      if (req.type === 'threadContact') return { contact: null };
      if (req.type === 'ingest') return { error: 'no-contact' };
      if (req.type === 'acceptInvite') {
        accepted = req;
        return { ok: true, contact: { fingerprint: 'f', label: 'Taylor', verified: false, safetyNumber: '0', fingerprintHex: '0' } };
      }
      return {};
    });
    a.add('RSN1I:untrusted-invite');

    await ctrl.scan();
    // The token reads as an actionable card, never a dead blob — but nothing is stored or
    // bound until the explicit accept below.
    expect(a.rendered()[0]).toContain('Taylor sent their Ekko key');
    expect(a.bubbles[0]!.dataset.rsn).toBe('done');
    expect(a.states.at(-1)).toMatchObject({ kind: 'off', invite: 'ready', inviteKind: 'invite' });

    a.lastActions!.acceptInvite();
    await sleep(0);
    expect(accepted).toMatchObject({ threadId: thread(), invite: 'RSN1I:untrusted-invite', label: 'Taylor' });
    expect(a.states.at(-1)).toMatchObject({ kind: 'on', label: 'Taylor' });
  });

  it('refuses to choose between different in-chat invites', async () => {
    const a = new FakeAdapter();
    let accepted = false;
    const ctrl = new Controller(a, async (req) => {
      if (req.type === 'threadContact') return { contact: null };
      if (req.type === 'ingest') return { error: 'no-contact' };
      if (req.type === 'acceptInvite') accepted = true;
      return {};
    });
    a.add('RSN1I:first-invite');
    a.add('RSN1I:second-invite');

    await ctrl.scan();
    expect(a.states.at(-1)).toMatchObject({ kind: 'off', invite: 'ambiguous' });
    // The conflicting token stays raw so the user can still copy the one they trust.
    expect(a.rendered()[1]).toBeUndefined();
    a.lastActions!.acceptInvite();
    await sleep(0);
    expect(accepted).toBe(false);
  });

  it('offers "on Ekko" from a directory hit and adds+binds only on the explicit tap', async () => {
    const a = new FakeAdapter();
    a.peer = 'Maya Rivera';
    a.handle = 'maya_gram';
    const reqs: Req[] = [];
    const ctrl = new Controller(a, async (req) => {
      reqs.push(req);
      if (req.type === 'threadContact') return { contact: null };
      if (req.type === 'contacts') return { contacts: [] };
      if (req.type === 'resolvePeer') return { ok: true, invite: 'RSN1I:from-directory' };
      if (req.type === 'acceptInvite')
        return { ok: true, contact: { fingerprint: 'f', label: 'Maya Rivera', verified: false, safetyNumber: '0', fingerprintHex: '0' } };
      return {};
    });
    await ctrl.scan();
    await sleep(20); // let refreshSuggestion resolve the directory offer
    expect(reqs.some((r) => r.type === 'resolvePeer' && r.platform === 'fake' && r.handle === 'maya_gram')).toBe(true);
    expect(a.states.at(-1)).toMatchObject({ kind: 'off', suggestLabel: 'Maya Rivera', onEkko: true });
    // The resolve alone bound nothing and added nobody.
    expect(reqs.every((r) => r.type !== 'acceptInvite' && r.type !== 'bindThread')).toBe(true);

    a.lastActions!.enable();
    await sleep(0);
    const acc = reqs.find((r) => r.type === 'acceptInvite');
    expect(acc).toMatchObject({ threadId: thread(), invite: 'RSN1I:from-directory', label: 'Maya Rivera' });
    expect(a.states.at(-1)).toMatchObject({ kind: 'on', label: 'Maya Rivera' });
  });

  it('never substitutes a display name when the provider exposes no account handle', async () => {
    const a = new FakeAdapter();
    a.peer = 'Maya Rivera';
    a.handle = null;
    let resolved = false;
    const ctrl = new Controller(a, async (req) => {
      if (req.type === 'threadContact') return { contact: null };
      if (req.type === 'contacts') return { contacts: [] };
      if (req.type === 'resolvePeer') resolved = true;
      return {};
    });
    await ctrl.scan();
    await sleep(20);
    expect(resolved).toBe(false);
  });

  it('deduplicates concurrent lookups and retries transient directory failures', async () => {
    const a = new FakeAdapter();
    a.peer = 'Maya';
    a.handle = 'maya_real';
    let lookups = 0;
    const ctrl = new Controller(a, async (req) => {
      if (req.type === 'threadContact') return { contact: null };
      if (req.type === 'contacts') return { contacts: [] };
      if (req.type === 'resolvePeer') {
        lookups++;
        await sleep(10);
        return { error: 'directory-error' };
      }
      return {};
    });
    await ctrl.scan();
    await sleep(30);
    expect(lookups).toBe(1);
    await ctrl.scan();
    await sleep(20);
    expect(lookups).toBe(2);
  });

  it('never asks the directory when a local contact already matches the peer', async () => {
    const a = new FakeAdapter();
    a.peer = 'Bob';
    let resolved = false;
    const ctrl = new Controller(a, async (req) => {
      if (req.type === 'threadContact') return { contact: null };
      if (req.type === 'contacts')
        return { contacts: [{ fingerprint: 'f', label: 'bob', verified: false, safetyNumber: '0', fingerprintHex: '0' }] };
      if (req.type === 'resolvePeer') resolved = true;
      return {};
    });
    await ctrl.scan();
    await sleep(20);
    expect(resolved).toBe(false);
    expect(a.states.at(-1)).toMatchObject({ kind: 'off', suggestLabel: 'bob' });
    expect((a.states.at(-1) as { onEkko?: boolean }).onEkko).toBeUndefined();
  });

  it('binds the chat automatically when a contact’s account-linked handle matches', async () => {
    const a = new FakeAdapter();
    a.peer = 'Kirill Vasilev'; // display name matches NO contact label
    a.handle = 'demo1'; // …but the @handle is a linked social of an account connection
    const KIRILL = { fingerprint: 'f1', label: '@kirill', verified: false, safetyNumber: '0', fingerprintHex: '0', handles: { fake: 'demo1', whatsapp: '15550100001' } };
    let bound: string | null = null;
    let resolved = false;
    const ctrl = new Controller(a, async (req) => {
      if (req.type === 'threadContact') return { contact: bound === thread() ? KIRILL : null };
      if (req.type === 'contacts')
        return { contacts: [KIRILL, { fingerprint: 'f2', label: '@other', verified: false, safetyNumber: '0', fingerprintHex: '0' }] };
      if (req.type === 'bindThread') {
        expect(req.auto).toBe(true); // recognition, not a click — the broker gets to refuse
        expect(req.fingerprint).toBe('f1');
        bound = req.threadId;
        return { ok: true };
      }
      if (req.type === 'resolvePeer') resolved = true;
      return {};
    });
    await ctrl.scan();
    await sleep(20);
    // Local, exact, account-derived — no directory lookup, no click: the chat is just ON.
    expect(resolved).toBe(false);
    expect(bound).toBe(thread());
    expect(a.states.at(-1)).toMatchObject({ kind: 'on', label: '@kirill' });
  });

  it('binds automatically by linked PHONE when the platform exposes it and no username is linked', async () => {
    // The Telegram case: two people trade numbers (mutual contacts, so Telegram exposes
    // the phone) and link their PHONES on their accounts, not their @usernames. The digits
    // must match a phone-shaped linked handle; ids that merely contain digits never count.
    const a = new FakeAdapter();
    a.peer = 'Matteo Negri'; // display name matches no contact label
    a.handle = null; // no @username anywhere
    a.phone = '393331234567';
    const MATTEO = { fingerprint: 'f1', label: '@matteo', verified: false, safetyNumber: '0', fingerprintHex: '0', handles: { whatsapp: '393331234567' } };
    const DECOY = { fingerprint: 'f2', label: '@decoy', verified: false, safetyNumber: '0', fingerprintHex: '0', handles: { messenger: '100393331234567' } };
    let bound: string | null = null;
    let resolved = false;
    const ctrl = new Controller(a, async (req) => {
      if (req.type === 'threadContact') return { contact: bound === thread() ? MATTEO : null };
      if (req.type === 'contacts') return { contacts: [MATTEO, DECOY] };
      if (req.type === 'bindThread') {
        expect(req.fingerprint).toBe('f1');
        bound = req.threadId;
        return { ok: true };
      }
      if (req.type === 'resolvePeer') resolved = true;
      return {};
    });
    await ctrl.scan();
    await sleep(20);
    expect(resolved).toBe(false);
    expect(bound).toBe(thread());
    expect(a.states.at(-1)).toMatchObject({ kind: 'on', label: '@matteo' });
  });

  it('degrades to a one-click offer when the broker refuses the auto-bind (user opted out)', async () => {
    const a = new FakeAdapter();
    a.peer = 'Kirill Vasilev';
    a.handle = 'demo1';
    const KIRILL = { fingerprint: 'f1', label: '@kirill', verified: false, safetyNumber: '0', fingerprintHex: '0', handles: { fake: 'demo1' } };
    let bound: string | null = null;
    const ctrl = new Controller(a, async (req) => {
      if (req.type === 'threadContact') return { contact: bound === thread() ? KIRILL : null };
      if (req.type === 'contacts') return { contacts: [KIRILL] };
      if (req.type === 'bindThread') {
        if (req.auto) return { error: 'opted-out' }; // the user turned this chat off
        bound = req.threadId; // …but an explicit click overrides the sticky off
        return { ok: true };
      }
      return {};
    });
    await ctrl.scan();
    await sleep(20);
    expect(a.states.at(-1)).toMatchObject({ kind: 'off', suggestLabel: '@kirill' });
    // What peerInfo hands the popup, so it pre-selects the match instead of a blind dropdown.
    expect(ctrl.suggestionFor(thread())).toEqual({ fingerprint: 'f1', label: '@kirill' });
    expect(ctrl.suggestionFor(thread('elsewhere'))).toBeNull();

    // Clicking the offer must bind: it revalidates by the HANDLE the match was made on —
    // the display name ("Kirill Vasilev") never equals the contact label ("@kirill"), and
    // comparing those bricked the chat with an eternal "This chat changed".
    a.lastActions!.enable();
    await sleep(0);
    expect(bound).toBe(thread());
    expect(a.states.at(-1)).toMatchObject({ kind: 'on', label: '@kirill' });
  });

  it('re-enables from the glyph after a turn-off even when the label is not the display name', async () => {
    const a = new FakeAdapter();
    a.peer = 'Kirill Vasilev';
    a.handle = 'demo1';
    const KIRILL = { fingerprint: 'f1', label: '@kirill', verified: false, safetyNumber: '0', fingerprintHex: '0' };
    let bound: string | null = thread();
    const ctrl = new Controller(a, async (req) => {
      if (req.type === 'threadContact') return { contact: bound === thread() ? KIRILL : null };
      if (req.type === 'contacts') return { contacts: [KIRILL] };
      if (req.type === 'unbindThread') {
        bound = null;
        return { ok: true };
      }
      if (req.type === 'bindThread') {
        bound = req.threadId;
        return { ok: true };
      }
      return {};
    });
    await ctrl.scan();
    await sleep(20);
    expect(a.states.at(-1)).toMatchObject({ kind: 'on', label: '@kirill' });

    a.lastActions!.disable();
    await sleep(0);
    expect(bound).toBeNull();
    expect(a.states.at(-1)).toMatchObject({ kind: 'off', suggestLabel: '@kirill' });

    a.lastActions!.enable();
    await sleep(0);
    expect(bound).toBe(thread());
    expect(a.states.at(-1)).toMatchObject({ kind: 'on', label: '@kirill' });
  });

  it('renders a first-contact handshake as an offer card and accepts it into a live chat', async () => {
    const a = new FakeAdapter();
    a.peer = 'Maya';
    const contact = { fingerprint: 'f', label: 'Maya', verified: false, safetyNumber: '0', fingerprintHex: '0' };
    let bound = false;
    const ctrl = new Controller(a, async (req) => {
      if (req.type === 'threadContact') return { contact: bound ? contact : null };
      if (req.type === 'contacts') return { contacts: [] };
      if (req.type === 'resolvePeer') return { error: 'not-found' };
      if (req.type === 'ingest') return bound ? { ok: true } : { error: 'no-contact' };
      if (req.type === 'acceptInvite') {
        bound = true;
        return { ok: true, contact };
      }
      return {};
    });
    a.add('RSN1H:first-contact');
    a.add('RSN1M:sealed');

    await ctrl.scan();
    expect(a.rendered()[0]).toContain('Maya wants to chat privately');
    expect(a.rendered()[1]).toContain('set up Ekko with Maya');
    expect(a.states.at(-1)).toMatchObject({ kind: 'off', invite: 'ready', inviteKind: 'handshake', peer: 'Maya' });

    a.lastActions!.acceptInvite();
    await sleep(0);
    expect(a.states.at(-1)).toMatchObject({ kind: 'on', label: 'Maya' });
  });

  it('prefers a same-key handshake over an invite, but refuses a different key', async () => {
    const a = new FakeAdapter();
    const me = generateIdentity();
    const peer = generateIdentity();
    const attacker = generateIdentity();
    const ctrl = new Controller(a, async (req) => {
      if (req.type === 'threadContact') return { contact: null };
      if (req.type === 'contacts') return { contacts: [] };
      if (req.type === 'ingest') return { error: 'no-contact' };
      return {};
    });
    a.add(formatInvite(peer.bundle));
    await ctrl.scan();
    expect(a.states.at(-1)).toMatchObject({ kind: 'off', invite: 'ready', inviteKind: 'invite' });

    a.add(formatHandshake(startHandshake(peer, me.bundle).wire));
    await ctrl.scan();
    expect(a.states.at(-1)).toMatchObject({ kind: 'off', invite: 'ready', inviteKind: 'handshake' });

    a.add(formatHandshake(startHandshake(attacker, me.bundle).wire));
    await ctrl.scan();
    expect(a.states.at(-1)).toMatchObject({ kind: 'off', invite: 'ambiguous' });
  });

  it('drops a second send while one is in flight (no duplicate from a held Enter)', async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const aAdapter = new FakeAdapter();
    const aBridge = makeParty(alice, [bob]);
    await bind(aBridge, bytesToHex(bob.fingerprint));
    const aCtrl = new Controller(aAdapter, aBridge);
    // Fire twice without awaiting: the in-flight guard drops the second (send() sets the
    // flag synchronously before its first await).
    const p1 = aCtrl.sendHook().handle('once');
    const p2 = aCtrl.sendHook().handle('once');
    await Promise.all([p1, p2]);
    expect(aAdapter.wire.filter((t) => t.startsWith('EKK1M:'))).toHaveLength(1); // exactly one message
    expect(aAdapter.toasts.some((t) => t.includes('Still sending'))).toBe(true); // not silent
  });

  it('BLOCKS sends in a previously-encrypted chat while the vault is locked (never silent plaintext)', async () => {
    // Bridge behaves like a locked background: threadContact answers from the plain
    // linked-thread cache, encrypt refuses.
    const bridge: Bridge = async (req) => {
      if (req.type === 'threadContact') return { error: 'locked', wasLinked: true };
      if (req.type === 'encrypt') return { error: 'locked' };
      return {};
    };
    const a = new FakeAdapter();
    const ctrl = new Controller(a, bridge);
    await ctrl.scan(); // resolves the thread → learns "was linked, now locked"
    expect(a.states.some((s) => s.kind === 'locked')).toBe(true);
    expect(ctrl.sendHook().shouldHandle('secret')).toBe(true); // intercepted…
    await ctrl.sendHook().handle('secret');
    expect(a.wire).toHaveLength(0); // …and blocked — never plain, never ciphertext
    expect(a.toasts.some((t) => /unlock/i.test(t))).toBe(true);
  });

  it('shows "unknown" (never hidden) while 1:1 status is unresolved, and recovers via retry', async () => {
    const a = new FakeAdapter();
    a.direct = null; // page still rendering / selector drift: can't confirm DM vs group
    const ctrl = new Controller(a, async (req) => (req.type === 'threadContact' ? { contact: null } : {}));
    await ctrl.scan();
    expect(a.states.at(-1)).toMatchObject({ kind: 'unknown' }); // fail-visible, not invisible
    expect(ctrl.sendHook().shouldHandle('secret')).toBe(true); // and sends stay intercepted

    a.direct = true; // the page finished rendering
    a.lastActions!.retry();
    await sleep(250); // retryPending's refresh + debounced rescan
    expect(a.states.at(-1)).toMatchObject({ kind: 'off' });
  });

  it('shows "unknown" when a chat surface is open but its id never resolved (WhatsApp empty-chat shape)', async () => {
    const a = new FakeAdapter();
    a.tid = null; // WhatsApp: no message row rendered yet → no jid; Telegram WebK: no data-peer-id
    a.direct = null; // …but the chat pane IS open (adapter can tell), so don't fail invisible
    const ctrl = new Controller(a, async () => ({}));
    await ctrl.scan();
    expect(a.states.at(-1)).toMatchObject({ kind: 'unknown' });
  });

  it('shows "unknown" instead of a wrong "off" while the background is unreachable', async () => {
    const a = new FakeAdapter();
    const ctrl = new Controller(a, async () => ({ error: 'unreachable' }));
    await ctrl.scan();
    expect(a.states.at(-1)).toMatchObject({ kind: 'unknown' });
    expect(ctrl.sendHook().shouldHandle('secret')).toBe(true); // unresolved chat: block, never plain
  });

  it('a manually sealed blob passes the send gate natively even in an unresolved chat', async () => {
    const a = new FakeAdapter();
    a.direct = null; // identity never resolved — exactly the chat manual seal exists for
    const ctrl = new Controller(a, async () => ({ error: 'unreachable' }));
    await ctrl.scan();
    expect(ctrl.sendHook().shouldHandle('secret')).toBe(true); // prose still blocks (fail closed)
    const blob = `${formatHandshake(new Uint8Array([1]))}\n\n${formatMessage(new Uint8Array([2]))}`;
    expect(ctrl.sendHook().shouldHandle(blob)).toBe(false); // pure ciphertext rides the native send
  });

  it('a multi-block sealed bubble names the vault contact, offers the link, and decrypts after the tap', async () => {
    const grandma = { fingerprint: 'f1', label: 'Бабуля', verified: false, safetyNumber: '0', fingerprintHex: '0' };
    const a = new FakeAdapter();
    a.peer = 'Бабуля ❤';
    let bound = false;
    const ctrl = new Controller(a, async (req) => {
      if (req.type === 'threadContact') return { contact: bound ? grandma : null };
      if (req.type === 'contacts') return { contacts: [] };
      if (req.type === 'bindThread') {
        bound = true;
        return { ok: true };
      }
      if (req.type === 'ingest' && req.kind === 'handshake') return { ok: true }; // own echo
      if (req.type === 'ingest' && req.kind === 'message')
        return bound ? { ok: true, plaintext: 'позвони мне' } : { error: 'no-contact', contact: grandma };
      return {};
    });
    a.add('EKK1H:setupsetup\n\nEKK1M:bodybody'); // the manual seal's output, sent as ONE message

    await ctrl.scan();
    // The bubble is covered with a hint that names the key's owner, and the glyph offers
    // the one-tap link — no more "set up Ekko with X" dead end.
    expect(a.bubbles[0]!._status).toBe('pending');
    expect(a.bubbles[0]!._rendered).toContain('Бабуля');
    expect(a.states.at(-1)).toMatchObject({ kind: 'off', suggestLabel: 'Бабуля' });

    // The tap binds even though the chat header ('Бабуля ❤') doesn't equal the contact's
    // Ekko label — a session-derived offer carries its identity from the vault, not the DOM.
    a.lastActions!.enable();
    await sleep(250); // bind + the debounced retry rescan
    expect(a.bubbles[0]!._status).toBe('decrypted');
    expect(a.bubbles[0]!._rendered).toBe('позвони мне');
  });

  it('offers the session-derived link even while the 1:1 never confirms — reading unblocks, sending stays paused', async () => {
    // The WhatsApp transcript bug: bubbles ingested while the 1:1 heuristic held, then a
    // composer re-render flipped it back to unresolved — bubbles say "click the Ekko
    // button to read" while the unknown-state glyph rendered no such button. A
    // session-derived offer carries the vault's own identity, so it may keep showing.
    const matteo = { fingerprint: 'f1', label: '@matteo', verified: false, safetyNumber: '0', fingerprintHex: '0' };
    const a = new FakeAdapter();
    let bound = false;
    const ctrl = new Controller(a, async (req) => {
      if (req.type === 'threadContact') return { contact: bound ? matteo : null };
      if (req.type === 'contacts') return { contacts: [] };
      if (req.type === 'bindThread') {
        bound = true;
        return { ok: true };
      }
      if (req.type === 'ingest' && req.kind === 'message')
        return bound ? { ok: true, plaintext: 'ciao' } : { error: 'no-contact', contact: matteo };
      return {};
    });
    a.add('EKK1M:bodybody');

    await ctrl.scan();
    expect(a.bubbles[0]!._status).toBe('pending');

    a.direct = null; // the re-render breaks the 1:1 heuristic — surface unconfirmed again
    await ctrl.scan();
    expect(a.states.at(-1)).toMatchObject({ kind: 'unknown', suggestLabel: '@matteo' });

    a.lastActions!.enable();
    await sleep(250); // bind + the debounced retry rescan
    expect(a.bubbles[0]!._status).toBe('decrypted');
    expect(a.bubbles[0]!._rendered).toBe('ciao');
    // Bound is not a license to send: the surface still isn't a confirmed 1:1.
    await ctrl.sendHook().handle('hello');
    expect(a.wire).toHaveLength(0);
    // And the offer button retires once the thread is bound.
    expect(a.states.at(-1)).toMatchObject({ kind: 'unknown' });
    expect((a.states.at(-1) as { suggestLabel?: string }).suggestLabel).toBeUndefined();
  });

  it('glyph "send next message unencrypted" lets exactly one message pass natively', async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const a = new FakeAdapter();
    const bridge = makeParty(alice, [bob]);
    const ctrl = new Controller(a, bridge);
    await bind(bridge, bytesToHex(bob.fingerprint));
    await ctrl.scan();
    expect(ctrl.sendHook().shouldHandle('hey')).toBe(true); // linked → intercepts
    a.lastActions!.plainOnce(true);
    expect(a.states.at(-1)).toMatchObject({ kind: 'on', plainOnce: true });
    expect(ctrl.sendHook().shouldHandle('hey')).toBe(false); // consumed: this one rides plain
    const after = a.states.at(-1)!;
    expect(after.kind).toBe('on');
    expect((after as { plainOnce?: boolean }).plainOnce).toBeUndefined(); // disarmed after one use
  });

  it('aborts a multi-part send when the user switches chats mid-flight', async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const a = new FakeAdapter(120); // tiny cap forces chunking
    const bridge = makeParty(alice, [bob]);
    await bind(bridge, bytesToHex(bob.fingerprint));
    const ctrl = new Controller(a, bridge);
    const orig = a.injectAndSend.bind(a);
    a.injectAndSend = async (t: string) => {
      await orig(t);
      a.tid = 't2'; // user navigates away right after the first part
    };
    await ctrl.sendHook().handle('z'.repeat(600));
    expect(a.wire).toHaveLength(1); // remaining chunks never land in the wrong chat
    expect(a.toasts.some((t) => t.includes('interrupted'))).toBe(true); // honest partial report
  });

  it('reports honestly when injection fails before anything was sent', async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const a = new FakeAdapter();
    const bridge = makeParty(alice, [bob]);
    await bind(bridge, bytesToHex(bob.fingerprint));
    const ctrl = new Controller(a, bridge);
    a.failSend = true;
    await ctrl.sendHook().handle('hello');
    expect(a.wire).toHaveLength(0);
    expect(a.toasts.some((t) => t.includes('Nothing was sent'))).toBe(true);
  });

  it('namespaces provider conversation IDs before any broker call', async () => {
    const seen: string[] = [];
    const bridge: Bridge = async (req) => {
      if (req.type === 'threadContact') {
        seen.push(req.threadId);
        return { contact: null };
      }
      return {};
    };
    const ctrl = new Controller(new FakeAdapter(), bridge);
    await ctrl.scan();
    expect(seen).toEqual([thread()]);
  });

  it('fails closed while a chat binding is still resolving', async () => {
    let resolveContact!: (value: { contact: null }) => void;
    const waiting = new Promise<{ contact: null }>((resolve) => (resolveContact = resolve));
    const bridge: Bridge = async (req) => {
      if (req.type === 'threadContact') return waiting;
      if (req.type === 'encrypt') return { error: 'should-not-encrypt' };
      return {};
    };
    const a = new FakeAdapter();
    const ctrl = new Controller(a, bridge);

    expect(ctrl.sendHook().shouldHandle('not leaked')).toBe(true);
    const pending = ctrl.sendHook().handle('not leaked');
    resolveContact({ contact: null });
    await pending;
    expect(a.wire).toHaveLength(0);
    expect(a.toasts.some((t) => t.includes('Press Send again'))).toBe(true);
  });

  it('keeps an unresolved chat blocked when the background is unavailable', async () => {
    const a = new FakeAdapter();
    const ctrl = new Controller(a, async (req) => (req.type === 'threadContact' ? { error: 'unreachable' } : {}));

    expect(ctrl.sendHook().shouldHandle('not leaked')).toBe(true);
    await ctrl.sendHook().handle('not leaked');
    expect(a.wire).toHaveLength(0);
    expect(a.toasts.some((t) => t.includes('Reload the page'))).toBe(true);
  });

  it('fails closed while the direct-chat header is still resolving', async () => {
    const a = new FakeAdapter();
    a.direct = null;
    const ctrl = new Controller(a, async () => ({ contact: null }));

    expect(ctrl.sendHook().shouldHandle('not leaked')).toBe(true);
    await ctrl.sendHook().handle('not leaked');
    expect(a.wire).toHaveLength(0);
    expect(a.toasts.some((t) => t.includes('identifying this conversation'))).toBe(true);
  });

  it('does not ingest a stale thread after the user leaves a chat', async () => {
    const ingested: string[] = [];
    const bridge: Bridge = async (req) => {
      if (req.type === 'threadContact') return { contact: null };
      if (req.type === 'ingest') {
        ingested.push(req.threadId);
        return { error: 'no-contact' };
      }
      return {};
    };
    const a = new FakeAdapter();
    const ctrl = new Controller(a, bridge);
    await ctrl.scan();
    a.add('RSN1M:abcd');
    a.tid = null;
    await ctrl.scan();
    expect(ingested).toEqual([]);
  });

  it('stays transparent for a non-direct chat', async () => {
    const a = new FakeAdapter();
    a.direct = false;
    const ctrl = new Controller(a, async () => ({ contact: null }));
    await ctrl.scan();
    expect(ctrl.sendHook().shouldHandle('group message')).toBe(false);
  });

  it('blocks a legacy protected binding when the view is confirmed as a group', async () => {
    const a = new FakeAdapter();
    a.direct = false;
    const ctrl = new Controller(a, async (req) =>
      req.type === 'threadContact'
        ? { contact: { fingerprint: 'f', label: 'peer', verified: false, safetyNumber: '0', fingerprintHex: '0' } }
        : {},
    );
    await ctrl.scan();
    expect(ctrl.sendHook().shouldHandle('not leaked')).toBe(true);
    await ctrl.sendHook().handle('not leaked');
    expect(a.wire).toHaveLength(0);
    expect(a.toasts.some((t) => t.includes('Groups and channels'))).toBe(true);
  });

  it('keeps partial chunks when navigating away and back to a direct chat', async () => {
    const ingested: string[] = [];
    const bridge: Bridge = async (req) => {
      if (req.type === 'threadContact') return { contact: null };
      if (req.type === 'ingest') {
        ingested.push(req.raw);
        return { error: 'no-contact' };
      }
      return {};
    };
    const a = new FakeAdapter();
    const ctrl = new Controller(a, bridge);
    a.add('RSN1C:abc:0/2:RSN1M:');
    await ctrl.scan();
    a.tid = 't2';
    await ctrl.scan();
    a.tid = 't1';
    a.add('RSN1C:abc:1/2:abcd');
    await ctrl.scan();
    expect(ingested).toEqual(['RSN1M:abcd']);
  });

  it('renders a cross-thread replay as a terminal error', async () => {
    const a = new FakeAdapter();
    const ctrl = new Controller(a, async (req) => {
      if (req.type === 'threadContact') return { contact: null };
      if (req.type === 'ingest') return { error: 'wrong-thread' };
      return {};
    });
    a.add('RSN1M:abcd');
    await ctrl.scan();
    expect(a.rendered()).toContain('This message couldn’t be decrypted');
  });

  it('the no-offer chat hands over the invite pitch: clipboard + toast, handle-aware, locked-safe', async () => {
    const copied: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => void copied.push(t) } });

    const a = new FakeAdapter();
    const ctrl = new Controller(a, async (req) => {
      if (req.type === 'threadContact') return { contact: null };
      if (req.type === 'invite') return { invite: 'EKK1I:x', username: 'kirill' };
      return {};
    });
    await ctrl.scan(); // resolves the thread → the glyph lands on the plain off state
    expect(a.states.at(-1)).toMatchObject({ kind: 'off' });
    a.lastActions!.invitePeer();
    await sleep(0);
    // The pitch carries the @handle as an invite LINK and is never auto-sent — nothing hit the wire.
    expect(copied[0]).toContain('https://useekko.app/i#@kirill');
    expect(a.wire).toEqual([]);
    expect(a.toasts.at(-1)).toMatch(/Invite copied/);

    // Locked vault: the generic pitch still works — growth must not require an unlock.
    const b = new FakeAdapter();
    const locked = new Controller(b, async (req) => {
      if (req.type === 'threadContact') return { error: 'locked', wasLinked: false };
      if (req.type === 'invite') return { error: 'locked' };
      return {};
    });
    await locked.scan();
    b.lastActions!.invitePeer();
    await sleep(0);
    expect(copied[1]).toContain('send me your Ekko invite');
    expect(copied[1]).not.toContain('@kirill');
  });
});

// The orphan watchdog (boot.ts) calls stop() when the extension context dies. The send
// interceptors stay alive on purpose — fail closed — but no new scans may be scheduled.
describe('orphan teardown', () => {
  it('stop() halts scan scheduling', async () => {
    const a = new FakeAdapter();
    const ctrl = new Controller(a, async () => ({ contact: null }));
    ctrl.requestScan();
    await sleep(200);
    const painted = a.states.length;
    expect(painted).toBeGreaterThan(0);
    ctrl.stop();
    ctrl.requestScan();
    await sleep(250);
    expect(a.states.length).toBe(painted);
  });
});
