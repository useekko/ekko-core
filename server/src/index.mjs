import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openStore } from './store.mjs';
import { createApp } from './app.mjs';
import { makeVerifier } from './verify.mjs';
import { startTelegramPoller } from './telegram.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1'; // bind localhost; nginx terminates TLS and proxies in
const DB_PATH = process.env.DB_PATH ?? './data/directory.db';
// Optional features — each is OFF until its env var exists, so a bare `node src/index.mjs`
// still runs the whole core directory:
//   ADMIN_TOKEN         enables /admin/* attestation (keep it off the public proxy).
//   TELEGRAM_BOT_TOKEN  enables Telegram ownership verification (@BotFather token).
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || undefined;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || undefined;

mkdirSync(dirname(DB_PATH), { recursive: true });
const store = openStore(DB_PATH);
const verifier = makeVerifier(store);
const poller = TELEGRAM_BOT_TOKEN ? startTelegramPoller({ token: TELEGRAM_BOT_TOKEN, verifier }) : null;
const server = http.createServer(createApp(store, { verifier, adminToken: ADMIN_TOKEN }));

server.listen(PORT, HOST, () =>
  console.log(
    `ekko-directory listening on ${HOST}:${PORT} (db: ${DB_PATH}, verify: ${TELEGRAM_BOT_TOKEN ? 'telegram' : 'off'}, admin: ${ADMIN_TOKEN ? 'on' : 'off'})`,
  ),
);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    poller?.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
