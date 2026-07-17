#!/usr/bin/env bash
# Build the Ekko extension and install it into Safari on THIS Mac.
#
#   scripts/mac-safari.sh
#
# Safari cannot load an unpacked extension the way Chrome can: a Safari web extension has to be
# carried by a real, signed macOS app. So this builds dist/, converts it into a throwaway container
# app with Apple's safari-web-extension-converter, signs it, and drops it in /Applications. Safari
# discovers the extension from the app the first time the app is launched.
#
# The extension itself is byte-identical to the Chrome one (same adapters, same crypto, same popup)
# apart from the background script, which npm run ios:safari rebuilds as an IIFE — Safari rejects a
# `"type": "module"` service worker outright, which would leave it with no background at all.
#
# Two traps, both of which cost time the first time:
#
#   1. The converter derives the APP's bundle id from the prefix and ignores --bundle-identifier for
#      it, so you get app.useekko.Ekko for the app and app.useekko.mac.Extension for the extension.
#      An embedded binary MUST be prefixed by its parent's id, so the build fails with the unhelpful
#      "Embedded binary's bundle identifier is not prefixed with the parent app's". We rewrite the
#      app id afterwards. It comes back on every regeneration; do not hand-fix it in Xcode.
#
#   2. This is signed with an Apple DEVELOPMENT certificate, not Developer ID + notarization, so
#      Safari considers the extension unsigned and refuses to enable it until you turn on
#      "Allow unsigned extensions" in the Develop menu. **That setting resets every time Safari
#      quits.** It is not broken; it is Safari. Re-tick it after each restart.
set -euo pipefail

cd "$(dirname "$0")/.."

APP_ID="app.useekko.mac"
PROJECT="artifacts/safari-mac"
TEAM="${DEVELOPMENT_TEAM:-ZRM8H35T8U}"
DD="${TMPDIR:-/tmp}/ekko-mac-dd"

echo "building the extension…"
npm run --silent ios:safari

echo "converting to a macOS app…"
rm -rf "$PROJECT"
mkdir -p "$PROJECT"
xcrun safari-web-extension-converter ios/EkkoSafari/Resources \
  --macos-only --project-location "$PROJECT" --app-name "Ekko" \
  --bundle-identifier "$APP_ID" --swift --copy-resources \
  --no-open --no-prompt --force >/dev/null

# Trap 1, above. The extension is already $APP_ID.Extension; make the app $APP_ID so it prefixes.
sed -i '' "s/PRODUCT_BUNDLE_IDENTIFIER = app\.useekko\.Ekko;/PRODUCT_BUNDLE_IDENTIFIER = $APP_ID;/g" \
  "$PROJECT/Ekko/Ekko.xcodeproj/project.pbxproj"

echo "signing and building…"
xcodebuild -project "$PROJECT/Ekko/Ekko.xcodeproj" -scheme Ekko -configuration Release \
  -derivedDataPath "$DD" DEVELOPMENT_TEAM="$TEAM" -allowProvisioningUpdates build 2>&1 |
  grep -E "error:|BUILD SUCCEEDED|BUILD FAILED"

# Quit the previous copy FIRST. Replacing a running app's bundle out from under it leaves the old
# one alive, `open` then does nothing (it is "already running"), and the new extension is never
# registered — which looks exactly like a failed build.
osascript -e 'tell application "Ekko" to quit' 2>/dev/null || true
pkill -x Ekko 2>/dev/null || true
sleep 1

rm -rf /Applications/Ekko.app
cp -R "$DD/Build/Products/Release/Ekko.app" /Applications/

# Launching it once is what makes Safari aware of the extension at all.
open -a /Applications/Ekko.app
for _ in $(seq 1 10); do
  sleep 1
  if pluginkit -mAvvv 2>/dev/null | grep -q "$APP_ID.Extension"; then
    echo "✓ Safari can see the extension"
    break
  fi
done
pluginkit -mAvvv 2>/dev/null | grep -q "$APP_ID.Extension" \
  || echo "✗ Safari did not register it — open /Applications/Ekko.app by hand once"

# Safari only shows the Develop menu if this is on, and only reads it at launch.
defaults write com.apple.Safari IncludeDevelopMenu -bool true 2>/dev/null || true

cat <<'DONE'

Installed. In Safari (quit and reopen it first, so the Develop menu appears):

  1. Develop > Allow Unsigned Extensions.
     RESETS EVERY TIME SAFARI QUITS — re-tick it after each restart. See trap 2 above.
  2. Safari > Settings > Extensions > tick Ekko.
  3. Open instagram.com and grant Ekko access to the site when asked
     ("Always Allow on Every Website" is the least annoying).

Then the Ekko button sits in Safari's toolbar and the composer glyph appears in DMs, exactly
as it does in Chrome. Same vault format, so the 24 words restore the same identity here.
DONE
