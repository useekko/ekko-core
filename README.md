<p align="center">
  <img src="assets/logo.png" width="120" alt="Ekko" />
</p>

<h1 align="center">Ekko</h1>
<p align="center"><i>Say it like no one is listening.</i></p>

Ekko is a privacy platform: one private identity for every app you already use.
Messages seal themselves on-device with hybrid post-quantum encryption
(X25519 + ML-KEM-768) and travel through the apps you and the people you talk to
already have open. No new messenger, and nobody to talk into switching.

**The code is not here yet.** It is being built in private, and this repo is where the
open-source release lands. What follows is what is being built, so you know what is coming.

## What this repo will hold

**The browser extension.** It sits in the page, seals what you type before it is sent, and
opens what comes back. Instagram, WhatsApp Web, Telegram Web and Messenger. Chrome first.

**The protocol.** The wire format and the crypto: a hybrid post-quantum handshake
(X25519 + ML-KEM-768) with an authenticated stream cipher, keys generated and kept on your
own device, and a 24-word recovery phrase that is the only way back in. Safety numbers let
you verify you are talking to the person, not to the platform.

**The directory server.** It maps @handles to *public* keys so people can find each other.
It never holds a private key or a message. It is optional: stay anonymous and trade invites
by hand, or run your own.

## What lands with it

- **Open source.** Extension, protocol, and directory server.
- **Self-hosting.** Run your own directory. No dependency on us.
- **Reproducible builds.** Compile your own binaries and verify what is running.

## Status

Private alpha. A small group is testing the extension. Not in the Chrome Web Store yet;
early access goes through the site.

The iPhone half lives in [**ekko-ios**](https://github.com/useekko/ekko-ios): the app, the
keyboard, and the Safari extension. Same identity, same recovery phrase, same protocol.

## Links

- Site: [useekko.app](https://useekko.app)
- X: [@useekko](https://x.com/useekko)
- Discord: [discord.gg/cQytJjVdxu](https://discord.gg/cQytJjVdxu)
- Contact: [kirill@useekko.app](mailto:kirill@useekko.app)

---

This repo fills in as things open up.
