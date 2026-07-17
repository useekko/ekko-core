# Contributing to Ekko

Thanks for looking. Ekko is post-quantum encrypted messaging that travels through the
apps people already use — a browser extension, an iOS app, and a small key directory.
The code is split the way big orgs split it:
[**ekko-core**](https://github.com/useekko/ekko-core) holds the extension, the protocol,
and the directory server; [**ekko-ios**](https://github.com/useekko/ekko-ios) holds the
iOS app, the keyboard, and the Safari extension. Contributions of every size are
welcome: adapter fixes when a messenger changes its DOM, new platform adapters, iOS
work, tests, docs. Ideas and questions go in each repo's Discussions.

## Ground rules

- **Be suspicious of dependencies.** The extension's crypto is `@noble/*` and that is
  basically it; the server has **zero** npm dependencies, deliberately. A PR that adds a
  dependency needs to say why a few lines of code can't do the job.
- **Crypto changes need vectors.** `src/core` (ekko-core) and `ios/EkkoCore` (ekko-ios)
  must stay byte-compatible: the committed `vectors.json` in the Swift tests is
  generated from the real TypeScript core, and the cross-language interop gate runs in
  the maintainers' combined tree before merges land. Never hand-roll primitives; wire
  format changes need a `docs/PROTOCOL.md` update in the same PR.
- **Fail visible, never guess.** Adapters must not silently guess a chat is direct or a
  peer's identity — see the contract in `docs/ADAPTERS.md`. A wrong guess encrypts to
  the wrong person; an honest "identifying this chat" state does not.
- **Say what the software can't do.** UI copy and docs state limits plainly
  (`docs/THREAT_MODEL.md` is the tone reference). No "military-grade", no
  "unbreakable".

## Getting started

```bash
npm install
npm test              # vitest suite
npm run typecheck
npm run build         # extension → dist/ (load unpacked in Chrome)
```

iOS lives in [ekko-ios](https://github.com/useekko/ekko-ios) (Xcode, iOS 26+; see
`docs/IOS.md` there for the three targets and the signing traps). The directory server
lives in ekko-core's `server/` (`cd server && npm test`, zero deps — see
`server/README.md` to self-host it).

## Working on adapters

Each messenger has one adapter in `src/content/` implementing `SiteAdapter`. The
selector provenance, live-tuning diagnostics (the `rsn.debug` overlay), and a
how-to-add-a-platform guide are in `docs/ADAPTERS.md`. DOM fixtures for peer/composer
detection live in `test/` — a selector fix should come with a fixture that failed
before it.

## Pull requests

- One concern per PR; tests for behavior you add or fix.
- `npm test && npm run typecheck` must pass; keep the diff shaped like the code around
  it.
- Commit messages say why, not just what.

## Security issues

Never open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md).

## License

The client code (extension, iOS) is GPL-3.0; the directory server (`server/`) is
AGPL-3.0. By contributing you agree your work is licensed the same way.
