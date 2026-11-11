#!/usr/bin/env bash
# Publish a notarized release to GitHub and update the Homebrew tap.
#
#   scripts/release-macos.sh          # builds ~/Downloads/LordOfTheRows-<version>-universal.dmg (notarized)
#   scripts/publish-homebrew.sh       # GitHub release v<version> + Casks/lord-of-the-rows.rb in DigitalTolk/homebrew-tap
#
# Needs: gh (logged in with access to DigitalTolk), the notarized DMG.
# Users install with (the tap repo is private; their GitHub SSH key is enough):
#   brew tap digitaltolk/tap git@github.com:DigitalTolk/homebrew-tap.git
#   brew install --cask digitaltolk/tap/lord-of-the-rows
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="DigitalTolk/Lord-of-Rows"
TAP="DigitalTolk/homebrew-tap"
VERSION="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
TAG="v$VERSION"
DMG="${DMG:-$HOME/Downloads/LordOfTheRows-$VERSION-universal.dmg}"

[ -f "$DMG" ] || { echo "Missing $DMG (run scripts/release-macos.sh first)" >&2; exit 1; }
xcrun stapler validate "$DMG" >/dev/null || { echo "$DMG is not notarized/stapled" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run: gh auth login" >&2; exit 1; }
SHA="$(shasum -a 256 "$DMG" | cut -d' ' -f1)"

echo "==> GitHub release $TAG"
NOTES="Signed with DigitalTolk's Developer ID and notarized by Apple. Universal (Apple Silicon + Intel), macOS 11+.

Install with Homebrew (DigitalTolk GitHub access needed for the private tap):
\`\`\`
brew tap digitaltolk/tap git@github.com:DigitalTolk/homebrew-tap.git
brew install --cask digitaltolk/tap/lord-of-the-rows
\`\`\`
or download the DMG below.

SHA-256: \`$SHA\`"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "$DMG" --repo "$REPO" --clobber
else
  gh release create "$TAG" "$DMG" --repo "$REPO" --target "$(git rev-parse HEAD)" --title "Lord of the Rows $VERSION" --notes "$NOTES"
fi

echo "==> Homebrew tap $TAP"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
gh repo clone "$TAP" "$WORK/tap" -- --depth 1 >/dev/null 2>&1 || { echo "Tap repo $TAP not found: create it first (gh repo create $TAP --private)" >&2; exit 1; }
mkdir -p "$WORK/tap/Casks"
sed -e "s/@VERSION@/$VERSION/" -e "s/@SHA256@/$SHA/" packaging/homebrew/lord-of-the-rows.rb.tmpl > "$WORK/tap/Casks/lord-of-the-rows.rb"
if [ ! -f "$WORK/tap/README.md" ]; then
  printf '# DigitalTolk Homebrew tap (private)\n\n```\nbrew tap digitaltolk/tap git@github.com:DigitalTolk/homebrew-tap.git\nbrew install --cask digitaltolk/tap/lord-of-the-rows\n```\n' > "$WORK/tap/README.md"
fi
(
  cd "$WORK/tap"
  git add -A
  if git diff --cached --quiet; then echo "Cask already up to date"; exit 0; fi
  git commit -qm "lord-of-the-rows $VERSION"
  git push -q origin HEAD
)
echo "==> Done: brew install --cask digitaltolk/tap/lord-of-the-rows"
