<div align="center">

<img src="assets/logo.png" width="120" alt="Ekko" />

# Ekko

**Post-quantum encrypted messaging inside the apps people already use.**

[![CI](https://github.com/useekko/ekko-core/actions/workflows/ci.yml/badge.svg)](https://github.com/useekko/ekko-core/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/useekko/ekko-core?include_prereleases&label=release)](https://github.com/useekko/ekko-core/releases)
[![Downloads](https://img.shields.io/github/downloads/useekko/ekko-core/total)](https://github.com/useekko/ekko-core/releases)
[![Client License](https://img.shields.io/badge/client-GPL--3.0-blue)](LICENSE)
[![Server License](https://img.shields.io/badge/server-AGPL--3.0-blue)](server/LICENSE)

[Website](https://useekko.app) · [iOS repo](https://github.com/useekko/ekko-ios) · [Adapters](docs/ADAPTERS.md) · [Directory](docs/DIRECTORY.md) · [Threat model](docs/THREAT_MODEL.md) · [Security](SECURITY.md) · [Discord](https://discord.gg/cQytJjVdxu)

</div>

---

No new app to convince your friends to install. Ekko rides on top of Instagram, WhatsApp,
Telegram, and Messenger, seals the message on your device with hybrid X25519 + ML-KEM-768,
and hands the messenger ciphertext it cannot read.

This repo is the heart of it: the browser extension, the protocol, and the key directory
server you can self-host. The iPhone half — the app, the keyboard, the Safari extension —
lives in [**ekko-ios**](https://github.com/useekko/ekko-ios). Same identity, same recovery
phrase, same protocol: a message sealed in Chrome opens on the phone, and the reverse.

> **The one line to remember:** your private keys never leave your device. The directory
> only ever sees public keys. Everything in here is built to keep that true — if a change
> would break it, the change is wrong, however nice it looks.

## Status: public alpha

This is software being built in public. It works — we use it every day — and it has bugs,
rough edges, and adapters that a messenger's next deploy can break. That's what an alpha
is. File what you find, tell us what's confusing, and watch it get fixed in the open.

- **Chrome Web Store:** developer account approved, first version submitted for review.
  The store link lands here and on [useekko.app](https://useekko.app) the moment Google
  says yes. Until then, install from a release or build from source — two minutes either way.
- **Firefox:** an experimental zip ships with every nightly. It needs testers.
- **Safari (macOS):** works via `scripts/mac-safari.sh` (builds a signed container app).
- **iOS:** built and working; TestFlight is the next step over in
  [ekko-ios](https://github.com/useekko/ekko-ios).

The core of Ekko is free and stays free. Encrypting your own messages will never be a
paid feature. And there is no telemetry in the product: we count release downloads and
newsletter signups, not you. Every network request the extension makes is in this repo.

## Install

**From a release** ([latest](https://github.com/useekko/ekko-core/releases), or the
rolling `nightly` prerelease built from `main` every day):

1. Download `ekko-<version>-chromium.zip` and unzip it.
2. `chrome://extensions` → Developer mode → *Load unpacked* → pick the unzipped folder.
3. Same zip works on Edge, Brave, Opera, Arc — any Chromium browser.

**From source (about ten minutes):**

```bash
npm install
npm test          # the whole suite, ~10s
npm run typecheck
npm run build     # -> dist/, load unpacked as above
```

**Safari on macOS** — Safari can't load an unpacked extension; it needs a signed
container app:

```bash
scripts/mac-safari.sh
```

Then Safari → *Develop → Allow Unsigned Extensions* (resets every time Safari quits —
that's Safari, not us), and *Settings → Extensions → Ekko*.

**Self-hosting the directory** — no dependency on us is a feature, not a slogan:

```bash
cd server && npm test && node src/index.mjs     # or: docker compose up -d --build
```

Full guide — TLS, env vars, platform ownership verification via your own Telegram bot —
in [`server/README.md`](server/README.md). Point the extension at your instance under
*Settings → Advanced → directory server* (https only). The QR/invite path needs no
server at all.

## Why this exists

In May 2026, Meta shut down Instagram's optional end-to-end encrypted DMs. In Europe,
lawmakers are back to pushing measures that would let providers scan private messages,
under the broader "Chat Control" push that's still being negotiated. Different rooms,
same lesson: privacy that a platform grants, a platform can take away.

Most messengers can promise privacy. Almost none make it structural. Even where the
crypto holds, the platform still controls the client, the recovery flow, and often the
keys — which means it can still hand over plaintext to a breach, a legal demand, or a
training pipeline. A setting is not a guarantee.

Ekko is one layer above that problem: encrypt on-device, before the message ever reaches
the platform's client, using cryptography built for a world with quantum computers in it.
PGP had the right idea thirty years ago and lost on usability. This is that idea again,
built so your friends can actually use it.

## What's in here

| | |
|---|---|
| `src/` | The browser extension (Chrome MV3, TypeScript). Also **the Safari extension** — same build. |
| `src/core/` | The crypto and the wire format. Zero DOM, zero browser APIs, fully unit-tested. |
| `src/content/` | One adapter per messenger. **This is where the DOM lives.** |
| `server/` | The key directory: Node, **zero dependencies**, SQLite, Docker. Self-host it. |
| `test/` | The suite runs in ~10 seconds. Run it. |
| `docs/` | Read `ADAPTERS.md`, `DIRECTORY.md`, and `DESIGN.md` first. |

## The five things that will save you a day each

1. **Adapters fail VISIBLE, never silent.** If an adapter can't work out who you're
   talking to, the composer glyph shows a muted "identifying this chat" state. It must
   never quietly do nothing, and it must **never** guess a recipient. Encrypting to the
   wrong person is the worst bug this codebase can have.

2. **`src/core` is sacred and shared.** The Swift port in ekko-ios must stay
   byte-compatible with it. The committed interop vectors over there are generated from
   this repo's TypeScript; a crypto change updates both sides or it doesn't land.

3. **Safari rejects `"type": "module"` service workers** outright — the extension would
   load with no background at all, meaning no keys and no decryption.
   `scripts/ios-safari-sync.mjs` rebuilds the background as an IIFE. Don't undo that.

4. **Verification is server state, never a client guess.** If the UI says "verified",
   something authoritative said so. On the server there's exactly ONE code path that sets
   `verified_at` (`verifyPlatformHandle`), fed by the bot ceremony or operator
   attestation — keep it that way.

5. **The directory is discovery, never a root of trust.** Bindings pin on-device, key
   changes alarm, and an unverified mapping never becomes an automatic suggestion.
   `docs/DIRECTORY.md` is the trust model; `docs/THREAT_MODEL.md` says plainly what Ekko
   does not protect against.

## Design

Read `docs/DESIGN.md` before you write UI. Short version: one accent colour, used
scarcely. Serif for headlines, Inter for interface, **monospace for machine output
only** (ciphertext, security codes, the 24 words — never a label). No emoji in UI.
No overclaiming in copy — never "unbreakable," never "military-grade." The strongest
statement on a screen is a demonstration, not an adjective.

## The bigger picture

Ekko (Project Echo) is the layer that ships now, on top of the networks people already
use. It's the first of three, built by [Ekko Privacy Lab](https://useekko.app/about):
Project Sonar is protocol research into metadata-private infrastructure, and Project
Aster looks at the physical layer — secure radio, satellite, and embedded links for the
next generation of devices and agents. Different altitudes, same premise: the keys
should stay with the person, not the platform.

## Contributing, feedback & security

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md), or grab a
[good first issue](https://github.com/useekko/ekko-core/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).
Ideas, questions, and "this confused me" belong in
[Discussions](https://github.com/useekko/ekko-core/discussions) or the
[Discord](https://discord.gg/cQytJjVdxu) — while we build in public, feedback IS the roadmap.
The [newsletter](https://useekko.app/#get) is the low-noise way to follow along.

Found a vulnerability? **Don't open an issue** — see [`SECURITY.md`](SECURITY.md).

Tests and typecheck must be green. Any change that touches crypto, key handling, or an
adapter's choice of recipient gets read twice.

## License

Client code: **GPL-3.0** ([`LICENSE`](LICENSE)). Directory server (`server/`):
**AGPL-3.0** ([`server/LICENSE`](server/LICENSE)).

---

<div align="center">

Because convenience was never meant to sacrifice privacy.

[useekko.app](https://useekko.app) · [x.com/useekko](https://x.com/useekko) · [Discord](https://discord.gg/cQytJjVdxu)

</div>
