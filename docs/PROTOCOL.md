# Ekko protocol v1

A compact, PGP-*style* (not OpenPGP-compatible) envelope sized to survive Instagram's hard 1000-character-per-message limit. Multi-byte payloads are `base64url` without padding. Message tokens ride in ordinary DMs; setup tokens may instead travel through an account backend or invitation flow.

> New payloads use the Ekko-branded `EKK1I:`/`EKK1H:`/`EKK1M:`/`EKK1C:` prefixes. Readers also accept the original `RSN1*` spellings so existing invites, sessions, and stored messages survive an upgrade. The cryptographic HKDF `salt`/`info` literals `Resonance/v1/session` / `Resonance/v1` remain unchanged: unlike the parsed outer prefix, changing those bytes would derive different session keys and break established conversations.

Primitives (via [noble](https://paulmillr.com/noble/)): **X25519**, **ML-KEM-768** (FIPS 203), **XChaCha20-Poly1305**, **SHA-256**, **HKDF-SHA256**, **scrypt**.

## Token kinds

| Prefix | Meaning | Approx. size on the wire |
|---|---|---|
| `EKK1I:` | Identity bundle (invite) | ~1630 chars |
| `EKK1H:` | Session handshake | ~3127 chars → 4 chunks on IG |
| `EKK1M:` | Encrypted message | 70 chars + payload |
| `EKK1C:` | Transport chunk | wraps any oversized token |

## Identity

Long-term keypair per user:

```
bundle = version(1=0x01) ‖ x25519_pub(32) ‖ mlkem768_pub(1184)      // 1217 bytes
fingerprint = SHA-256(bundle)                                       // 32 bytes
```

Invite = `EKK1I:` + base64url(bundle). Exchanged out-of-band (paste or QR). Adding a contact is trust-on-first-use; comparing the **safety number** upgrades it to verified.

**Safety number** (Signal-style, symmetric): `SHA-256( sort(fpA, fpB) )` rendered as 60 decimal digits in groups of five. Forging a colliding number requires ≈2¹⁹⁹ work.

## Handshake (PQXDH-shaped)

Initiator A holds B's bundle. A emits:

```
EKK1H wire = version(1) ‖ A.bundle(1217) ‖ ephemeral_x25519_pub(32) ‖ mlkem_ct(1088)   // 2338 bytes
```

A's bundle is embedded, so the responder pastes nothing. Both sides compute three shared secrets and combine them:

```
dh_eph    = X25519(ephemeral, B.id)      // == X25519(B.id, ephemeral)   forward secrecy for the handshake
dh_static = X25519(A.id, B.id)           // symmetric                    classical implicit authentication
kem_ss    = ML-KEM-768 shared secret     // encapsulate / decapsulate    POST-QUANTUM confidentiality

ikm  = dh_eph ‖ dh_static ‖ kem_ss
(fp0, fp1) = sort(fpA, fpB)              // canonical order → both sides derive identically
okm  = HKDF-SHA256(ikm, salt="Resonance/v1/session", info="Resonance/v1" ‖ fp0 ‖ fp1, L=72)

key_0to1 = okm[0:32]   key_1to0 = okm[32:64]   session_id = okm[64:72]
```

The ML-KEM term means a passive adversary recording traffic today cannot decrypt it with a future quantum computer. The static-static X25519 term binds the session to the supplied bundles, but it does not authenticate a peer at first contact: an attacker who substitutes an invite can establish a valid session with their own key. Compare the safety number out of band before trusting a contact. ML-DSA signatures are intentionally **not** used in v1; they are the first planned authentication upgrade.

Transport is deliberately separate from derivation. The iOS app delivers `EKK1H` through an
accepted account connection (`session_setups`) or as an off-grid return invitation; its keyboard
emits only `EKK1M`. Older clients may still carry `RSN1H` in a DM, and receivers retain support.

## Message

```
body = version(1) ‖ flags(1) ‖ session_id(8) ‖ nonce(24) ‖ XChaCha20-Poly1305(plaintext)
       └──────────── AAD (first 10 bytes) ────────────┘
flags bit0 = sender's canonical party (0/1) → selects key_0to1 vs key_1to0
```

`EKK1M:` + base64url(body). The header doubles as AEAD associated data, so version/direction/session can't be swapped. Both parties hold both directional keys, so each side also decrypts its **own** echoed bubble (Instagram renders your sent messages back to you).

Messages are **stateless**: random 24-byte nonces, no ratchet. Platform reordering or deletion cannot desynchronize a session. A device keeps at most four sessions per peer and direct thread, so history remains decryptable only while its session is retained; older rekeyed history can become unreadable. Rekeying = a fresh handshake.

### Forward secrecy: why NOT the Signal double ratchet (decision, 2026-07-10)

A full Signal-style double ratchet (new DH keys every reply) is **deliberately not** the plan, because it conflicts with two core Ekko properties. (1) The ratchet needs ordered, reliable, stateful delivery; Ekko rides host-app DMs that drop, reorder, dedupe, and delete messages, which would desync the chain and make everything after undecryptable — the exact failure the stateless design avoids. (2) Forward secrecy deletes old keys, which breaks Ekko's decrypt-in-place-on-reload UX (scroll up your DMs and old messages re-decrypt every load). The ratchet also adds no *authentication* — safety numbers already provide that, out of band.

The forward-secrecy upgrade path that *does* fit the overlay model is a **coarse periodic re-key**: re-run the handshake every N days / messages and retain a small window of recent session keys (the 4-session cap already provides the mechanism). This bounds a key compromise to messages since the last re-key, keeps each session stateless within its window (so reordering is still fine and recent history still decrypts), and avoids per-message DH exchange. It is the pragmatic middle ground between static-forever sessions and a full ratchet, and the recommended v2+ direction if/when PCS is warranted.

## Chunking

Any token longer than the platform cap (`maxMessageLen`, 900 for Instagram) is split:

```
EKK1C:<id>:<i>/<n>:<part>
```

`id` is a short base36 group id; `i`/`n` are 0-based index and total. The receiver buffers by `id`, reassembles in index order once all `n` arrive, then processes the reconstructed token normally. A handshake spans ~4 Instagram messages only on legacy in-chat transports; current iOS setup stays outside the conversation.

## At-rest storage

```
master = scrypt(passphrase, salt, N=2^15, r=8, p=1, dkLen=32)
vault  = XChaCha20-Poly1305(master, nonce, JSON{ identity secrets, contacts, sessions, thread bindings })
blob   = { salt, nonce, ct }        // chrome.storage.local (persisted)
master                              // chrome.storage.session (memory-only; survives SW restart, dies with the browser)
```

scrypt runs only at create/unlock; every subsequent change re-seals with the cached master (fast XChaCha). Backup = the `blob` JSON, already passphrase-encrypted.
