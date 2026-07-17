# Ekko threat model

Stated plainly so users can decide what they're trusting. Ekko is a real E2E layer, not a privacy panacea.

## What Ekko protects

- **Message content in transit and at rest on platform servers.** Instagram (or anyone who later obtains its stored DMs) sees only `EKK1…` ciphertext, never your plaintext.
- **Against harvest-now-decrypt-later.** The ML-KEM-768 term in every session means traffic recorded today is not decryptable by a future quantum computer. This is the core reason to use Ekko over a purely classical tool.
- **Key ownership.** Private keys are generated on your device and never transmitted. The optional directory stores public bundles and mapping metadata only; messaging does not depend on a server-side decryption key.
- **Man-in-the-middle, once verified.** Comparing a contact's safety number out-of-band detects a substituted key. The iOS app and the extension's add-by-handle preview surface the code; the extension no longer carries a verification ritual (badge + "mark verified") — field reality is that nobody performed it, and an unused ceremony is not a control. A changed key on an existing contact is still refused and alarmed in-chat regardless.

## What Ekko does NOT protect

- **Metadata.** Who you talk to, when, how often, and message sizes are all still visible to the platform. Ciphertext blobs are also conspicuous — they reveal *that* you're using encryption.
- **A compromised endpoint.** Malware, a hostile browser extension in the same profile, or physical device access defeats any messaging encryption. Your plaintext exists in the page DOM to be read by you, so anything with code execution on that page can read it too.
- **The host page or native app itself.** Instagram's JavaScript can scrape the web composer before the extension encrypts, and its native app can read the iOS composer before the user taps the keyboard's manual Seal action. Keys never enter either host and encryption still happens inside Ekko, but a genuinely adversarial host that records its own draft field is outside what any overlay can stop. If that's your threat model, use a dedicated E2E app (Signal), not an overlay.
- **Endpoint-side forward secrecy / post-compromise security.** v1 uses static per-session keys with no ratchet. If a device is compromised and its vault master key extracted, past and future messages of existing sessions are exposed until rekey. (The handshake's ephemeral term still denies a *passive network* recorder.)
- **First-contact identity substitution and quantum-capable active attackers.** v1 binds a session to the supplied key bundles with classical X25519, not a verified real-world identity. An attacker who can replace an unverified invite can establish their own session; compare the safety number out of band. ML-DSA is the planned upgrade for quantum-resistant authentication.

## Key handling

| Secret | Where it lives | Lifetime |
|---|---|---|
| Identity private keys, session keys | encrypted in `chrome.storage.local`, decrypted only in the background SW | until you delete the vault |
| Recovery phrase | inside the same encrypted vault; shown during setup and on an explicit Settings action | until you delete the vault |
| Vault master key (scrypt-derived) | `chrome.storage.session` (memory-only); **plus `chrome.storage.local` when "Stay unlocked on this device" is on** | session copy: until the browser closes or you Lock. Local copy: until you Lock or turn the setting off |
| Plaintext | the supported host page DOM or native app composer, transiently | until Ekko replaces the draft with ciphertext |

**"Stay unlocked on this device" (opt-in, default off)** persists the derived master key in
`chrome.storage.local` so a browser restart does not lock Ekko. Said plainly: with it on, the
vault ciphertext and the key that opens it sit side by side in the browser profile, so the
passphrase no longer protects you from someone who can read that profile — your OS login does.
This is the standard consumer posture (Signal Desktop and mainstream desktop E2EE clients keep
keys behind the OS user boundary), and the UI states the trade in the same breath as the
toggle. A deliberate Lock always clears both copies of the key immediately.

While locked, the extension keeps an opaque digest of each bound conversation in plain extension storage solely to block an accidental plaintext send after a browser restart. It does not store the raw provider conversation ID there, but it is still metadata and should not be treated as secret.

The Instagram, WhatsApp, and Telegram content scripts perform only public envelope operations
(classify, chunk, base64). They contain no secret-key cryptography — verifiable in the built
`dist/{instagram,whatsapp,telegram}.js` bundles.

## The encrypted key backup (opt-in, iOS today)

This is the one feature that deliberately puts something derived from your private keys on a
server, so it gets said plainly rather than buried.

**What is uploaded:** an XChaCha20-Poly1305 ciphertext of your 24 words and your contact list, under
a key derived by PBKDF2-HMAC-SHA256 (600k rounds) from a passphrase. `src/core/backup.ts`.

**What Ekko can do with it: nothing.** The passphrase is generated on the device, shown once, and
never transmitted, logged, escrowed or derived server-side. Supabase holds `{v,kdf,iter,salt,nonce,ct}`
and no way to open it. A stolen database dump, a rogue admin, a subpoena and a compromised Google
account all yield the same thing: noise. This is enforced by mathematics, not by policy — which is
why it does not require you to trust that the production server runs the code in this repo.

**What it costs you, honestly:**

- **An offline attacker gets unlimited guesses.** Anyone holding the blob can grind passphrases with
  no rate limit and nobody watching. Everything therefore rests on passphrase entropy. The app
  **generates** a six-word passphrase (~77 bits, out of reach) and only offers a user-chosen one
  behind an explicit toggle with a warning. **A weak self-chosen passphrase is the one way to lose
  your keys to this feature**, because PBKDF2 is fast on a GPU (it is not memory-hard; the KDF is
  not what is protecting you — the entropy is).
- **It is a target that did not previously exist.** Before this, there was no server-side artefact
  of a private key at all. Now there is one, for users who opt in. RLS makes a blob readable only by
  its owner, so one stolen session token does not let an attacker walk the table — but the honest
  statement is that the attack surface grew.
- **Losing the passphrase loses the backup**, not the identity: the 24 words still work.

**Not doing it is a first-class choice.** Off-grid users, and account users who never tap "Back up
my keys", have exactly the old model: keys on device, nowhere else.

## Trust-on-first-use and verification

Adding a contact by invite is TOFU: you trust that the invite reached you unaltered. A network attacker who can rewrite the channel you exchanged invites over could substitute keys. The **safety number** exists to close this: compare it over a second channel (in person, voice call). All contacts get encryption; the comparison adds MITM assurance for those who want it.

Where that stands in the product (2026-07-15): the account flow is the primary trust path — a key rides an explicitly accepted connection, authenticated by the account backend, which raises the bar from "anyone who can rewrite a DM" to "the backend or an account takeover". The pairwise code is shown on iOS (contact detail) and in the extension's add-by-handle preview. The extension's per-contact verification ceremony (unverified badge, disclosure, "mark verified") was removed as theater: essentially no one performed it, and a `verified` flag that gates nothing protects nothing. The vault still records `verified` (iOS sets it; formats are shared). The active MITM defenses that remain are structural, not ritual: key changes on an existing contact are refused and alarmed in-chat, and sessions pin to conversations.

## Platform / operational risks

- **Direct-chat scope.** v1 has no group cryptography. Only use it in one-to-one chats; groups, channels, and broadcast threads are unsupported.
- **Protocol-level conversation binding.** The extension pins a stored session to one direct conversation and rejects ordinary cross-thread replays. A complete, previously unseen handshake replay is not cryptographically bound to a provider conversation in v1; explicit acceptance plus safety-number comparison limit that risk, and KDF-bound conversation context is the protocol upgrade path.
- **Other platforms.** WhatsApp Web and Telegram Web have beta automatic adapters whose selectors still need logged-in live tuning. X has no DOM adapter; any future integration must use its official DM API. WhatsApp restricts unauthorized automation, Telegram's client terms prohibit forcing other clients to install an app to view content, and X prohibits scripting its website.
- **Directory identity and metadata.** An authenticated v2 write proves control of an Ekko device key, not ownership of the claimed Instagram, WhatsApp, or Telegram account. Platform mappings remain unverified reservations, and the client refuses to offer them automatically. When auto-discovery is explicitly enabled, each eligible lookup sends the platform plus a deterministic hash of the peer account identifier; the directory can guess common handles, correlate repeats, and observe the client IP. The setting defaults off and anonymous users cannot enable it.
- **Standing directory permission.** The manifest grants `https://useekko.app/*` at install (it was briefly an optional, per-use permission). Requests occur only when the user invokes a directory feature, reserves a platform mapping, or explicitly enables automatic suggestions; the extension still works fully without contacting it. The *capability* exists from install. This is a deliberate simplicity tradeoff; revisit if users ask for a zero-capability install.
- **Upgrade migration.** The one-time v0.3→v0.4 migration scopes stored sessions to conversations. A legacy session that can't be matched to exactly one conversation is quarantined: its old messages stay decryptable through the popup's manual decrypt tool, but no longer decrypt in-page.
- **Terms of Service.** Automating or modifying Instagram's web UI likely violates Meta's terms. Account restriction or ban is a real, disclosed possibility. Ekko deliberately implements no detection evasion.
- **Conspicuousness.** Base64 ciphertext blobs may trip spam or automation heuristics. Personal-use volume keeps this low but nonzero.
- **DOM drift.** Messaging sites reshape their DOM regularly; an adapter may break until its `SELECTORS` block is re-patched. Encryption correctness is unaffected — only the in-page convenience layer.

## Closed source, for now

The code is proprietary in v1. That is a real trust cost for a cryptography tool: independent researchers cannot yet audit the implementation. Mitigations: this protocol spec and threat model are public, the crypto is standard audited primitives (noble), and an external audit is planned before any broad launch. The licensing decision is explicitly revisitable.
