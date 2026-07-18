import { describe, it, expect, beforeAll } from 'vitest';
import { deviceIdentity, generateMnemonic } from '../src/core/recovery.js';
import { formatInvite, formatMessage, decodeBody, classify } from '../src/core/wire.js';
import { acceptHandshake, startHandshake, sealMessage, openMessage, fingerprint as fpOf, type Session } from '../src/core/crypto.js';
import { manualThreadId } from '../src/core/thread.js';
import { b64uEncode } from '../src/core/b64.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Req, Res } from '../src/core/rpc.js';

// The thing that was missing, and the reason the keyboard used to say it had nobody to seal to:
//
//   connecting with someone on the account gave you their Instagram handle and NOTHING you could
//   encrypt with. Their key lived in a different system, and nothing carried it across.
//
// Now the public key rides in the profile, so an accepted connection IS an encrypted channel. This
// file pins that, and pins the four ways it must NOT overreach:
//
//   * a PENDING connection gives you nothing (consent comes first),
//   * a connection whose account never made an identity gives you nothing (there is no key to take),
//   * a contact you already have is left completely alone (never renamed out from under you),
//   * and an adopted key lands UNVERIFIED — the server's word is not the safety number.
//
// It also pins the session_setups MAILBOX — the channel that replaced the in-chat EKK1H preamble
// (the iOS keyboard never puts setup in the conversation anymore):
//
//   * as requester this browser STAGES its setup against the connection, even while pending,
//   * once staged, a first send carries NO preamble — one EKK1M token the peer can open,
//   * as addressee it ADOPTS the setup the requester staged — including mid-ingest, so a message
//     from a phone-initiated session heals instead of hanging at "waiting for the secure channel",
//   * and a backend WITHOUT the mailbox degrades to key adoption, never a dead sync.

const ME = deviceIdentity(generateMnemonic(), 0);
const MAYA = deviceIdentity(generateMnemonic(), 0);
const PENDING = deviceIdentity(generateMnemonic(), 0);
const RITA = deviceIdentity(generateMnemonic(), 0);
const NOAH = deviceIdentity(generateMnemonic(), 0);
const VAULT_PASS = 'a passphrase for this browser';

const MY_UID = 'aaaaaaaa-0000-0000-0000-000000000001';
const MAYA_UID = 'bbbbbbbb-0000-0000-0000-000000000002';
const PENDING_UID = 'cccccccc-0000-0000-0000-000000000003';
const KEYLESS_UID = 'dddddddd-0000-0000-0000-000000000004';
const RITA_UID = 'eeeeeeee-0000-0000-0000-000000000005';
const NOAH_UID = 'ffffffff-0000-0000-0000-000000000006';
const PIA_UID = '99999999-0000-0000-0000-000000000007';

const CONN_MAYA = '11111111-0000-0000-0000-00000000000a';
const CONN_PENDING = '22222222-0000-0000-0000-00000000000b';
const CONN_KEYLESS = '33333333-0000-0000-0000-00000000000c';
const CONN_RITA = '44444444-0000-0000-0000-00000000000d';
const CONN_NOAH = '55555555-0000-0000-0000-00000000000e';
const CONN_PIA = '66666666-0000-0000-0000-00000000000f';

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`;
}
const TOKEN = jwt({ sub: MY_UID, email: 'kirill@useekko.app' });

/** What the server holds. `published` is what this browser PATCHed onto its own row. */
let published: string | null = null;

/** The session_setups mailbox. Down at first — the live backend predates the table. */
let mailboxDown = true;
interface SetupRow {
  connection_id: string;
  sender: string;
  recipient: string;
  sender_key: string;
  recipient_key: string;
  handshake: string;
}
const setupRows: SetupRow[] = [];
let setupPosts = 0;

const profile = (uid: string, handle: string, key: string | null) => ({
  user_id: uid,
  handle,
  display_name: null,
  public_key: key,
});

/** The connection graph, mutable: accept PATCHes it, decline DELETEs from it, and Rita's
 *  edge arrives later (the phone-initiated flow) — tests push it when she appears. */
const conns: Record<string, unknown>[] = [
  // Accepted, and she has published a key: this is the one that should become a contact.
  {
    id: CONN_MAYA,
    status: 'accepted',
    requester: MY_UID,
    addressee: MAYA_UID,
    requester_profile: profile(MY_UID, 'kirill', null),
    addressee_profile: profile(MAYA_UID, 'maya', formatInvite(MAYA.bundle)),
  },
  // Asked, not accepted. Consent has not happened, so neither has the key exchange —
  // but the REQUESTER's setup may stage (RLS keeps it invisible until acceptance).
  {
    id: CONN_PENDING,
    status: 'pending',
    requester: MY_UID,
    addressee: PENDING_UID,
    requester_profile: profile(MY_UID, 'kirill', null),
    addressee_profile: profile(PENDING_UID, 'jonas', formatInvite(PENDING.bundle)),
  },
  // Accepted, but nobody ever set Ekko up for that account — there is no key in existence.
  {
    id: CONN_KEYLESS,
    status: 'accepted',
    requester: KEYLESS_UID,
    addressee: MY_UID,
    requester_profile: profile(KEYLESS_UID, 'kvasilev', null),
    addressee_profile: profile(MY_UID, 'kirill', null),
  },
  // Noah ASKED ME. Until I accept, he must be a visible request and nothing else.
  {
    id: CONN_NOAH,
    status: 'pending',
    requester: NOAH_UID,
    addressee: MY_UID,
    requester_profile: profile(NOAH_UID, 'noah', formatInvite(NOAH.bundle)),
    addressee_profile: profile(MY_UID, 'kirill', null),
  },
];

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  if (url.includes('/auth/v1/verify')) {
    return json({ access_token: TOKEN, refresh_token: 'r', expires_in: 3600 });
  }
  if (url.includes('/rest/v1/key_backups')) return json([]);

  if (url.includes('/rest/v1/session_setups')) {
    if (mailboxDown) return json({ message: 'relation "public.session_setups" does not exist' }, 404);
    if (method === 'POST') {
      setupPosts++;
      const row = JSON.parse(String(init?.body)) as SetupRow & { sender?: string };
      row.sender = MY_UID; // auth.uid() server-side; the client never sends it
      const i = setupRows.findIndex((r) => r.connection_id === row.connection_id && r.sender === MY_UID);
      if (i >= 0) setupRows[i] = row; // upsert on (connection_id, sender)
      else setupRows.push(row);
      return json([row], 201);
    }
    return json(setupRows);
  }

  if (url.includes('/rest/v1/profiles')) {
    if (method === 'PATCH') {
      // RLS pins this to the caller's own row; the client filters by it too.
      expect(url).toContain(`user_id=eq.${MY_UID}`);
      published = (JSON.parse(String(init?.body)) as { public_key: string }).public_key;
      return json([]);
    }
    return json([profile(MY_UID, 'kirill', published)]);
  }

  if (url.includes('/rest/v1/connections')) {
    if (method === 'PATCH') {
      // Accept: addressee-only, pending-only, exactly like the RLS policy.
      const id = url.match(/id=eq\.([^&]+)/)?.[1];
      const body = JSON.parse(String(init?.body)) as { status: string; responded_at?: string };
      expect(body.status).toBe('accepted');
      expect(body.responded_at).toBeTruthy();
      const row = conns.find((c) => c.id === id && c.status === 'pending' && c.addressee === MY_UID);
      if (!row) return json([]); // not yours / not pending → empty representation, no change
      row.status = 'accepted';
      return json([row]);
    }
    if (method === 'DELETE') {
      const id = url.match(/id=eq\.([^&]+)/)?.[1];
      const i = conns.findIndex((c) => c.id === id);
      if (i >= 0) conns.splice(i, 1);
      return json([]);
    }
    return json(conns);
  }

  if (url.includes('/rest/v1/account_handles')) {
    // Maya linked her Instagram; the account_handles RLS lets an accepted connection read it. This
    // row is what lets an @maya_ig chat bind to the Maya contact instead of a directory look-alike.
    // The WhatsApp row is stored as the phone types it — the adapter reads bare digits off the
    // page, so the sync must canonicalize or auto-bind never fires (the @matteo bug).
    return json([
      { user_id: MAYA_UID, platform: 'instagram', handle: 'maya_ig' },
      { user_id: MAYA_UID, platform: 'whatsapp', handle: '+39 333 123-4567' },
    ]);
  }
  throw new Error(`unexpected fetch: ${method} ${url}`);
}) as typeof fetch;

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
    getManifest: () => ({ version: '0.6.3' }),
  },
};
const call = (req: Req): Promise<Res> => new Promise((resolve) => listener!(req, {}, resolve));

const myBundle = () => decodeBody(published!); // what this browser published: EKK1I: + b64u(bundle)

/** Rita's side of the phone-staged session; a later test proves it survives lock/unlock. */
let ritaSession: Session | null = null;

describe('an accepted connection is an encrypted channel', () => {
  beforeAll(async () => {
    await import('../src/background.js'); // registers the listener against the shim above
    await call({ type: 'create', passphrase: VAULT_PASS });
    await call({ type: 'acctVerify', email: 'kirill@useekko.app', code: '12345678' });
  });

  it('publishes this device’s public key against my handle — and only the public one', async () => {
    // The mailbox is still down here: a backend without the table must degrade to key
    // publication and adoption, never a dead sync.
    const before = await call({ type: 'acctSync' });
    expect(before.ok).toBe(true);
    expect(setupPosts).toBe(0);

    const mine = await call({ type: 'invite' });
    expect(published).toBe(mine.invite);
    // What went up is an invite and nothing else: it is a public key, which is why it is allowed to
    // sit on a server at all. The phrase must never appear anywhere near it.
    const phrase = (await call({ type: 'getRecoveryPhrase' })).mnemonic!;
    expect(published).not.toContain(phrase.split(' ')[0]);
    expect(published!.startsWith('EKK1I:')).toBe(true);
  });

  it('adopts the key of an accepted connection, unverified, and skips everyone else', async () => {
    await call({ type: 'acctSync' });
    const contacts = (await call({ type: 'contacts' })).contacts ?? [];

    // Maya accepted and published a key: she is now someone the keyboard can seal to.
    const maya = contacts.find((c) => c.label === '@maya');
    expect(maya).toBeDefined();
    // The server said this is her key. That is a claim, not a proof — so it lands UNVERIFIED, and
    // the safety number is what upgrades it. This assertion is the whole trust model.
    expect(maya!.verified).toBe(false);
    expect(maya!.safetyNumber).toBeTruthy();

    // Her linked Instagram rode down with the connection (account_handles), so a chat with
    // @maya_ig binds to THIS contact by handle instead of the directory minting a look-alike.
    expect(maya!.handles?.instagram).toBe('maya_ig');
    // The phone-typed WhatsApp number reduced to the bare digits the adapter reads off the page.
    expect(maya!.handles?.whatsapp).toBe('393331234567');

    // Jonas only ASKED. Consent has not happened, so no key crosses.
    expect(contacts.some((c) => c.label === '@jonas')).toBe(false);

    // @kvasilev is connected but no device ever made it an identity, so there is no key to take —
    // exactly the state a demo account sits in, and it must not become a half-broken contact.
    expect(contacts.some((c) => c.label === '@kvasilev')).toBe(false);

    expect(contacts).toHaveLength(1);
  });

  it('is idempotent, and never renames a contact you have already named', async () => {
    const [maya] = (await call({ type: 'contacts' })).contacts!;
    await call({ type: 'renameContact', fingerprint: maya!.fingerprint, label: 'Maya from work' });

    const again = await call({ type: 'acctSync' });
    expect(again.restoredContacts).toBe(0); // nothing new to take

    const contacts = (await call({ type: 'contacts' })).contacts ?? [];
    expect(contacts).toHaveLength(1);
    // A sync that ran on every foreground and kept resetting the name you chose would be maddening.
    expect(contacts[0]!.label).toBe('Maya from work');
  });
});

describe('session setup travels through the connection, not the conversation', () => {
  it('stages this browser’s setup as requester — for accepted AND pending connections', async () => {
    mailboxDown = false; // the migration landed
    const res = await call({ type: 'acctSync' });
    expect(res.ok).toBe(true);

    // One row per connection I requested: Maya (accepted) and Jonas (pending — RLS keeps his
    // invisible until he accepts). Rita's connection doesn't exist yet; keyless has no key.
    expect(setupRows.map((r) => r.connection_id).sort()).toEqual([CONN_MAYA, CONN_PENDING].sort());
    const row = setupRows.find((r) => r.connection_id === CONN_MAYA)!;
    expect(row.recipient).toBe(MAYA_UID);
    expect(row.sender_key).toBe(bytesToHex(fpOf(myBundle())));
    expect(row.recipient_key).toBe(bytesToHex(fpOf(MAYA.bundle)));
    expect(row.handshake.startsWith('EKK1H:')).toBe(true);

    // The staged handshake is REAL: Maya's device accepts it and sees exactly this browser.
    const opened = acceptHandshake(MAYA, decodeBody(classify(row.handshake)!.raw));
    expect(b64uEncode(opened.peerBundle)).toBe(b64uEncode(myBundle()));
  });

  it('re-sync publishes nothing again — the mailbox owns the durable copy', async () => {
    const posts = setupPosts;
    const again = await call({ type: 'acctSync' });
    expect(again.ok).toBe(true);
    expect(again.adoptedSessions).toBe(0);
    expect(setupPosts).toBe(posts); // handshakeWire cleared after publish, so nothing re-stages
  });

  it('first send to a mailbox contact carries NO in-chat preamble, and the peer can read it', async () => {
    const maya = (await call({ type: 'contacts' })).contacts!.find((c) => c.label === 'Maya from work')!;
    const res = await call({
      type: 'manualEncrypt',
      threadId: manualThreadId('instagram'),
      fingerprint: maya.fingerprint,
      plaintext: 'no preamble in the conversation anymore',
    });
    // ONE token — the message. The EKK1H setup already went through the account.
    expect(res.tokens).toHaveLength(1);
    expect(res.tokens![0]!.startsWith('EKK1M:')).toBe(true);

    // And it is not write-only: the session Maya derives from the STAGED handshake opens it.
    const row = setupRows.find((r) => r.connection_id === CONN_MAYA)!;
    const hers = acceptHandshake(MAYA, decodeBody(classify(row.handshake)!.raw)).session;
    expect(openMessage(hers, decodeBody(res.tokens![0]!))).toBe('no preamble in the conversation anymore');
  });

  it('a message from a phone-initiated session heals mid-ingest instead of waiting forever', async () => {
    // Rita connected FROM HER PHONE: she requested, I accepted there, her setup sits in the
    // mailbox — and nothing about it ever appeared in any chat. This browser has never synced
    // since. The old behavior: her messages hang at "waiting for the secure channel".
    const hs = startHandshake(RITA, myBundle());
    ritaSession = hs.session;
    setupRows.push({
      connection_id: CONN_RITA,
      sender: RITA_UID,
      recipient: MY_UID,
      sender_key: bytesToHex(fpOf(RITA.bundle)),
      recipient_key: bytesToHex(fpOf(myBundle())),
      handshake: 'EKK1H:' + b64uEncode(hs.wire),
    });
    conns.push({
      id: CONN_RITA,
      status: 'accepted',
      requester: RITA_UID,
      addressee: MY_UID,
      requester_profile: profile(RITA_UID, 'rita', formatInvite(RITA.bundle)),
      addressee_profile: profile(MY_UID, 'kirill', published),
    });

    const token = formatMessage(sealMessage(hs.session as Session, 'hi from the phone'));

    // A page ingest in a chat that is not yet linked: the unknown session triggers ONE mailbox
    // pull, which adopts Rita's key AND her session. The thread still is not bound to her, so
    // the honest answer stays no-contact — but the channel now exists.
    const first = await call({ type: 'ingest', kind: 'message', raw: token, threadId: 'ig:rita-dm' });
    expect(first.error).toBe('no-contact');
    const rita = (await call({ type: 'contacts' })).contacts!.find((c) => c.label === '@rita');
    expect(rita).toBeDefined();

    // The user links the chat to her (or handle recognition does) — and the bubble decrypts.
    await call({ type: 'bindThread', threadId: 'ig:rita-dm', fingerprint: rita!.fingerprint });
    const second = await call({ type: 'ingest', kind: 'message', raw: token, threadId: 'ig:rita-dm' });
    expect(second.plaintext).toBe('hi from the phone');

    // And replying to her uses the SAME phone-staged session — one channel, both directions,
    // still no preamble.
    const reply = await call({
      type: 'encrypt',
      threadId: 'ig:rita-dm',
      plaintext: 'hello from the browser',
    });
    expect(reply.tokens).toHaveLength(1);
    expect(openMessage(hs.session as Session, decodeBody(reply.tokens![0]!))).toBe('hello from the browser');
  });
});

describe('an incoming request is a visible consent decision', () => {
  it('shows up in the sync result and adopts nothing until accepted', async () => {
    const res = await call({ type: 'acctSync' });
    expect(res.requests).toEqual([{ id: CONN_NOAH, handle: 'noah' }]);
    // Noah asked; consent has not happened, so his key must not have crossed.
    expect(((await call({ type: 'contacts' })).contacts ?? []).some((c) => c.label === '@noah')).toBe(false);
  });

  it('accept flips the row and lands the requester as an encryptable contact in one call', async () => {
    const res = await call({ type: 'acctAccept', connectionId: CONN_NOAH });
    expect(res.ok).toBe(true);
    expect(res.restoredContacts).toBe(1); // noah, adopted by the sync inside the accept
    expect(res.requests).toEqual([]);
    expect(((await call({ type: 'contacts' })).contacts ?? []).some((c) => c.label === '@noah')).toBe(true);
  });

  it('decline deletes the request without taking anything', async () => {
    conns.push({
      id: CONN_PIA,
      status: 'pending',
      requester: PIA_UID,
      addressee: MY_UID,
      requester_profile: profile(PIA_UID, 'pia', null),
      addressee_profile: profile(MY_UID, 'kirill', published),
    });
    expect((await call({ type: 'acctSync' })).requests).toEqual([{ id: CONN_PIA, handle: 'pia' }]);

    const res = await call({ type: 'acctDecline', connectionId: CONN_PIA });
    expect(res.ok).toBe(true);
    expect(conns.some((c) => c.id === CONN_PIA)).toBe(false);
    expect((await call({ type: 'acctSync' })).requests).toEqual([]);
    expect(((await call({ type: 'contacts' })).contacts ?? []).some((c) => c.label === '@pia')).toBe(false);
  });
});

describe('the send side heals from the mailbox too', () => {
  it('first send with no session pulls the mailbox instead of publishing an in-chat setup', async () => {
    // Noah accepted above; his key crossed but no session exists on this side — his phone
    // stages the setup AFTER this browser's last sync. The old behavior: the next send
    // invents an in-chat EKK1H preamble ("Secure-channel setup" sitting in the conversation).
    const hs = startHandshake(NOAH, myBundle());
    setupRows.push({
      connection_id: CONN_NOAH,
      sender: NOAH_UID,
      recipient: MY_UID,
      sender_key: bytesToHex(fpOf(NOAH.bundle)),
      recipient_key: bytesToHex(fpOf(myBundle())),
      handshake: 'EKK1H:' + b64uEncode(hs.wire),
    });
    const noah = (await call({ type: 'contacts' })).contacts!.find((c) => c.label === '@noah')!;
    await call({ type: 'bindThread', threadId: 'ig:noah-dm', fingerprint: noah.fingerprint });

    const res = await call({ type: 'encrypt', threadId: 'ig:noah-dm', plaintext: 'no setup in the chat' });
    expect(res.tokens).toHaveLength(1); // one EKK1M — the setup came through the account mid-send
    expect(openMessage(hs.session as Session, decodeBody(res.tokens![0]!))).toBe('no setup in the chat');
  });
});

describe('mailbox sessions survive the vault lifecycle', () => {
  it('lock/unlock does not quarantine a thread-less account session', async () => {
    // The legacy migration treats an unmarked thread-less session as a pre-scoping artifact
    // and quarantines it. Account sessions are thread-less BY DESIGN — unlock must not eat
    // the channel, or "waiting for the secure channel" comes back after every restart.
    await call({ type: 'lock' });
    const back = await call({ type: 'unlock', passphrase: VAULT_PASS });
    expect(back.error).toBeUndefined();

    const again = formatMessage(sealMessage(ritaSession!, 'still here after a restart'));
    const res = await call({ type: 'ingest', kind: 'message', raw: again, threadId: 'ig:rita-dm' });
    expect(res.plaintext).toBe('still here after a restart');
  });
});
