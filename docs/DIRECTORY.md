# Ekko Directory

The directory is an **optional convenience layer over the peer-to-peer core, never a
replacement**. Users who never register keep working through QR and long invites. The
directory stores public material only and cannot decrypt messages.

## Deployment status

- **Production:** v2 (authenticated accounts, recovery, platform mappings, hashed lookups)
  is live at `useekko.app` since 2026-07-11, with the legacy v1 TOFU routes alongside it.
- **Ownership verification is built** (2026-07-16): a one-time code sent to the Ekko bot
  from the claimed platform account, Telegram first (see "Platform ownership
  verification"). Platforms without a live bot can be attested by the operator over the
  admin surface. The client still refuses every automatic directory offer unless the
  response is explicitly `verified:true` — that invariant is what verification feeds.
- **Self-hosting is supported**: the server is AGPL-3.0 and `server/README.md` is the
  runbook. A self-hosted directory gets the same verification by pointing a BotFather
  token at it.

## Hard invariant

**Private keys and recovery words are generated on-device and never transmitted.** The server
stores public identity bundles, a public recovery bundle, and public mapping metadata. Losing
the server loses discovery, not confidentiality.

## Current data model

The legacy `keys` and `usernames` tables continue serving v1. V2 adds:

```
users(id, username, recovery_fp, recovery_bundle, created_at)
devices(id, user_id, bundle, added_at, revoked_at)
platform_handles(handle_hash, user_id, platform, verified_at, created_at)
key_log(seq, user_id, bundle_hash, prev_hash, created_at)
```

`platform_handles.handle_hash` is `sha256(platform:canonical_handle)`; plaintext platform
handles are not stored. `verified_at` is set exclusively by the ownership verifier (bot or
operator attestation — one write path, `verifyPlatformHandle`). A `verification_codes`
table holds hashed one-time codes for the ceremony; a just-verified plaintext handle is
parked there only until its owner's single `/verify/check` fetch. `key_log` is populated
on create and recovery, but clients do not yet request or audit proofs.

An Ekko `@username` is independent of a provider account. It shortens public-key exchange but
does not prove a real-world identity or prevent a first claimant from squatting a name.

## HTTP API

The production v1 surface is:

```
GET  /health
POST /keys                         { invite, username? }
GET  /u/:username
GET  /keys/:fingerprint
GET  /lookup?username=...          (or ?fingerprint=...)
POST /bug                          public site feedback sink
POST /waitlist                     legacy, unused by the current site
```

The v2 surface (live) adds:

```
POST /auth/challenge               { invite }
POST /u/claim                      { challengeId, proof, username, recovery }
POST /handles/link                 { challengeId, proof, platform, handle }
POST /handles/unlink               { challengeId, proof, platform }
POST /recover                      { challengeId, proof, newBundle? }
POST /verify/start                 { challengeId, proof, platform }
GET  /verify/check?id=...
GET  /lookup?platform=...&handle_hash=...
```

Operator attestation (`POST /admin/verify`, `POST /admin/unlink`) exists behind a bearer
`ADMIN_TOKEN` and is deliberately absent from the public proxy — reachable only from the
host itself.

Without `newBundle`, `/recover` returns the username owned by the proven recovery key and changes
nothing. With `newBundle`, it rotates the active device key while preserving that username.

The X25519 challenge proves possession of the private key corresponding to the supplied public
bundle. It authenticates account creation, platform-map reservation, and recovery-key use. It
does **not** prove ownership of a provider account. The `/handles/link` request carries the raw
canonical handle inside TLS; the server hashes it before SQLite. Lookup requests hash on-device,
so the raw peer handle does not enter the request URL.

## Platform ownership verification

Publishing "I own Instagram @alice" without proof would make automatic discovery an
impersonation tool, so an unverified mapping never becomes an automatic offer:

- first-claim-wins prevents silent overwrites but does not establish ownership;
- `/lookup` reports those rows as `verified:false`;
- the extension returns `unverified-handle` and creates no offer, contact, or thread binding.

### The verifier: inbound one-time code to an Ekko bot (built 2026-07-16, Telegram first)

It exploits the same fact the client adapters rely on: **an inbound message carries the
sender's real platform identifier** (the phone, Facebook user id, Telegram username),
asserted by the platform itself — strictly stronger than the client hashing its own claim.

Flow (implemented in `server/src/verify.mjs` + `server/src/telegram.mjs`):

1. The client calls `POST /verify/start` (device-key authenticated) → the directory issues
   a short-lived one-time code (`EKKO-XXXXXX`, hashed at rest, 15-minute TTL, one active
   code per user+platform) plus a capability `checkId` and the bot's address.
2. The user messages the code to the Ekko bot **from the account they are claiming** (for
   Telegram, the `t.me/<bot>?start=<code>` deep link pre-fills it).
3. The bot consumer reads the sender's platform identifier from the message metadata,
   canonicalizes it exactly like the client (`canonHandle`), and writes
   `platform_handles(handle_hash, user_id, verified_at = now)` through
   `verifyPlatformHandle` — the only code path that sets `verified_at`. Telegram uses
   long-polling, so a self-hosted directory needs only a BotFather token, no webhook.
4. The client polls `GET /verify/check?id=`; the confirming answer carries the
   platform-asserted plaintext handle exactly once so the vault can heal what the user
   originally typed. `POST /handles/unlink` (same key proof as link) revokes a mapping.

Transfer semantics: a fresh platform-asserted proof **always wins** — it displaces an
unverified squatter and even an earlier verified owner (verification proves *current*
control; think phone-number reassignment), and it retires the prover's stale mappings for
the same platform so a renamed account leaves no verified ghost.

A sender with no public @username cannot be mapped; the bot says so instead of guessing.
Platforms without a bot yet (Instagram, WhatsApp, Messenger — they need Meta business
accounts and app review) are covered by operator attestation (`/admin/verify`), which uses
the same single write path. Only attest what was checked out of band.

## Trust: the directory is not a root of trust

A malicious or compelled directory could serve the wrong public key. Ekko keeps the final trust
decision on-device:

- **The key is shown before it is trusted.** Adding by handle previews the pairwise
  security code that identifies the key being adopted (the extension's verify-by-ritual
  ceremony was removed 2026-07-15 — nobody performed it — but the preview and the
  structural guards below stayed).
- **No silent binding.** A successful lookup is only a glyph offer. The user's explicit tap adds
  the contact and binds the open direct thread.
- **Existing bindings stay pinned.** A different key cannot silently replace the key already
  linked to a conversation; the client surfaces a key-change conflict.
- **Transparency is incomplete.** The server writes a hash chain, but inclusion and consistency
  proofs are future work and must not be claimed as protection yet.

## Privacy cost

Registering a username or platform mapping reveals Ekko membership and links public metadata on
the server. A user can remain QR/invite-only forever.

Automatic suggestions add query metadata. The setting is opt-in and defaults off; enabling it
requires an unlocked vault with a claimed Ekko username. When an unlinked direct chat has no
unique local match, the adapter supplies a provider account identifier, and the background sends
`platform` plus `sha256(platform:canonical_handle)` over TLS. A deterministic hash is not
anonymity: the directory can guess common handles and can correlate repeated hashes and client
IP addresses. The application does not log lookups, and nginx restores the visitor IP for rate
limiting behind Cloudflare.

The content controller collapses concurrent requests and caches stable results only in a bounded
recent-thread window. A tab reload or cache eviction can repeat a lookup. Transient network errors
are retried later. A response is never persisted by resolution itself.

## Next build order

1. Per-platform verifier bots beyond Telegram (WhatsApp Business API, Meta messaging for
   IG/Messenger) once the business accounts exist; operator attestation covers the gap.
2. Surface verification inside the iOS app (the extension has the ceremony UI today).
3. Design and audit usable key-transparency proofs before exposing transparency claims.

---

# Mobile — hardware/OS-level feasibility

The extension approach (inject into a web DOM) doesn't exist on phones, where people actually DM. The two platforms are very different:

**Android — feasible, via an Accessibility overlay.** This is exactly how [Oversec](https://oversec.io) worked: an Accessibility Service reads the on-screen text of *any* app (Instagram, WhatsApp, Signal) and draws an overlay, and a custom input method injects the encrypted text on send. Same crypto core, same directory. It's invasive (Accessibility permission is powerful and scary to grant) and fragile per-app, but it genuinely delivers the "encrypt inside their app" experience Ekko is after. **This is the real mobile bet.**

**iOS — much more locked.** No app can read or overlay another app's UI (no equivalent of Accessibility overlays). The realistic decomposition:
- **Encrypt:** a **custom keyboard extension** — you switch to the Ekko keyboard, type, and it inserts ciphertext into whatever app you're in.
- **Decrypt:** a **Share Extension / copy-paste** — select the ciphertext, Share → Ekko, read the plaintext in a sheet. No true in-place decrypt overlay is possible.
- iOS is therefore a worse experience (manual keyboard switch, tap-to-decrypt) but still shippable. Full in-app auto-decrypt like the extension is not achievable within Apple's sandbox.

Both mobile apps reuse the crypto core and the directory unchanged; only the "adapter" layer (how you read/write the host app's text) is platform-specific — the same architecture that already lets one `SiteAdapter` per website. The directory matters even more on mobile, where pasting a 1,600-char invite is painful.
