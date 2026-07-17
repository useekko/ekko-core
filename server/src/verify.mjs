// Platform ownership verification — the only path that sets verified_at (docs/DIRECTORY.md
// "planned verifier", now built). The model: the directory issues a short-lived one-time
// code; the user sends it to the Ekko bot FROM the platform account they are claiming; the
// inbound message metadata carries the sender's real platform identifier, asserted by the
// platform itself — strictly stronger than trusting a client-supplied handle.
//
// This module is transport-free: the Telegram poller (telegram.mjs) and the tests both feed
// consumeInbound() directly. Adding a platform = adding a webhook/poller that calls it.
import { randomBytes, createHash } from 'node:crypto';
import { handleHash } from './crypto.mjs';

const CODE_TTL_MS = 15 * 60_000;
// No 0/O/1/I/L: these codes get retyped on phones.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_RE = /EKKO-([A-HJ-KM-NP-Z2-9]{6})/i;

const hashCode = (code) => createHash('sha256').update(code.toUpperCase()).digest('hex');

export function makeVerifier(store, opts = {}) {
  const ttl = opts.codeTtlMs ?? CODE_TTL_MS;
  // platform -> public bot address (e.g. telegram bot @username), set once its poller is up.
  const bots = new Map();

  return {
    setBot: (platform, username) => bots.set(platform, username),
    supports: (platform) => bots.has(platform),
    botUsername: (platform) => bots.get(platform),

    // Issue a one-time code for an authenticated account. Returns what the client needs to
    // run the ceremony: the code to send, a capability id to poll, and where to send it.
    issue(userId, platform, now = Date.now()) {
      let code = 'EKKO-';
      for (const b of randomBytes(6)) code += ALPHABET[b % ALPHABET.length];
      const checkId = randomBytes(16).toString('hex');
      const expiresAt = now + ttl;
      store.issueCode(userId, platform, hashCode(code), checkId, expiresAt, now);
      return { code, checkId, expiresAt };
    },

    // The poller saw an inbound message. senderHandle is the platform-asserted identifier of
    // whoever sent it (canonicalized lowercase); text is the message body. Returns a status
    // the poller can turn into a human reply.
    consumeInbound(platform, senderHandle, text, now = Date.now()) {
      const m = String(text ?? '').match(CODE_RE);
      if (!m) return { status: 'no-code' };
      const handle = String(senderHandle ?? '').trim().replace(/^@/, '').toLowerCase();
      if (!handle) return { status: 'no-handle' };
      const row = store.codeByHash(hashCode(m[0]));
      if (!row || row.platform !== platform || row.consumed_at || now > row.expires_at) return { status: 'bad-code' };
      if (!store.consumeCode(row.code_hash, handle, now)) return { status: 'bad-code' };
      store.verifyPlatformHandle(row.user_id, platform, handleHash(platform, handle), now);
      return { status: 'verified', handle };
    },

    // The client polls with the capability id from issue(). The plaintext handle the bot
    // observed is returned exactly once so the client can heal its local copy (the vault
    // stores what the user typed, which may differ from what the platform asserted).
    check(checkId, now = Date.now()) {
      const row = store.codeByCheckId(String(checkId ?? ''));
      if (!row) return null;
      if (row.consumed_at) {
        if (row.verified_handle) store.clearCheckHandle(String(checkId));
        return { status: 'verified', platform: row.platform, handle: row.verified_handle ?? undefined };
      }
      if (now > row.expires_at) return null;
      return { status: 'pending', platform: row.platform };
    },
  };
}
