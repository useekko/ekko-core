// Telegram is the first live ownership verifier: the Bot API is free, instant to set up
// (@BotFather), and long-polling means a self-hosted directory needs NO public webhook —
// the token in an env var is the whole integration. The poller reads inbound messages,
// hands them to the verifier core, and replies with the outcome.
//
// The sender's identity comes from message.from.username — asserted by Telegram, which is
// exactly what the client adapters use for telegram lookups (the peer's @username). A
// sender with no public @username cannot be mapped; the bot says so instead of guessing.

const REPLY = {
  verified: (h) => `Verified. @${h} is now linked to your Ekko identity — you can close this chat.`,
  'no-handle':
    'Your Telegram account has no public @username, so there is nothing to verify. Add one in Telegram Settings → Username, then send the code again.',
  'bad-code': 'That code is not valid anymore. Open Ekko and start verification again to get a fresh one.',
  'no-code': 'Send the verification code shown in Ekko (it looks like EKKO-XXXXXX).',
};

export function startTelegramPoller({ token, verifier, fetchImpl = fetch, log = (m) => console.error(m) }) {
  const api = `https://api.telegram.org/bot${token}`;
  let stopped = false;
  let offset = 0;

  const call = async (method, params, timeoutMs = 65_000) => {
    const r = await fetchImpl(`${api}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await r.json();
    if (!body.ok) throw Object.assign(new Error(`telegram ${method}: ${body.description ?? r.status}`), { code: body.error_code });
    return body.result;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const loop = (async () => {
    // getMe first: the bot's @username is what /verify/start hands to clients as the send
    // target. Until it succeeds the verifier reports telegram as unsupported — fail closed.
    while (!stopped) {
      try {
        const me = await call('getMe', {}, 15_000);
        verifier.setBot('telegram', String(me.username));
        log(`telegram verifier ready: @${me.username}`);
        break;
      } catch (e) {
        log(`telegram getMe failed (${e.message}); retrying in 30s`);
        await sleep(30_000);
      }
    }
    while (!stopped) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          const msg = u.message;
          if (!msg?.from || msg.from.is_bot) continue;
          const outcome = verifier.consumeInbound('telegram', msg.from.username, msg.text);
          const reply = outcome.status === 'verified' ? REPLY.verified(outcome.handle) : REPLY[outcome.status];
          if (reply) await call('sendMessage', { chat_id: msg.chat.id, text: reply }, 15_000).catch(() => {});
        }
      } catch (e) {
        // 409 = another process is polling this token (a second replica, or a stale webhook).
        // Both heal by waiting; anything else gets a shorter backoff.
        log(`telegram poll error (${e.message}); backing off`);
        await sleep(e.code === 409 ? 60_000 : 10_000);
      }
    }
  })();

  return {
    stop: () => {
      stopped = true;
      return loop;
    },
  };
}
