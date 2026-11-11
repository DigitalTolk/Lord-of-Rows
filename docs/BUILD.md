# Build

## Linux (Docker, used for development and tests)
```sh
docker compose build dev
docker compose run --rm dev sh -c 'cd frontend && npm ci && npx vite build && cd .. && cargo build -p dbstudio --release --features custom-protocol'
```

## macOS (native, unsigned)
Requires Xcode Command Line Tools, Rust (`brew install rustup && rustup default stable && rustup target add x86_64-apple-darwin aarch64-apple-darwin`) and Node (`brew install node`).
```sh
cd frontend && npm ci && npx vite build && cd ..
# If your Command Line Tools linker is older than the default SDK ("unknown architecture arm64e.x1"), pin a matching SDK:
export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk
./frontend/node_modules/.bin/tauri build --target universal-apple-darwin --bundles app,dmg --config '{"build":{"beforeBuildCommand":""}}'
```
Output: `target/universal-apple-darwin/release/bundle/{macos,dmg}/`.
If the DMG step fails with `hdiutil: couldn't unmount … Resource busy` (Finder/Spotlight holding the temporary
image), build the DMG directly:
```sh
STAGE=$(mktemp -d); cp -R "target/universal-apple-darwin/release/bundle/macos/Lord of the Rows.app" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Lord of the Rows" -srcfolder "$STAGE" -ov -format UDZO "Lord of the Rows_0.1.0_universal_unsigned.dmg"
```
Verified 2026-11-11: universal (x86_64 + arm64) app, 60 MB; DMG 27 MB; launches on macOS 27.2 (Apple Silicon). The build is **unsigned**; signing/notarization
needs an Apple Developer ID (see RELEASE notes in BLOCKERS.md).

## CI
`.github/workflows/ci.yml`: fmt, clippy, Rust tests with DB services, frontend checks, full E2E in Docker, security
scans + SBOM, unsigned universal macOS DMG artifact.
