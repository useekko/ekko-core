# The Ekko account (backend contract)

Supabase Auth (Apple + Google + emailed 8-digit code), profiles with claimable @handles and a published
PUBLIC key, handle search, connection requests, post-quantum session setup, and linked socials. All of it behind row-level
security, with **registration disabled** at the project level: an account exists only because the
owner invited it.

> **Two "handle" systems, deliberately.** This one (Supabase: `profiles`, `connections`,
> `account_handles`) is the account. The standalone key directory is a separate service. They share
> the same handle grammar (`^[a-z0-9_]{3,20}$`) so the namespaces can converge, and the account is
> the one moving forward: `profiles.public_key` now carries the identity's PUBLIC key, which is what
> turns an accepted connection into an encrypted channel instead of an address book entry.
>
> An account is an entitlements holder, never a crypto identity. **Private keys stay on the device.**

The Supabase URL and anon key ship inside the extension and the app. They are public by design;
row-level security is the enforcement and the session JWT is the identity.

> `ios/…` paths in this doc live in [ekko-ios](https://github.com/useekko/ekko-ios);
> `src/…` paths live here.

## Client constants

`SUPABASE_URL` and the anon key. Both already ship inside the extension and the app
(`src/core/account.ts`, `ios/Ekko/EkkoAccountClient.swift`) — they are public by design, and
row-level security, not secrecy, is the enforcement:

```
SUPABASE_URL = https://hkcohnjgyutarjoongbb.supabase.co
AUTH = $SUPABASE_URL/auth/v1     REST = $SUPABASE_URL/rest/v1
```

Every REST call carries two headers: `apikey: <anon key>` and
`Authorization: Bearer <access_token>`.

## Auth flows (iOS)

**Apple** (native, iOS only): `SignInWithAppleButton` produces an
`ASAuthorizationAppleIDCredential`; its identity token is exchanged directly for a session,
no web round trip:

```bash
curl -X POST "$AUTH/token?grant_type=id_token" \
  -H "apikey: $ANON" -H 'content-type: application/json' \
  -d '{"provider":"apple","id_token":"<identityToken>","nonce":"<raw nonce>"}'
```

The Apple provider's client id is the **app bundle id** (`app.useekko.ios`) — Supabase verifies
it against the token's audience, so there is no client secret anywhere (a secret only exists for
web "Sign in with Apple", which is not offered). Nonce discipline: the Apple request is given
`SHA256(nonce)`, Supabase is given the raw value and hashes it to match — `EkkoAccount.makeNonce()`
returns the pair. Two invite-only consequences worth knowing: a device signed out of iCloud cannot
use the button at all, and **Hide My Email** yields a relay address that will read as uninvited
while registration is closed — invite the relay address, or have the user share their real email
(Supabase links providers by email, so a shared address lands on the same account as Google and
the code).

**Google** (once the provider is enabled): `ASWebAuthenticationSession` with
`callbackURLScheme: "ekko"` on

```
$AUTH/authorize?provider=google&redirect_to=ekko://auth-callback
```

The callback URL carries the session in the fragment:
`ekko://auth-callback#access_token=...&refresh_token=...&expires_at=...`. Register the
`ekko` scheme in Info.plist. `ekko://auth-callback` is already in the Supabase
redirect allowlist (a `redirect_to` that misses the allowlist does not error; GoTrue
silently redirects to the web page instead — if tokens land on the page, check the
allowlist).

**Magic link** (works today):

```bash
curl -X POST "$AUTH/otp?redirect_to=ekko%3A%2F%2Fauth-callback" \
  -H "apikey: $ANON" -H 'content-type: application/json' \
  -d '{"email":"person@example.com","create_user":false}'
```

The email (from Ekko via Resend, subject "Your Ekko sign-in link") carries the link
(opens Safari, deep-links back with fragment tokens) **and an 8-digit code** for the
no-deep-link path — links are one-time with a 1 hour expiry and mail scanners
sometimes consume them, so the code is the reliable fallback (the web page accepts it
too, in the field that appears after sending):

```bash
curl -X POST "$AUTH/verify" -H "apikey: $ANON" -H 'content-type: application/json' \
  -d '{"type":"email","email":"person@example.com","token":"12345678"}'
# -> {access_token, refresh_token, expires_at, user}
```

**Refresh** — JWTs live 3600s; rotation is ON with a 10s reuse window, so always
persist the new pair atomically and refresh before expiry:

```bash
curl -X POST "$AUTH/token?grant_type=refresh_token" \
  -H "apikey: $ANON" -H 'content-type: application/json' \
  -d '{"refresh_token":"..."}'
```

**Sign out**: `POST $AUTH/logout` with both headers (best-effort).

The user's id/email/metadata are inside the JWT payload (`sub`, `email`,
`user_metadata.full_name/avatar_url`) — display only, RLS enforces reality.
`supabase-swift` is the sanctioned alternative to hand-rolled REST if the app grows
past this scaffold.

## Data API (PostgREST, all under RLS)

`ME` below = the `sub` claim. On POSTs add `Prefer: return=representation` to get the
row back. Writes against rows you do not own return **empty arrays, not errors**.

**Profile / handle** (one row per account; handle `^[a-z0-9_]{3,20}$`, unique,
first-claim-wins):

```bash
curl "$REST/profiles?user_id=eq.$ME&select=user_id,handle,display_name" -H ...
curl -X POST "$REST/profiles" -d '{"user_id":"'$ME'","handle":"kirill","display_name":"Kirill"}' -H ...
curl -X PATCH "$REST/profiles?user_id=eq.$ME" -d '{"handle":"newname"}' -H ...
```

**Search** (any signed-in user can search all claimed handles — intended for the
alpha):

```bash
curl "$REST/profiles?handle=ilike.kir*&select=user_id,handle,display_name&limit=10" -H ...
```

**Connections** (request by user id from search; you must have claimed a handle first
— the FKs point at profiles):

```bash
# my edges, both directions, with the other side's profile embedded
curl "$REST/connections?select=id,status,requester,addressee,created_at,\
requester_profile:profiles!connections_requester_fkey(handle,display_name),\
addressee_profile:profiles!connections_addressee_fkey(handle,display_name)" -H ...

curl -X POST "$REST/connections" -d '{"requester":"'$ME'","addressee":"<their uuid>"}' -H ...
# accept (addressee only, pending only):
curl -X PATCH "$REST/connections?id=eq.<id>" -d '{"status":"accepted","responded_at":"2026-07-13T00:00:00Z"}' -H ...
# decline / cancel / disconnect are all DELETE:
curl -X DELETE "$REST/connections?id=eq.<id>" -H ...
```

**Session setup** (public `EKK1H` delivery, never a session key or message):

```bash
# requester stages while pending; the recipient can SELECT it only after acceptance
curl -X POST "$REST/session_setups" -d '{
  "connection_id":"<connection uuid>",
  "recipient":"<addressee uuid>",
  "sender_key":"<64-char fingerprint>",
  "recipient_key":"<64-char fingerprint>",
  "handshake":"EKK1H:..."
}' -H 'Prefer: resolution=merge-duplicates' -H ...

curl "$REST/session_setups?select=connection_id,sender,recipient,sender_key,recipient_key,handshake" -H ...
```

The requester can insert/update only its own row addressed to that connection's addressee. RLS
hides pending setup from the addressee until acceptance. The backend sees the same public KEM
ciphertext an invitation would carry, but ML-KEM decapsulation and both derived keys stay on-device.

**Socials** (platforms: instagram, telegram, whatsapp, messenger, x, discord;
whatsapp = phone digits with country code; visible to self and accepted connections;
immutable — delete and re-add to change):

```bash
curl "$REST/account_handles?user_id=eq.<uuid>&select=id,platform,handle" -H ...
curl -X POST "$REST/account_handles" -d '{"platform":"whatsapp","handle":"4915123456789"}' -H ...
# never send user_id: the column defaults to auth.uid() and RLS rejects spoofed values
curl -X DELETE "$REST/account_handles?id=eq.<uuid>" -H ...
```

## Error surface

| Signal | Meaning | UI copy |
|---|---|---|
| `error_code: signup_disabled` / `otp_disabled` | email not invited | "This demo is invite-only." |
| `over_email_send_rate_limit` / 429 | per-address 60s throttle or 30/hr cap | "Too many emails just now. Wait a minute and try again." |
| 409 on profiles | handle taken | "That handle is taken." |
| 409 on connections | edge already exists (either direction) | "A request already exists between you." |
| 409 on account_handles | duplicate social | "Already added." |
| 401 on REST | access token expired | refresh once, then re-auth |
| empty array on write | RLS refused (not yours) | treat as failure |

## Encrypted key backup (`key_backups`)

The only table in this project that comes near a private key — and it never actually touches one.

```
key_backups
  user_id    uuid primary key default auth.uid() references auth.users on delete cascade
  blob       jsonb  -- {v, kdf, iter, salt, nonce, ct}, size-capped at 256 KiB
  updated_at timestamptz
```

**What lands here is ciphertext and nothing else.** The client seals its 24 words + contact list
with XChaCha20-Poly1305 under a PBKDF2-HMAC-SHA256 (600k) key derived from a passphrase that never
leaves the device (`src/core/backup.ts`, `ios/EkkoCore/Sources/EkkoCore/Backup.swift`). The server
neither parses nor validates the envelope, because a server that understood the format would be a
server you had to trust. Consequences, in full, are in `docs/THREAT_MODEL.md`.

RLS is **owner-only in every direction** — unlike `profiles` or `account_handles`, a backup is
invisible even to an accepted connection. That is not because the ciphertext would harm them; it is
so that one stolen session token cannot be used to hoover up the whole table and grind it offline.

Three traps, each of which cost something to find:

- **PostgREST refuses an unfiltered DELETE** (`21000: DELETE requires a WHERE clause`). Clients must
  send `?user_id=eq.<uid>`. RLS would have contained it anyway; this is the belt to that suspenders.
- **Postgres `jsonb` REORDERS object keys.** A blob stored as `{v,kdf,iter,salt,nonce,ct}` comes back
  as `{v,ct,…}`. This is survivable only because the authenticated header (AAD) is rebuilt from the
  field *values*, never from the stored JSON *text*. If anyone ever "optimises" the AAD to be the raw
  envelope bytes, **every backup in existence silently stops opening**. A test pins this
  (`test/backup.test.ts`, "still opens after a store has reordered the envelope keys").
- **Supabase timestamps have six fractional digits** (`2026-07-14T01:52:25.104574+00:00`) and
  `JSONDecoder`'s default date strategy expects a *number*, so a synthesised `Codable` init makes
  every fetch fail. `EkkoAccountClient` decodes `updated_at` by hand and treats it as decoration —
  never let the timestamp sink the row.

Upsert with `Prefer: resolution=merge-duplicates`: one row per user, so re-backing-up replaces the
blob rather than leaving older copies of the identity in table history.
