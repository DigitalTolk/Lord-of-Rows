#!/usr/bin/env bash
# Local release: universal macOS build, Developer ID signed, notarized + stapled DMG.
#
# One-time setup (Terminal, interactive; the password never touches this script):
#   xcrun notarytool store-credentials "lotr-notary" --apple-id "<apple id>" --team-id H8S8C5U3W2
#
# Usage:
#   scripts/release-macos.sh                 # build + sign + notarize -> ~/Downloads
#   NOTARY_PROFILE=other scripts/release-macos.sh
#   SKIP_NOTARIZE=1 scripts/release-macos.sh # signed only (Gatekeeper will warn on other Macs)
#   SKIP_BUILD=1 scripts/release-macos.sh    # reuse the last universal build
set -euo pipefail
cd "$(dirname "$0")/.."

SIGN_ID="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Digital Interpretations Scandinavia AB (H8S8C5U3W2)}"
PROFILE="${NOTARY_PROFILE:-lotr-notary}"
OUT_DIR="${OUT_DIR:-$HOME/Downloads}"
VERSION="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
APP="target/universal-apple-darwin/release/bundle/macos/Lord of the Rows.app"
DMG="$OUT_DIR/LordOfTheRows-$VERSION-universal.dmg"

# Toolchain on this Mac: rustup from Homebrew; the CLT linker needs the 26.5 SDK.
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
if [ -d /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk ]; then
  export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk
fi
export MACOSX_DEPLOYMENT_TARGET=11.0
export APPLE_SIGNING_IDENTITY="$SIGN_ID"

security find-identity -v -p codesigning | grep -qF "$SIGN_ID" || { echo "Signing identity not found in keychain: $SIGN_ID" >&2; exit 1; }
if [ -z "${SKIP_NOTARIZE:-}" ]; then
  xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 || {
    echo "Notary profile '$PROFILE' not found. Run once in Terminal:" >&2
    echo "  xcrun notarytool store-credentials \"$PROFILE\" --apple-id \"<apple id>\" --team-id H8S8C5U3W2" >&2
    exit 1
  }
fi

if [ -z "${SKIP_BUILD:-}" ]; then
  echo "==> Building frontend"
  (cd frontend && npm ci --no-fund --silent && npx vite build)
  CFG='{"build":{"beforeBuildCommand":""}}'
  if [ -f "$HOME/.dbstudio/updater.key" ]; then
    export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.dbstudio/updater.key")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
  else
    CFG='{"build":{"beforeBuildCommand":""},"bundle":{"createUpdaterArtifacts":false}}'
  fi
  echo "==> Building universal app (signed with: $SIGN_ID)"
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
  ./frontend/node_modules/.bin/tauri build --target universal-apple-darwin --bundles app --config "$CFG"
fi

echo "==> Verifying app signature"
codesign --verify --deep --strict "$APP"
codesign -dv "$APP" 2>&1 | grep -E "Authority=Developer ID Application|TeamIdentifier"

echo "==> Creating DMG"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/Lord of the Rows.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Lord of the Rows" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
codesign -s "$SIGN_ID" "$DMG"

if [ -z "${SKIP_NOTARIZE:-}" ]; then
  echo "==> Notarizing (this usually takes a few minutes)"
  xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
  xcrun stapler staple "$DMG"
  echo "==> Gatekeeper check"
  spctl -a -vv -t install "$DMG"
fi

echo "==> Done: $DMG"
