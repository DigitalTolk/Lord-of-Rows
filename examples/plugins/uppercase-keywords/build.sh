#!/bin/sh
# Builds plugin.wasm and packs uppercase-keywords.dbsplugin.
# Usage: ./build.sh [secret-key.hex]   (optional key signs the package)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
rustup target add wasm32-unknown-unknown >/dev/null
cargo build --manifest-path "$here/Cargo.toml" --release --target wasm32-unknown-unknown --target-dir "$here/target"
cp "$here/target/wasm32-unknown-unknown/release/uppercase_keywords.wasm" "$here/plugin.wasm"
cargo run --quiet --manifest-path "$repo/Cargo.toml" -p dbs-plugins --example pack -- \
  "$here/plugin.json" "$here/plugin.wasm" "$here/uppercase-keywords.dbsplugin" "$@"
