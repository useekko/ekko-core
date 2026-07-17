<!-- One concern per PR. Say why, not just what. -->

## What & why

## Checklist

- [ ] `npm test` and `npm run typecheck` are green (`cd server && npm test` too if `server/` changed)
- [ ] No new dependency — or the PR description says why a few lines of code can't do the job
- [ ] Touched `src/core`? Wire/crypto changes update `docs/PROTOCOL.md` and the ekko-ios interop vectors in the same change
- [ ] Touched an adapter? The selector fix comes with a DOM fixture in `test/` that failed before it, and the adapter still fails visible — it never guesses a recipient
- [ ] UI copy states limits plainly — no "military-grade", no "unbreakable"
