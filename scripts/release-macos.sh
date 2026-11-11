#!/usr/bin/env bash
# Local release: universal macOS build, Developer ID signed, notarized + stapled DMG.
#
# Notarization credentials, in this order (nothing is printed or written to disk):
#   1. APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID from the environment;
#      APPLE_ID falls back to the value exported in ~/.zshrc, the password to the login
#      keychain item: service "APPLE_APP_SPECIFIC_PASSWORD", account "$USER"
#      (same setup as the ECS Shell / vibe-staff releases).
#   2. otherwise a notarytool keychain profile (NOTARY_PROFILE, default "lotr-notary").
#
# CI: .github/workflows/release.yml runs this same script on a version tag (secrets in the env).
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
NOTARY_ARGS=()
if [ -z "${SKIP_NOTARIZE:-}" ]; then
  if [ -z "${APPLE_ID:-}" ] && [ -f "$HOME/.zshrc" ]; then
    APPLE_ID="$(sed -n 's/^export APPLE_ID="\(.*\)"$/\1/p' "$HOME/.zshrc" | tail -1)"
  fi
  if [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
    APPLE_APP_SPECIFIC_PASSWORD="$(security find-generic-password -a "$USER" -s APPLE_APP_SPECIFIC_PASSWORD -w 2>/dev/null || true)"
  fi
  APPLE_TEAM_ID="${APPLE_TEAM_ID:-H8S8C5U3W2}"
  if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
    NOTARY_ARGS=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
    echo "==> Notarization: Apple ID credentials (team $APPLE_TEAM_ID)"
  elif xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
    NOTARY_ARGS=(--keychain-profile "$PROFILE")
    echo "==> Notarization: keychain profile '$PROFILE'"
  else
    echo "No notarization credentials: set APPLE_ID + keychain item APPLE_APP_SPECIFIC_PASSWORD, or create profile '$PROFILE'." >&2
    exit 1
  fi
fi

if [ -z "${SKIP_BUILD:-}" ]; then
  echo "==> Building frontend"
  (cd frontend && npm ci --no-fund --silent && npx vite build)
  CFG='{"build":{"beforeBuildCommand":""}}'
  if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"   # CI secret
  elif [ -f "$HOME/.dbstudio/updater.key" ]; then
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

if [ -z "${SKIP_NOTARIZE:-}" ] && xcrun stapler validate "$APP" >/dev/null 2>&1; then
  echo "==> App already notarized and stapled"
elif [ -z "${SKIP_NOTARIZE:-}" ]; then
  echo "==> Notarizing the app"
  ZIP="$(mktemp -d)/app.zip"
  ditto -c -k --keepParent "$APP" "$ZIP"
  xcrun notarytool submit "$ZIP" "${NOTARY_ARGS[@]}" --wait
  xcrun stapler staple "$APP"
  spctl -a -vv -t exec "$APP"
fi

echo "==> Creating DMG"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/Lord of the Rows.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
# Explicit size: hdiutil's -srcfolder estimate is too small for the universal app ("No space left on device").
SIZE_MB=$(( $(du -sm "$STAGE" | cut -f1) * 13 / 10 + 32 ))
hdiutil create -volname "Lord of the Rows" -srcfolder "$STAGE" -fs HFS+ -size "${SIZE_MB}m" -ov -format UDZO "$DMG" >/dev/null
codesign -s "$SIGN_ID" "$DMG"

if [ -z "${SKIP_NOTARIZE:-}" ]; then
  echo "==> Notarizing (this usually takes a few minutes)"
  xcrun notarytool submit "$DMG" "${NOTARY_ARGS[@]}" --wait
  xcrun stapler staple "$DMG"
  echo "==> Gatekeeper check"
  spctl -a -vv -t install "$DMG"
fi

echo "==> Done: $DMG"
