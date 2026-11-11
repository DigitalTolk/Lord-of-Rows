#!/usr/bin/env bash
# Publish a notarized release to GitHub; the DigitalTolk/homebrew-tools tap picks it up.
#
#   scripts/release-macos.sh          # builds ~/Downloads/LordOfTheRows-<version>-universal.dmg (notarized)
#   scripts/publish-homebrew.sh       # GitHub release v<version> + asks the tap to open its cask-update PR
#
# The cask lives in DigitalTolk/homebrew-tools (Casks/lord-of-the-rows.rb). Its
# "Update lord-of-the-rows cask" workflow checks the latest release every 6 h; this
# script just triggers it right away. Merge the PR it opens to ship the update.
#
# Users install with:
#   brew trust DigitalTolk/tools
#   brew install --cask DigitalTolk/tools/lord-of-the-rows
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="DigitalTolk/Lord-of-Rows"
TAP="DigitalTolk/homebrew-tools"
VERSION="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
TAG="v$VERSION"
DMG="${DMG:-$HOME/Downloads/LordOfTheRows-$VERSION-universal.dmg}"

[ -f "$DMG" ] || { echo "Missing $DMG (run scripts/release-macos.sh first)" >&2; exit 1; }
xcrun stapler validate "$DMG" >/dev/null || { echo "$DMG is not notarized/stapled" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run: gh auth login" >&2; exit 1; }
SHA="$(shasum -a 256 "$DMG" | cut -d' ' -f1)"

echo "==> GitHub release $TAG"
NOTES="Signed with DigitalTolk's Developer ID and notarized by Apple. Universal (Apple Silicon + Intel), macOS 11+.

Install with Homebrew:
\`\`\`
brew trust DigitalTolk/tools
brew install --cask DigitalTolk/tools/lord-of-the-rows
\`\`\`
or download the DMG below.

SHA-256: \`$SHA\`"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "$DMG" --repo "$REPO" --clobber
else
  gh release create "$TAG" "$DMG" --repo "$REPO" --target "$(git rev-parse HEAD)" --title "Lord of the Rows $VERSION" --notes "$NOTES"
fi

echo "==> Asking $TAP to update the cask"
gh workflow run update-lord-of-the-rows-cask.yml --repo "$TAP" \
  && echo "    The tap will open an 'Update lord-of-the-rows cask' PR; merge it to ship $VERSION." \
  || echo "    Could not trigger the workflow; it runs every 6 h anyway."
