# Plugins

DB Studio plugins are small WebAssembly modules that run in a sandbox inside the Rust backend. They can
format SQL, add an export format, or (runtime only, no UI yet) describe a schema. They cannot reach
the network, the filesystem, credentials, or a database connection: the host API has no way to ask
for any of those.

- Runtime: `crates/dbs-plugins` (wasmtime, Pulley interpreter)
- Commands and registry: `src-tauri/src/plugins.rs`, table `plugins` (app store migration v2)
- UI: Settings → Plugins, "Format with …" in the query editor, "Export with plugin…" on result grids
- Example: `examples/plugins/uppercase-keywords/`

## Security model

| Property | How it is enforced |
|---|---|
| No unrestricted execution | Plugins are wasm only. JavaScript plugins are not supported, and no plugin code runs in the webview. |
| Isolation | The module **may not import anything**: no WASI, no host functions. A module with any import is rejected at install. It can only compute over the bytes the host copies into its linear memory. |
| No ambient state | Every call creates a fresh `Store` and instance. Nothing persists between calls, and a crash cannot affect the next call. |
| CPU bound | Fuel metering. The default is 3×10⁹ units, a few seconds. Running out traps the call (`OutOfFuel`). |
| Memory bound | The resource limiter caps linear memory at 128 MiB and allows 1 memory, 4 tables and 20k table elements. A module whose initial memory is too large cannot start. |
| I/O bound | Input and output are capped at 16 MiB per call. The `(ptr, len)` the guest returns is bounds-checked against its memory before any read, and so is the pointer `alloc` returns before the host writes. |
| No JIT memory | Modules are compiled to Pulley bytecode and interpreted. No executable pages are mapped, so the macOS hardened-runtime entitlements still exclude JIT. |
| Explicit grants | The manifest declares capabilities. Install grants **nothing** and the plugin starts disabled. The user grants each capability separately. A call needs the capability both declared and granted. Enabling requires at least one grant. Revoking every grant disables the plugin. |
| No default data access | `read_query_results` only covers rows the user explicitly exports through the plugin. `read_schema` only covers names passed to it. No capability gives credentials, connections, paths, other settings or the audit log. |
| Integrity | The wasm SHA-256 is recorded at install and checked again before the module is loaded. Modified files are refused. |
| Consent binding | Install takes the SHA-256 the user reviewed. If the file changed between inspect and install, install fails. |
| Signing | Optional ed25519 (see below). Install of an unsigned package needs a second, explicit confirmation. So does an upgrade signed by a different key than the installed version, and grants reset in that case. |
| Safe failure | A trap, out-of-fuel, memory-limit hit, bad pointer, oversized output or invalid UTF-8 disables the plugin and records `last_error`. It is audited as `plugin_permission_changed` / failure. The app keeps running. |
| Audit | Install/upgrade → `plugin_installed`. Grant changes and enable/disable → `plugin_permission_changed`. Removal → `plugin_removed`. Exports → `export` (detail `via plugin <id>`). |

**What signing does not mean.** A "Verified publisher key `abcd:…`" badge proves that the package was
signed by that key and has not been modified since. DB Studio has no publisher directory or trust
store, so you must compare the fingerprint with one the author publishes. Signing does not raise
privileges, and signed plugins are sandboxed exactly like unsigned ones.

**Residual risks.** A granted `format_sql` plugin can return different SQL from the SQL you gave it,
and the editor shows the result. Review the text before you run it: the normal safety classifier
and production confirmations still apply. An exporter receives the rows you export and can write
anything into the file you chose.

## Package format

A `.dbsplugin` file is a zip that contains exactly two regular files:

```
plugin.json   (≤ 64 KiB)
plugin.wasm   (≤ 32 MiB)
```

Any other entry is rejected, and so are directories, symlinks, encrypted entries, duplicates and
paths containing `..`, `/`-prefixes, `\` or `:`. Sizes are checked against the declared size and
while reading, to stop zip bombs. Installed files go to
`<app data>/plugins/<id>/<version>/`.

### Manifest (`plugin.json`)

```json
{
  "id": "com.example.uppercase-keywords",
  "name": "Uppercase keywords",
  "version": "1.0.0",
  "api_version": 1,
  "min_app_version": "0.1.0",
  "description": "Uppercases SQL keywords.",
  "author": "Example Ltd",
  "capabilities": ["format_sql"],
  "export": { "label": "Markdown table", "extension": "md" },
  "settings": [{ "key": "indent", "label": "Indent", "type": "number", "default": 2 }],
  "public_key": "<64 hex chars>",
  "signature": "<128 hex chars>"
}
```

- `id`: lowercase reverse-DNS, at least two labels, each starting with a letter.
- `version`, `min_app_version`: semver. Upgrades must not go down a version; to downgrade, remove the plugin first. Pre-release builds of the app count as the release (`0.2.0-dev` satisfies `0.2.0`).
- `api_version`: must be `1`.
- `capabilities`: one or more of the following. Unknown values and unknown fields are rejected.

| Capability | Guest export | Receives |
|---|---|---|
| `format_sql` | `format_sql` | the editor text (UTF-8); returns UTF-8 |
| `export_format` | `export_rows` | requires `read_query_results` and an `export` section; returns file bytes |
| `read_query_results` | — | permission for `export_rows` to receive rows |
| `read_schema` | `describe_schema` | JSON `{"tables":[…]}`; returns UTF-8 (runtime only, no UI yet) |

- `settings`: up to 16 entries. Each has a `key` matching `[a-z0-9_]{1,32}` and a `type` of `bool`, `string` or `number`. Values are validated against the type and passed to `configure` as JSON.

## Guest ABI

All pointers and lengths are `i32` offsets into the module's exported `memory`. Results are packed
into an `i64` as `(ptr << 32) | len`.

| Export | Signature | Required |
|---|---|---|
| `memory` | memory | yes |
| `alloc` | `(len: i32) -> i32` | yes; the host writes input there |
| `dealloc` | `(ptr: i32, len: i32)` | optional, never called (each call is a fresh instance) |
| `configure` | `(ptr: i32, len: i32)` | optional; receives settings JSON before the main call when the manifest declares settings |
| `format_sql` | `(ptr: i32, len: i32) -> i64` | if `format_sql` |
| `export_rows` | `(ptr: i32, len: i32) -> i64` | if `export_format`; input is `{"columns":["a",…],"rows":[[…],…]}` |
| `describe_schema` | `(ptr: i32, len: i32) -> i64` | if `read_schema` |

To signal an error, trap (`unreachable`, or `panic!` with `panic = "abort"`). The host reports
"plugin crashed" and disables the plugin.

## Writing a plugin (Rust)

See `examples/plugins/uppercase-keywords/src/lib.rs`. It is a `no_std` crate with no allocator. It
grows memory in `alloc`, rewrites the SQL in place and returns the same `(ptr, len)`. The built
module is about 2 KB.

```sh
rustup target add wasm32-unknown-unknown
examples/plugins/uppercase-keywords/build.sh            # unsigned
examples/plugins/uppercase-keywords/build.sh key.hex    # signed
```

`build.sh` compiles with `--target wasm32-unknown-unknown --release` (opt-level `z`, LTO,
`panic = "abort"`), then calls the packer, which validates the module the same way the app does:

```sh
cargo run -p dbs-plugins --example pack -- plugin.json plugin.wasm out.dbsplugin [secret-key.hex]
```

Any language that targets `wasm32-unknown-unknown` with no imports works. With Rust `std`, make sure
the module has no `wasi_*` or `env` imports; `cargo build --target wasm32-unknown-unknown` normally
produces none.

### Signing

Create a key with `openssl rand -hex 32 > key.hex` and keep it secret. The signature is ed25519
(`verify_strict`) over this exact text:

```
dbstudio-plugin-signature-v1
id=<id>
version=<version>
min_app_version=<min_app_version>
api_version=<api_version>
capabilities=<sorted, comma-separated>
wasm_sha256=<lowercase hex>
```

So the signature binds the key to the identity, version, requested permissions and code. Adding a
capability or changing the wasm invalidates it. Description, settings and export label are not
signed. The UI shows the key fingerprint: the first 16 bytes of SHA-256(public key), as hex in groups
of four.

## Limits and known gaps

- `read_schema` has no UI entry point yet.
- The wasm runs in an interpreter, which is slower than native code. The defaults handle a multi-MB
  script with a simple formatter (see the example test), but heavy plugins can run out of fuel. Limits
  are not user-configurable.
- There is no plugin marketplace, auto-update or revocation list. Updates are manual installs of a
  newer version.
- The install/enable/run commands and the UI have not been exercised by the WebDriver E2E suite yet.
