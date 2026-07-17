# Ekko design language

One system across marketing site, extension popup, and future apps. Synthesized from two
studied references (a quiet editorial "lab" site and a technical hardware-lab site) but
original: Ekko's identity is the **echo** — concentric rings, and words that dissolve into
ciphertext.

> This repo carries the extension surfaces. `site/` and `docs/brand/` paths below live in
> the site's own tree, and `ios/…` paths in
> [ekko-ios](https://github.com/useekko/ekko-ios) — they're referenced here so the
> one-system rules stay in one doc.

## Voice

Serious privacy lab, quietly rebellious. Plain sentences, no exclamation marks, no
corporate "we're excited". The strongest statement on the page is a demonstration, not
an adjective.

**Show the product we are building, not just this week's build.** The keyboard, the
apps still in beta, the next platform: all of it is fair to name and fair to animate.
That is the product. Where something is not live yet, say when it lands ("in your
browser today, in your keyboard next") rather than hiding it. The one thing we never
bend is the crypto and the threat model: what the keys do, what the servers see, and
what an attacker can still reach (see THREAT_MODEL.md) are described exactly.

**Positioning (2026-07):** Ekko is one private identity for every app you already use —
claim a handle and sync your people (the directory maps handles to *public* keys), or go
fully anonymous and trade invites directly. Two modes, always. We offer a service: never
claim "no analytics / self-hosted / no third-party requests". The honest line is "your
private keys never leave your device — our servers only ever see public keys."

## Type

| Role | Face | Usage |
|---|---|---|
| Display & prose | Newsreader (serif) | headlines, body copy on the site |
| UI & labels | Inter (sans) | buttons, navigation, extension UI, all micro-labels |
| Machine | Geist Mono | **ciphertext and protocol strings only** |

All three are SIL OFL, self-hosted woff2 — a privacy product never loads fonts from a
third-party CDN. Micro-labels (kickers, section numbers, tags) are Inter 500, uppercase,
11–12px, letter-spacing ≈ 0.12em — never mono; mono is reserved for machine output so
ciphertext reads as the only "terminal" thing on the page. Fluid display sizes use
`clamp()`; body serif ≈ 18px/1.6.

## Color

Icy cool paper in light, deep night in dark, hairlines, one accent — coral, the Balanced
Packet E mark's own color (`#ff5f52` family), promoted from mark to sole accent (2026-07;
the old indigo `#7c8cf8` is retired everywhere, extension included). Accent is scarce in
UI: links, the primary button, the rings, live cursors. Atmosphere (and only atmosphere)
may add a teal undertone (`--glow-b`). Everything else is monochrome.

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#f6f7fb` | `#0a0c11` |
| `--ink` | `#14161d` | `#edeef4` |
| `--ink-soft` | `#363a46` | `#c9ccd6` |
| `--muted` | `#6d7382` | `#838896` |
| `--faint` | `#a9aebc` | `#5b6070` |
| `--line` | `#e4e7ef` | `#222633` |
| `--accent` | `#ff5f52` | `#ff5f52` |
| `--accent-ink` | `#fff` | `#fff` |
| `--glow-b` | `#2fcbb5` | `#2fcbb5` |

Depth tokens: `--rim` (inset top highlight — the glass rim light) and `--glass-shadow` /
`--frame-shadow` (layered shadows, always *tinted* blue-gray, never plain black).

**The site ships light-only** (decision 2026-07-10): one lit, consumer look; no toggle,
no `prefers-color-scheme` variance, `color-scheme: light`. **The extension popup adopted
the light column too (2026-07-16)** — small accent text there uses a deepened coral
(`--accent-deep #d63d30`) because pure coral fails AA on paper below ~18px. **The
extension's onboarding.html followed later the same day** — no dark web surface remains,
and the popup/onboarding seam is closed. **The iOS app renders BOTH columns
(2026-07-16)**: it follows the system appearance (`ios/Shared/Theme.swift` carries every
token as a light/dark pair, `Ink.accentDeep` mirroring `--accent-deep`), so the dark
column stays alive there even though the web surfaces ship light-only.

## Motifs

- **The mark: Balanced Packet E** (promoted 2026-07-13) — a packet-shaped E with a
  detached protocol dot, set in coral `#ff5f52`. It is the logo, favicon, touch icon,
  extension icon, in-product mark, OG card mark, and store-card mark. The hero *stage*
  can still use environmental waves that emanate from a sealed-message card and dissolve
  before the edge (`.echo`); those waves are motion language, not a second logo.
- **Glass artifacts** — the wire card, product frame, and waitlist console are physical
  objects: translucent surface, `--rim` top highlight, tinted layered shadows, gradient
  hairline border that leads with accent. The archived message-path pipeline used a flat,
  inert platform node on purpose — alive endpoints, dead courier. It remains in design
  history for a future protocol diagram, but no longer appears on About.
- **Glossy accent CTA** — the primary button is the product: coral gradient lit from
  above, accent bloom below, 1px lift on hover. Secondary stays a quiet ghost.
- **Chip carousel** — "works with" platforms as glass pills: brand-color icon + name,
  a gradient "Live" badge on what's shipped. Colorful on purpose; it's the one
  consumer-loud element.
- **Ghost wordmark** — a giant letterspaced "ekko" at the very bottom of the footer,
  masked to dissolve off the page. The echo, leaving.
- **Dissolve to ciphertext** — text scrambling into base64-ish glyphs (the `EKK1M:` look).
  Used once, in the hero, honestly labeled if illustrative. Respect
  `prefers-reduced-motion`.
- **Step arts** (`.art`, in the three how-it-works cards) — one small looping machine per
  step, each performing the exact gesture its sentence describes: a handle types itself
  and is claimed, three people connect to your hub through echo rings, an Ekko blob
  surfaces at the end of a message box and the words leave as ciphertext. Glass slab,
  one drifting accent bloom behind it, brand gradient on the live objects only. Rules
  that keep them honest: **pure CSS** keyed off `.steps.is-in` (no per-art JS), a
  **different loop length per card** so they drift instead of beating in lockstep, and a
  **resting state that equals the finished state** — with animation off (no-JS,
  reduced-motion) each art must read as a completed picture, never an empty box.
- **Numbered sections** — mono `01 — SURVEILLANCE` kickers over serif titles, hairline
  rules between sections, generous vertical space (~7rem).
- **Privacy-honest footer** — no ad tracking or required cookies. Self-hosted, cookieless
  analytics is disclosed in the privacy policy; never claim the site makes zero requests.

## Layout

Centered prose column 640px; wide moments (demo, principles grid) up to 1080px. Section
padding `clamp(4rem, 10vw, 7rem)`. Hairline `1px var(--line)` rules, radius 14–22px
(pill buttons). Depth belongs to the glass artifacts only — everything else stays flat
with borders. A whisper of grain rides inside the aurora gradients (SVG turbulence in
the stylesheet; CSP `img-src data:` covers it) so they never band. Motion: 0.15–0.3s
ease for hovers; one slow signature animation (the echo waves; reduced-motion hides
them).

## Generated image pipeline

Every raster asset is generated, never hand-exported, so a brand tweak regenerates the
whole set. Two producers:

1. **`scripts/make-icons.mjs`** (deterministic, zero deps) — draws the mark analytically:
   extension toolbar icons (`icons/icon{16,32,48,128}.png`), site `apple-touch-icon.png`
   (180), `favicon-{32,96}.png`, and the packed 16/32/48 `favicon.ico`. Runs inside
   `npm run build`.
2. **HTML card templates + headless Chrome** — templates are committed at
   `docs/brand/templates/` (regen commands in `docs/brand/README.md`). Outputs:
   versioned `site/assets/og-v*.png` / `og-about-v*.png` link previews,
   `site/assets/product-chat.png`
   (2480×1440 desktop DM mock) + `product-chat-mobile.png` (1280×1536 portrait, served
   via `<picture>` on phones), and the X profile pair `docs/brand/x-banner.png` /
   `x-avatar.png`. Bump the `?v=` query on any regenerated site asset.

Shipped from the same pipeline (2026-07-11): **Chrome Web Store listing** —
`docs/brand/store/` (440×280 tile, 1400×560 marquee, four 1280×800 screenshots that
render the real popup through `templates/popup-shim.js`; regen recipe in
`docs/brand/README.md`).

Planned next (same pipeline):
- **Demo video slot**: `site/assets/demo.mp4` — the home page's media frame auto-upgrades
  from the product still to the video when the file exists. Record with two Chrome
  profiles on live Instagram; `product-chat.png` doubles as its poster.
- **Docs diagrams**: the message-path pipeline as a standalone card for PROTOCOL.md.

## Don'ts

- No emoji in UI. No gradients-on-everything. No stock illustration.
- No overclaiming ("unbreakable", "military-grade").
- No third-party embeds of any kind on the site.
