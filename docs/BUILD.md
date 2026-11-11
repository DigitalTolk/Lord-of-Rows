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
Output: `target/universal-apple-darwin/release/bundle/{macos,dmg}/`. The build is **unsigned**; signing/notarization
needs an Apple Developer ID (see RELEASE notes in BLOCKERS.md).

## CI
`.github/workflows/ci.yml`: fmt, clippy, Rust tests with DB services, frontend checks, full E2E in Docker, security
scans + SBOM, unsigned universal macOS DMG artifact.
