# Messenger adapters

Ekko reads and writes each messenger's web UI through a `SiteAdapter` (contract in
`src/content/adapter.ts`). Everything platform-independent — the `Controller`, the composer
glyph, bubble rendering, the bootstrap — is shared (`controller.ts`, `glyph.ts`, `dom.ts`,
`boot.ts`); an adapter supplies only that messenger's selectors and send mechanics. Adding
a messenger is: one file `src/content/<platform>.ts`, one esbuild entry, one `manifest.json`
`content_scripts` block, and one row in the popup's `APPS` list.

## Status

| Platform | id | Content script | Status | Notes |
|---|---|---|---|---|
| Instagram DMs | `instagram` | `instagram.js` | **Active** | www.instagram.com; the original, hand-tuned adapter. **Re-tuned 2026-07-12** — IG dropped the DM `<header>` and `div[role="grid"]` (see provenance) |
| WhatsApp Web | `whatsapp` | `whatsapp.js` | **Beta** | web.whatsapp.com; **re-tuned live 2026-07-12** — detection + encryption work; peer PHONE NUMBER now read from the `model-storage` IndexedDB (permanent id, enables discovery — see provenance) |
| Telegram Web K + A | `telegram` | `telegram.js` | **Beta** | web.telegram.org/k/, /a/, /z/; **WebK verified live 2026-07-12** (detection + manual encryption); peer `@username` + phone now read from Telegram Web's IndexedDB (2026-07-16, needs a live overlay confirm); WebA still needs a live pass |
| Facebook Messenger | `messenger` | `messenger.js` | **Beta** | www.messenger.com; **built + verified live 2026-07-12**. Cleanest identity of all: thread id in the URL AND the peer's global Facebook user id in the DOM |
| X (Twitter) DMs | `x` | — | Not a DOM adapter | Must use the official DM API, not page scripting (see THREAT_MODEL) |

"Beta" = the adapter compiles and slots into the architecture, and its selectors are drawn
from current sources, but the DOM can only be verified against a logged-in session. If the
glyph never appears or messages don't seal, the `SELECTORS` block at the top of the platform
file is the single place to re-patch — run the diagnostic below to see which selector missed.

## Permanent-identity roadmap (the phone-number / global-id problem)

A directory lookup and a durable thread binding both need an identifier that is the SAME on
both sides of the chat — a phone number or a global account id, never a contact-book display
name (your phone's name for someone is not their phone's name for you). Where each adapter
stands on that:

- **Telegram — already permanent, no work needed.** `threadId` is the numeric `data-peer-id`
  (e.g. `5293449953`), which is Telegram's GLOBAL user id: identical for every client, present
  in the DOM, not a contact-book artifact. The visible peer name is cosmetic only. `peerHandle`
  (the `@username` for directory discovery) and the peer's phone are NOT in the chat-header DOM;
  they are read from Telegram Web's own IndexedDB keyed on the peer id (see provenance below), so
  discovery now resolves for any peer with a public username instead of only the rare
  `#@username`-hash case. *Open enhancement*: switching directory discovery to key on the global
  user-id would also cover users with NO public username (needs the claim flow + directory to
  register the user-id too).
- **WhatsApp — BUILT + verified 2026-07-12.** WhatsApp moved to **LID** (a privacy id) and
  removed the phone number from the visible DOM, but it is still on the page in the
  `model-storage` IndexedDB, which the content script reads in-process (same origin, no network,
  no panel-clicking). Verified live schema: contacts are keyed `@lid` with NO phone field and
  `lid-pn-mapping` is empty, BUT each `message` record carries the phone in `from`/`to`
  (`<digits>@c.us`), and its key ends with the exact msgid that is the DOM `data-id`. So the
  adapter maps a visible message's `data-id` → the `message` record (key `endsWith('_'+msgid)`,
  reverse/newest-first scan, capped) → the peer's phone (`fromMe ? to : from`, `@c.us` only).
  That phone (digits) is BOTH the `threadId` (`pn:<digits>`) and the `peerHandle`, so WhatsApp
  auto-discovery now keys on a permanent, mutual number. The read is async → a per-msgid cache
  backs the sync methods; `name:<encoded>` is the fallback until it resolves or if the DB/schema
  is ever absent. Each link proven independently (schema, 32ms lookup, a real live DOM msgid
  found in the store, and the synthetic-DOM adapter integration yielding `whatsapp:pn:<number>`);
  the pure picker `peerPhoneFromMessage` is unit-tested. NOT yet done: the live glyph render
  (needs WhatsApp's UI online, which risks logging out the real linked device).

## Selector provenance & confidence

Both new adapters anchor on stable, semantic hooks (roles, `data-*`, `contenteditable`,
structure) and never on obfuscated/hashed class names.

**Instagram** (verified live against www.instagram.com 2026-07-12, demo1↔demo2):
- The DM view has **no `<header>` and no `div[role="grid"]`** anymore. The old adapter
  anchored peer identity on `main header a[role="link"]` and bubbles on the grid; both
  matched nothing, so `isDirectChat()` was stuck at `null` (glyph frozen on "identifying
  this chat", sends paused) and `peerHandle()` never resolved (no directory lookup ever ran).
  This was the "can't detect the other person's handle / no blob on Instagram" report.
- Peer is read from the conversation top bar's profile anchor: `a[role="link"]` whose href is
  a single path segment (e.g. `/klrusha/`), topmost wins. The href is the account identifier;
  the anchor's first text line is the display name. `aria-label` ("Open the profile page of X")
  is localized — do not parse it.
- **Self/peer are split by the NAV CHROME, not by `<main>` (fixed 2026-07-13, mobile web).** The
  desktop split — self outside `<main>`, peer inside — is a desktop-only geography. On **mobile
  web** (`instagram.com` in iOS Safari) the thread header AND the nav sit outside `<main>`, so the
  old `<main>`-based split made `selfHandle()` grab the PEER as "self"; `peerHeaderLinks()` then
  excluded the real peer, `isDirectChat()` returned `null`, and the glyph was stuck on
  "identifying this chat" forever — the exact iOS-Safari report. The nav (left rail on desktop,
  bottom tab bar on mobile) is now found by STRUCTURE: the container holding the `/explore/` and
  `/reels/` route links. Self is the profile link inside it; the peer is never in it. Verified
  against a real mobile-web DM capture (peer in the top bar at y=16, self `/klrusha/` in the bottom
  tab bar at y=618). Regression-pinned in `test/instagram-peer.test.ts` (desktop + mobile + group +
  non-DM, jsdom with fed geometry). `peerHeaderLinks()` prefers `<main>` (byte-identical desktop)
  and falls back to the whole document with the nav excluded (mobile).
- Bubbles scope to the conversation pane (smallest ancestor of the composer that contains
  the peer link), NOT `<main>` — `<main>` also holds the inbox rail, whose previews are
  `span[dir="auto"]` too. Confidence **medium**: the row-based 1:1-vs-group test wants a real
  group thread to tune.

**WhatsApp** (verified live against web.whatsapp.com 2026-07-12, plus willhackett.com Aug
2025; silham/WhatsApp-Web-AI-Assistant; EyMaddis gist Jan 2025):
- Composer `#main footer div[contenteditable][data-tab="10"]` — **high** (still hits live).
- Bubbles `span.selectable-text` in `#main`, `div.copyable-text[data-pre-plain-text]` — **high**, long-stable.
- Send: the icon was renamed `data-icon="send"` -> `data-icon="wds-ic-send-filled"`; the
  button keeps `aria-label="Send"`. Match aria first, icon as fallback; **click it** — a bare
  synthetic `.click()` verifiably sends (live 2026-07-17); synthetic Enter is `isTrusted:false`
  and ignored — **high**. The send/mic swap signals a clear (an empty box shows the mic).
  The footer re-renders on every empty↔filled swap (our clear+insert triggers two) and can
  REPLACE the composer node mid-send. Rule: before the click, re-resolve and retry the insert
  on a fresh node; after the click, a remount is ambiguous — only the token echoing in an
  outgoing bubble counts as delivered, and never re-click a dead node (duplicate-send guard).
  Same discipline as Instagram's `delivered()`.
- **Composer writes go through the DOM Selection, NOT execCommand clears** (live 2026-07-17):
  the current Lexical build IGNORES `execCommand('selectAll'|'delete')` — seeded junk survived
  both — but honors an insertText/paste that REPLACES a range covering the box, and a synthetic
  `beforeinput` `deleteContentBackward` over that range to empty it. A silently-failed clear was
  the field bug: the token stacked onto the user's draft, the mixed box stopped classifying as
  pure ciphertext, and the controller's own send-capture listener then BLOCKED the send click
  ("could not place / replace"). `place()` also confirms the box holds EXACTLY the token
  (trimmed), not merely `includes`, so a leftover can't ride along. The writer + exact-place
  discipline live in `dom.ts` (`replaceComposerText`/`placeInComposer`/`restoreComposerDraft`)
  and are shared with Messenger, the same Lexical editor family.
- **`threadId` is PINNED for the open chat** (live 2026-07-17). It prefers the peer phone, but on
  first contact the FIRST outgoing message (the handshake) is what creates that phone record — so
  the key flipped `name:<peer>` → `pn:<phone>` BETWEEN the handshake and the message of one send,
  the controller (which pins the thread across a multi-part send) read that as a chat switch, and
  dropped the message half ("1 of 2 parts went out"), leaving the peer unable to decrypt. threadId
  now caches the committed key per open chat and only re-resolves when the peer changes; the phone
  is still preferred on the NEXT open, when real history resolves it before any send.
- Peer name: the header's `span[title]` is gone; use `#main header span[dir="auto"]` — **high**.
- **Identity comes from IndexedDB.** WhatsApp REMOVED the JID from the DOM: a message `data-id`
  is now a bare msg id (`3A74AF56330BCB7852C`), no `@c.us`/`@g.us` on the page. The real phone
  number lives in the `model-storage` IndexedDB `message` records (see the Permanent-identity
  roadmap above for the full path). The adapter reads it in-process:
  - `peerHandle` / `threadId` = the peer's PHONE NUMBER, mapped DOM `data-id` → `message` record
    (key `endsWith('_'+msgid)`) → `fromMe ? to : from` (`@c.us` digits). `threadId` = `pn:<digits>`,
    `peerHandle` = `<digits>` for the directory. Async + per-msgid cached; `name:<encoded>` is
    the fallback until it resolves or if the DB is unavailable. `encodeURIComponent` on the name
    fallback is mandatory (scoped ids must be printable ASCII, `thread.ts` `SCOPED_THREAD_ID_RE`).
    **Ceiling**: an INACTIVE chat's newest message can sit deep in the global store; the scan is
    capped (~60k keys) and past that falls back to the name binding.
  - `isDirectChat` = distinct `data-pre-plain-text` senders `> 2` is a group (never
    false-positives a 1:1); else require the composer `aria-label` to contain the peer name
    (a 1:1 personalizes it, a group's is generic). Anything else fails VISIBLE, never guesses
    direct. **Ceiling**: a quiet 2-speaker group could slip through — retune off the overlay.

**Messenger** (verified live against www.messenger.com 2026-07-12 — same Meta React stack as
Instagram, so structure/ARIA only, never classes):
- The open conversation lives entirely inside `[role="main"]` (the thread list sits outside
  it) — that is the scope root. **high**.
- `threadId` = the numeric conversation id in the URL, `/t/(\d+)` (covers `/t/` and
  `/e2ee/t/`) — stable per conversation. **high**.
- `peerHandle` = the peer's GLOBAL Facebook user id, read from a scoped profile link
  `[role="main"] a[href*="facebook.com/<id>"]` (e.g. `100058152965713`). A permanent, mutual
  identifier — the same for everyone — so directory discovery keys on something real, not a
  contact name. `peerName` is the same anchor's text (cosmetic). **high**.
- `isDirectChat` = count of DISTINCT peer ids inside `[role="main"]` (your own id never appears
  there): one = 1:1, several = group, zero = fail-visible. **medium** (retune against a real
  Messenger group; E2EE 1:1s label themselves "you created this group", which is cosmetic).
- Composer `[role="main"] [contenteditable="true"][role="textbox"]`; send = synthetic Enter
  (Lexical, same as Instagram) with a Send-button fallback; bubbles scope to
  `[data-scope="messages_table"]`. **high**.
- **Send path hardened 2026-07-17** (same day WhatsApp's live pass proved execCommand clears
  are no-ops on this shared Lexical editor): composer writes go through `dom.ts`'s Selection
  writer, placement confirms the box holds EXACTLY the token (a leftover draft can never ride
  along), a post-Enter remount counts as delivered only when the token echoes in a bubble
  (never a blind re-fire), the Send-click fallback fires only while the SAME node still holds
  our token, a failed send restores the draft only over our own token, and an 800ms
  composer-wait covers the re-render between back-to-back parts. Pinned by jsdom fixtures in
  `test/adapters-dom.test.ts`; not yet re-verified against a live messenger.com session
  (the WhatsApp pass is the mechanism's live proof).
- Note: Messenger runs its own E2EE transport; Ekko still overlays PQ encryption on the text,
  unaffected.

**Telegram WebK + WebA** (WebK verified live 2026-07-12; sources: morethanwords/tweb and
Ajaxy/telegram-tt; their class names are hand-authored, not build-hashed):
- WebK: composer `.input-message-input[contenteditable]`, send `.btn-send`, bubbles
  `.bubble:not(.service):not(.is-date) .message`, `peerName` `.chat-info .peer-title`, numeric
  identity from `data-peer-id` — **all confirmed hitting on the current build** (a 1:1 resolved
  `direct:true`, glyph rendered). WebK now also puts the numeric peer id in the URL hash
  (`#5293449953`); the adapter's DOM `data-peer-id` read is unaffected. `peerHandle` (the
  `@username` for directory discovery) still comes from a `#@username` hash or a `t.me/` link
  and is only present for peers WITH a public username — not yet re-verified against a
  username peer, so discovery on Telegram is untested end to end (detection + manual encryption
  are confirmed).
- WebA (/a/, /z/): **not re-verified on the current build** — needs the same live pass.
- WebA: composer `#editable-message-text`, send `button.main-button.send`, bubbles
  `.MessageList .Message:not(.ActionMessage) .text-content`, numeric identity from the URL hash —
  **medium** until live-tuned.
- **Username + phone come from IndexedDB** (added 2026-07-16; needs a live overlay confirm). The
  collapsed chat header shows only the display name — the `@username` and phone live in each
  client's own IndexedDB, which the content script reads in-process (same origin, no network),
  keyed on the peer id we already have. DB + store names are discovered at runtime
  (`indexedDB.databases()` + the live `objectStoreNames`) so a version bump or tweb's
  `__encrypted` store-name suffix can't break it. Value shapes confirmed from real logged-in
  leveldb: **WebK/tweb** keeps one raw-MTProto `user` per numeric id in a `users…` store
  (`{ username, phone, usernames:[{username,pFlags:{active}}] }`); **WebA/telegram-tt** keeps the
  whole global state under one `tt-global-state` key, users at `.users.byId[id]`
  (`{ usernames:[{username,isActive}], phoneNumber }`). The pure picker `pickTelegramIdentity`
  normalizes both and is unit-tested. **Telegram withholds the phone from non-mutual-contacts**,
  so the overlay's `phone` row is `hidden` for most peers by design — not a selector miss.
  *Ceiling*: a Telegram local passcode encrypts tweb's stored values → the read yields null and we
  fall back to the numeric id.
- Directory lookup prefers that IndexedDB `@username`, then WebK's `#@username` hash or a visible
  `t.me/` profile link. A display/full name is never substituted; users with no public username
  get no lookup.

## Live-tuning diagnostic

**First choice: the built-in debug overlay.** Popup → Settings → "Show debug overlay in
chats" renders a small live readout on every supported chat page (extension version, glyph
state, thread id, direct-chat status, peer name/handle, plus each adapter's selector hits
via `debugProbe()`). No DevTools needed — a screenshot of it points straight at the drifted
selector. The glyph itself also fails **visible** now: an open chat surface whose identity,
1:1 status, or link state can't be confirmed shows a muted "identifying this chat" glyph
instead of nothing, with sends paused. (The one remaining fail-invisible case is the
composer selector itself drifting — the glyph anchors to it. The overlay's `composer:
false` row catches exactly that.)

The console snippets below remain as a fallback for when the content script itself didn't
load. Paste the platform's snippet into the DevTools console **while a DM is open and you
are logged in**. It reports which selectors hit, so a miss points straight at the field to
fix in the `SELECTORS` block. It only reads the DOM — it sends nothing and changes nothing.

### WhatsApp Web (open a 1:1 chat first)

```js
(() => {
  const q = (s) => document.querySelectorAll(s).length;
  const row = document.querySelector('#main div[data-id]');
  const jid = row?.getAttribute('data-id')?.split('_')[1];
  console.table({
    'ekko loaded':  !!document.getElementById('rsn-style'), // false = reload this tab after loading the extension
    'glyph mounted': !!document.getElementById('rsn-glyph'),
    composer:      q('#main footer div[contenteditable="true"][data-tab="10"]') || q('#main footer div[contenteditable="true"]'),
    sendButton:    q('#main footer span[data-icon="send"]'),
    messageRows:   q('#main div[role="row"]'),
    textSpans:     q('#main span.selectable-text'),
    peerName:      document.querySelector('#main header span[title]')?.getAttribute('title') ?? '(missing)',
    jid:           jid ?? '(no message rendered yet)',
    isDirect:      jid ? jid.endsWith('@c.us') : '(unknown)',
  });
})();
```

### Telegram Web K or A (open a private chat first)

```js
(() => {
  const q = (s) => document.querySelectorAll(s).length;
  const webA = location.pathname.startsWith('/a') || location.pathname.startsWith('/z');
  const peerEl = webA
    ? null
    : document.querySelector('.chat-info .peer-title[data-peer-id]') || document.querySelector('.bubble[data-peer-id]');
  const pid = webA ? location.hash.slice(1).split('_')[0] : peerEl?.getAttribute('data-peer-id');
  const composer = webA ? '#editable-message-text' : '.input-message-input[contenteditable="true"]';
  const sendButton = webA ? 'button.main-button.send' : '.btn-send';
  const bubbles = webA ? '.MessageList .Message:not(.ActionMessage) .text-content' : '.bubble:not(.service):not(.is-date) .message';
  console.table({
    'ekko loaded':  !!document.getElementById('rsn-style'), // false = reload this tab after loading the extension
    'glyph mounted': !!document.getElementById('rsn-glyph'),
    'telegram client': webA ? 'WebA /a/ or /z/ (supported beta)' : 'WebK /k/ (supported beta)',
    composer:     q(composer),
    sendButton:   q(sendButton),
    bubbles:      q(bubbles),
    peerName:     document.querySelector(webA ? '.MiddleHeader .fullName, .MiddleHeader .info .title' : '.chat-info .peer-title')?.textContent?.trim() ?? '(missing)',
    peerId:       pid ?? '(missing — check .peer-title[data-peer-id])',
    isDirect:     pid ? Number(pid) >= 0 : '(unknown)',
  });
})();
```

A healthy result has `ekko loaded: true`, the supported client, `composer`, `sendButton`,
and the platform's message-text count all ≥ 1, a real `peerName`, and `isDirect: true` in a 1:1 chat. The
first failing row is the cause: `ekko loaded: false` → reload the tab (content scripts only
inject on page load); any selector `0` or `(missing)` → send me the table and I'll patch
the relevant WebK/WebA selector set.

## Try the protocol without installing anything

`npm run demo` bundles `src/core` (the real crypto), starts the directory server in memory,
and serves an interactive page at http://127.0.0.1:5555 that runs the whole flow —
publish a handle, look it up, post-quantum handshake, seal and open messages — live in the
browser. It's the fastest way to confirm the core works, independent of any messenger DOM.
