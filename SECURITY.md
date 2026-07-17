# Security policy

Ekko's whole point is that its security claims hold. If you found a way they don't, we
want to know more than we want almost anything else.

## Reporting a vulnerability

**Do not open a public issue.** Email **kirill@useekko.app** with:

- what you found and where (extension, iOS app, keyboard, directory server, site);
- steps or a proof of concept if you have one;
- how you'd like to be credited, if at all.

You'll get a human reply within 72 hours. Please give us a reasonable window to ship a
fix before disclosing publicly — we'll keep you in the loop on progress and coordinate
timing with you.

## Scope

- The browser extension (`src/`) — crypto core, adapters, popup, background.
- The iOS app and keyboard (`ios/`).
- The directory server (`server/`).
- The protocol (`docs/PROTOCOL.md`) and threat model (`docs/THREAT_MODEL.md`) — flaws in
  what we claim, not just in what we run.

Out of scope: the messengers Ekko rides through (report Instagram bugs to Meta), and
issues that require a compromised device (already conceded in the threat model).

## What we promise back

No legal threats for good-faith research. Fast fixes, honest changelogs, and credit if
you want it. Read `docs/THREAT_MODEL.md` first — it says plainly what Ekko does not
protect against, and a report that starts there lands better.
