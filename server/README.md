# Ekko Directory

A lean discovery service for [Ekko](https://useekko.app): it publishes people's **public**
key bundles, optional `@username` claims, and opt-in platform-handle mappings so short
invites (`/u/alice`) and automatic key matching become possible. It holds **nothing
secret** — no private keys, no message content, no passwords. Losing the server loses
discovery, never confidentiality.

Design rationale and the trust model are in [`../docs/DIRECTORY.md`](../docs/DIRECTORY.md).

## Security posture

- The v1 `/keys` publisher is **unauthenticated trust-on-first-use** (legacy, kept for old
  clients). V2 writes prove control of an Ekko key via an X25519 challenge-response.
- Device-key proof is not provider-account proof. A platform mapping starts as an
  unverified reservation; **only the ownership verifier sets `verified_at`** — the user
  sends a one-time code to the Ekko bot *from the account being claimed*, and the sender
  identity asserted by the platform becomes the mapping. Telegram is live; other platforms
  can be attested by the operator until their verifiers exist.
- Clients refuse automatic suggestions unless a lookup explicitly returns `verified:true`.
- The directory is discovery, never a root of trust: bindings pin on-device, key changes
  alarm, and the peer-to-peer QR/invite path works with no server at all.

## Stack

Node built-in `http` + `node:sqlite` + `node:crypto`. **Zero npm dependencies** — nothing
to install or compile. Node 24+ (for stable `node:sqlite`).

## Self-host

```bash
cd server
npm test            # 27 tests, zero deps
node src/index.mjs  # → http://127.0.0.1:8787 (DB at ./data/directory.db)
```

Or Docker:

```bash
docker volume create resonance-data   # compose pins an external volume so it can never
                                      # be swept by `compose down -v`
docker compose up -d --build
```

Environment (all optional):

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | listen port |
| `HOST` | `127.0.0.1` | bind address — keep it loopback and let your TLS proxy front it |
| `DB_PATH` | `./data/directory.db` | SQLite file (WAL mode) |
| `ADMIN_TOKEN` | unset | enables `/admin/*` operator attestation; unset = those routes do not exist |
| `TELEGRAM_BOT_TOKEN` | unset | enables Telegram ownership verification; unset = `/verify/start` answers 503 for telegram |

Put a TLS terminator in front (the client refuses plaintext directories);
[`deploy/nginx-directory.conf`](deploy/nginx-directory.conf) is a working vhost template —
note it proxies only explicit API paths and deliberately does **not** proxy `/admin/`,
which should stay reachable only from the box itself. If the proxy is behind Cloudflare,
keep the `set_real_ip_from` block so rate limits see visitor IPs, not edge POPs.

**Volume ownership trap**: the container runs as the unprivileged `app` user (uid 100),
but a volume created/written by root shadows the image's `chown`. If boot fails with
`attempt to write a readonly database`, re-own the data once:
`docker run --rm -v resonance-data:/data alpine chown -R 100:101 /data`

## Platform ownership verification

The only path that marks a mapping `verified:true`:

1. Create a bot with [@BotFather](https://t.me/BotFather), set `TELEGRAM_BOT_TOKEN`,
   restart. The server long-polls the Bot API — no webhook, no public URL needed. The log
   line `verify: telegram` confirms it.
2. A client calls `POST /verify/start` (authenticated) and shows the user a one-time code
   plus your bot's address.
3. The user sends the code to the bot **from the Telegram account they are claiming**.
   The sender's `@username` — asserted by Telegram, not typed by anyone — becomes the
   verified mapping. Codes are single-use and expire after 15 minutes.

A fresh platform-asserted proof always wins: it displaces an unverified squatter of the
same handle and retires the prover's stale mappings for that platform (verification is
proof of *current* control).

Platforms without a live verifier can be attested manually by the operator:

```bash
# from the host the server runs on (never exposed through the proxy)
curl -s -X POST 127.0.0.1:8787/admin/verify \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"username":"alice","platform":"instagram","handle":"alice_ig"}'

curl -s -X POST 127.0.0.1:8787/admin/unlink \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"platform":"instagram","handle":"alice_ig"}'
```

Only attest what you have actually checked out of band — this write is exactly as strong
as your process.

## API

v1 (legacy, unauthenticated):

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/health` | — | `{ ok: true }` |
| POST | `/keys` | `{ invite, username? }` | `{ fingerprint, username, verified:false }` · 409 taken · 400 invalid |
| GET | `/u/:username` | — | `{ username, invite, ... }` · 404 |
| GET | `/keys/:fingerprint` | — | `{ fingerprint, invite, ... }` · 404 |
| GET | `/lookup` | `?username=` or `?fingerprint=` | same as above |

v2 (authenticated by X25519 challenge-response — `POST /auth/challenge` first, then spend
the one-time `{ challengeId, proof }` pair):

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/auth/challenge` | `{ invite }` | one-time `{ challengeId, challenge }` · 503 at the bounded ceiling |
| POST | `/u/claim` | `{ challengeId, proof, username, recovery }` | authenticated account + first device claim |
| POST | `/handles/link` | `{ challengeId, proof, platform, handle }` | reserves a mapping, hashed before storage · 409 taken |
| POST | `/handles/unlink` | `{ challengeId, proof, platform }` | removes the caller's own mapping(s) · idempotent |
| POST | `/recover` | `{ challengeId, proof, newBundle? }` | returns the owned username, or rotates the device key keeping it |
| POST | `/verify/start` | `{ challengeId, proof, platform }` | `{ code, checkId, expiresAt, bot }` · 503 `verify-unavailable` |
| GET | `/verify/check` | `?id=<checkId>` | `{ status: pending\|verified, platform, handle? }` — the platform-asserted handle is returned exactly once · 404 |
| GET | `/lookup` | `?platform=&handle_hash=` | `{ invite, verified }` · 404; raw `handle` queries are rejected |

Operator (bearer `ADMIN_TOKEN`; the whole namespace is 404 when the token is unset):

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/admin/verify` | `{ username, platform, handle }` | attests a mapping for the account owning that Ekko @username |
| POST | `/admin/unlink` | `{ platform, handle }` | removes a mapping whoever owns it |

`invite` is the `EKK1I:…` public bundle from the client (1217 bytes: version ‖ X25519 ‖
ML-KEM-768). The server validates shape and derives the fingerprint; it never sees private
material. Platform handles are stored as `sha256(platform:canonical_handle)` — plaintext
handles are not at rest (the one exception: a just-verified handle is parked until its
owner's single `/verify/check` fetch, minutes at most).

## Client integration

The extension claims usernames, adds contacts by handle, reserves and verifies platform
mappings, restores phrase-derived identities, and performs on-device-hashed peer lookups.
Automatic suggestions are opt-in (default off), persist nothing, and accept only
ownership-verified mappings. The QR/invite path keeps working with no server; the
directory is purely additive.
