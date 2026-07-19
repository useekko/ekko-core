#!/usr/bin/env bash
# Build a DISTRIBUTABLE, signed + notarized Safari .dmg — the release counterpart to
# scripts/mac-safari.sh (which only dev-signs a throwaway app for the local Mac).
#
#   scripts/mac-safari-release.sh          → artifacts/Ekko-<version>.dmg
#
# Same extension, same convert-to-app dance and the same two bundle-id / "allow unsigned" traps
# documented in mac-safari.sh. The differences that make it shippable:
#   • signed with a Developer ID Application cert (not an Apple Development cert) + hardened runtime,
#   • notarized by Apple's service so Gatekeeper opens it with no scary dialog,
#   • wrapped in a drag-to-Applications .dmg, stapled so a downloaded copy mounts cleanly offline.
#
# Runs on a Mac with Xcode. In CI (release.yml) the cert + notarization creds arrive as env vars;
# locally it reuses whatever Developer ID identity is already in your login keychain, so you can
# leave MAC_CERT_P12_BASE64 unset and it signs straight from the keychain.
#
# Env (all optional locally, all set by release.yml in CI):
#   MAC_CERT_P12_BASE64   base64 of a Developer ID Application cert+key .p12; imported to a temp
#                         keychain when present. Unset → sign from the login keychain.
#   MAC_CERT_PASSWORD     password for that .p12.
#   APPLE_TEAM_ID         team id, to disambiguate the signing identity (default: ZRM8H35T8U).
#   AC_API_KEY_ID / AC_API_ISSUER_ID / AC_API_KEY_P8_BASE64
#                         App Store Connect API key for notarytool. All three unset → the .dmg is
#                         built and signed but NOT notarized (fine for a local smoke test).
set -euo pipefail
cd "$(dirname "$0")/.."

APP_ID="app.useekko.mac"
PROJECT="artifacts/safari-mac"
TEAM="${APPLE_TEAM_ID:-ZRM8H35T8U}"
DD="${TMPDIR:-/tmp}/ekko-mac-release-dd"
TMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

# —— import the Developer ID cert into a throwaway keychain (CI only) ——
if [ -n "${MAC_CERT_P12_BASE64:-}" ]; then
  echo "importing Developer ID cert into a temp keychain…"
  KEYCHAIN="$TMP/ekko-signing.keychain-db"
  KC_PW="$(uuidgen)"
  security create-keychain -p "$KC_PW" "$KEYCHAIN"
  security set-keychain-settings -lut 3600 "$KEYCHAIN"
  security unlock-keychain -p "$KC_PW" "$KEYCHAIN"
  echo "$MAC_CERT_P12_BASE64" | base64 --decode > "$TMP/cert.p12"
  security import "$TMP/cert.p12" -k "$KEYCHAIN" -P "${MAC_CERT_PASSWORD:-}" \
    -T /usr/bin/codesign -T /usr/bin/xcodebuild
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KC_PW" "$KEYCHAIN" >/dev/null
  # Put the temp keychain first in the search list so xcodebuild finds the identity.
  security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | sed s/\"//g)
  rm -f "$TMP/cert.p12"
fi

echo "building the extension…"
npm run --silent ios:safari
VERSION="$(node -p "require('./dist/manifest.json').version")"

echo "converting to a macOS app…"
rm -rf "$PROJECT"
mkdir -p "$PROJECT"
xcrun safari-web-extension-converter ios/EkkoSafari/Resources \
  --macos-only --project-location "$PROJECT" --app-name "Ekko" \
  --bundle-identifier "$APP_ID" --swift --copy-resources \
  --no-open --no-prompt --force >/dev/null

# Trap 1 (see mac-safari.sh): the converter ignores --bundle-identifier for the APP and derives
# app.useekko.Ekko, which no longer prefixes the app.useekko.mac.Extension appex. Rewrite it.
sed -i '' "s/PRODUCT_BUNDLE_IDENTIFIER = app\.useekko\.Ekko;/PRODUCT_BUNDLE_IDENTIFIER = $APP_ID;/g" \
  "$PROJECT/Ekko/Ekko.xcodeproj/project.pbxproj"

echo "signing (Developer ID + hardened runtime) and building…"
rm -rf "$DD"
# Developer ID direct distribution: manual signing, no provisioning profile, hardened runtime +
# a secure timestamp (both required for notarization). CODE_SIGN_IDENTITY is the generic name;
# DEVELOPMENT_TEAM disambiguates when more than one Developer ID cert is in the keychain.
# ponytail: if a future entitlement makes xcodebuild demand a profile, add -allowProvisioningUpdates.
xcodebuild -project "$PROJECT/Ekko/Ekko.xcodeproj" -scheme Ekko -configuration Release \
  -derivedDataPath "$DD" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="Developer ID Application" \
  DEVELOPMENT_TEAM="$TEAM" \
  ENABLE_HARDENED_RUNTIME=YES \
  OTHER_CODE_SIGN_FLAGS="--timestamp" \
  build 2>&1 | grep -E "error:|warning: |BUILD SUCCEEDED|BUILD FAILED"

APP="$DD/Build/Products/Release/Ekko.app"
[ -d "$APP" ] || { echo "✗ build produced no Ekko.app"; exit 1; }

echo "packaging the .dmg…"
mkdir -p artifacts
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications" # drag-to-install target
DMG="artifacts/Ekko-$VERSION.dmg"
rm -f "$DMG"
hdiutil create -volname "Ekko" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

# —— notarize + staple the .dmg (skipped when no API key, e.g. a local smoke build) ——
if [ -n "${AC_API_KEY_P8_BASE64:-}" ] && [ -n "${AC_API_KEY_ID:-}" ] && [ -n "${AC_API_ISSUER_ID:-}" ]; then
  echo "notarizing (this waits on Apple, usually a couple of minutes)…"
  echo "$AC_API_KEY_P8_BASE64" | base64 --decode > "$TMP/AuthKey.p8"
  xcrun notarytool submit "$DMG" \
    --key "$TMP/AuthKey.p8" --key-id "$AC_API_KEY_ID" --issuer "$AC_API_ISSUER_ID" --wait
  rm -f "$TMP/AuthKey.p8"
  # Staple the .dmg so a downloaded copy mounts without an online check.
  # ponytail: the .app inside is notarized but not individually stapled, so a *fully offline* first
  # launch after dragging it out does one online check. Staple "$APP" before the dmg if that matters.
  xcrun stapler staple "$DMG"
  echo "✓ notarized + stapled  $DMG  (v$VERSION)"
else
  echo "⚠ no App Store Connect API key in the env — built + signed but NOT notarized: $DMG"
  echo "  (fine for a local test; the release job supplies the key so the published .dmg is notarized.)"
fi
