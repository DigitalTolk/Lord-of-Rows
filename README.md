# Lord of the Rows

**Lord of the Rows** is DigitalTolk's own desktop database client, designed and built in-house
from scratch with Tauri 2 (Rust backend) and React/TypeScript. All code, design and artwork are original.

![Lord of the Rows: a customers table with a filter, the row detail panel and the object sidebar](docs/screenshots/table-workspace.png)

**Status:** macOS builds are signed with DigitalTolk's Developer ID and notarized by Apple
(universal: Apple Silicon + Intel; `scripts/release-macos.sh`). Tested end to end on Linux in Docker
against real PostgreSQL, MySQL, MariaDB, Redis, DynamoDB Local and an SSH bastion. Windows builds
are not done yet; see [FEATURE_MATRIX.md](FEATURE_MATRIX.md), [BLOCKERS.md](BLOCKERS.md).

## Install (macOS)

```
brew trust DigitalTolk/tools
brew install --cask DigitalTolk/tools/lord-of-the-rows
```

Or download the DMG from [Releases](https://github.com/DigitalTolk/Lord-of-the-Rows/releases). Builds are universal
(Apple Silicon + Intel, macOS 11+), signed with DigitalTolk's Developer ID and notarized by Apple.
Update with `brew update && brew upgrade --cask DigitalTolk/tools/lord-of-the-rows`.

No admin rights on your Mac? Install into your own Applications folder:
`brew install --cask --appdir=~/Applications DigitalTolk/tools/lord-of-the-rows`
(or set `export HOMEBREW_CASK_OPTS="--appdir=~/Applications"` in `~/.zshrc` once).

## What works today

- PostgreSQL, MySQL, SQLite, Redis, DynamoDB (PartiQL; tested against DynamoDB Local) (plus wire-compatible engines, unverified)
- Connection launcher, engine picker, connection rail with per-database tabs
- SSH tunnels (password / key / passphrase / agent, jump hosts, strict host-key checks)
- SSL modes PREFERRED / DISABLED / REQUIRED / VERIFY-CA / VERIFY-IDENTITY (custom CA, client certs); plaintext-capable modes refused for remote production
- SQL editor (Monaco) with schema-aware completion; grid / JSON / text / record / chart results
- Inline editing with SQL review, single-transaction commit and conflict detection
- Structure view, table designer, schema diff → migrations (reversibility-aware)
- ER diagram, monitoring, dashboards, command palette, themes
- Production safe mode enforced in Rust; tamper-evident audit log; passwords in the OS keychain
- Optional AI assistant (off by default; prompt preview + explicit send; see [docs/AI_ASSISTANT.md](docs/AI_ASSISTANT.md))
- Access requests through any access-management service that speaks the [Access API](docs/access-api.md): time-limited database access, approvals, one-click connect (see below)

## Screenshots

All screenshots are taken from the real app (Linux build, driven over WebDriver by
`e2e/debug/screenshots.test.mjs`) against the demo fixtures in `tests/fixtures/`.

**Connection launcher**: connection groups, environment pills and the environment filter chips.

![Connection launcher](docs/screenshots/launcher.png)

**New connection**: the MySQL form with tag, safe mode and SSL mode.

![New connection form](docs/screenshots/connection-form.png)

**Table workspace**: filter bar, row detail panel, status pill, schema rail and the Items sidebar.

![Table workspace](docs/screenshots/table-workspace.png)

**Pending changes**: a staged cell edit (highlighted) and the preview of the exact UPDATE that Commit will run.

![Pending changes preview](docs/screenshots/pending-changes.png)

**Grid context menu**: copy, set value, quick filter, delete, with the *Copy Rows As* submenu open.

![Grid context menu](docs/screenshots/context-menu.png)

**Split SQL editor**: two queries side by side, each with its own results.

![Split SQL editor](docs/screenshots/query-split.png)

**Open database** (Ctrl/⌘+K): schemas in the current database, system schemas and other databases on the server.

![Open database picker](docs/screenshots/open-database.png)

**ER diagram** of the demo `shop` schema.

![ER diagram](docs/screenshots/er-diagram.png)

**Monitor**: live sessions, database and table sizes, index usage, cache hit ratio.

![Monitor](docs/screenshots/monitor.png)

**Light theme**

![Table workspace, light theme](docs/screenshots/table-workspace-light.png)

## Access requests

If your organisation hands out time-limited database access through an access-management
service, Lord of the Rows can request, track and use that access for you. The app talks to the
service through an **access provider**, a small adapter for a protocol. Supported provider
types appear in the **Add provider** picker. Today that is **Access API**, Lord of the Rows' own
documented protocol ([docs/access-api.md](docs/access-api.md)): any access-management service
that implements it works.

### Add a provider

1. Open the launcher's **Access** tab (next to **Connections**), or **Settings → Access**.
2. Click **Add provider** (or **+** next to the provider switcher, or **Add another provider**).
3. Fill in:
   - **Provider type**: the product your organisation uses.
   - **Display name**: anything, e.g. "Company access". It is shown in the switcher and used as
     the group name for connections created through it.
   - **URL**: the service's address, e.g. `https://access.example.com`. It must be `https://`;
     plain `http://` is accepted only for a server on this computer (local testing).
4. **Sign in to <name>**. Your browser opens the provider's own sign-in (for example your
   company single sign-on) and hands control back to the app; "Waiting for browser…" can be
   cancelled and times out after 5 minutes. The session token is kept only in the OS keychain;
   it is never shown, logged, or written to disk.

You can add several providers; switch between them at the top of the Access tab. Each keeps
its own sign-in. **Sign out** ends the session at the provider.

### Request and connect

- **Request access**: pick a database (grouped by environment, searchable), read-only or
  read & write, the target databases, an optional ticket reference (e.g. `OPS-123`) and a
  reason. The request appears under **Pending** until it is approved.
- **My requests** has three tabs with live counts:
  **Active** (ready first, soonest-expiring at the top, then provisioning and pending),
  **Pending** (waiting for approval), and **History** (expired, revoked, rejected, cancelled,
  failed). Search (⌘F) and environment chips filter every tab. Click a request's name for its
  timeline, the provider's provisioning log and the connection details (never the password).
- **Connect / Open**: once a request is ready, the app fetches the password **once**, stores it
  in the keychain like any saved connection, creates the connection (environment, read-only for
  read access) and opens it. Opening it again reuses the stored password. If the provider limits
  how often a password can be revealed, the app shows how many reveals are left and asks before
  using the last ones.
- **Expiry**: managed connections show a key badge and the time left; the workspace status bar
  counts down, and banners warn 15 and 5 minutes before the end. When access ends or is revoked,
  running queries are cancelled, the connection closes behind an "Access ended" screen (your tabs
  and SQL are kept), and the stored password is wiped. **Request again** pre-fills a new request.
- **Approvals** (only for approvers, and only if the provider supports it): **Waiting** requests
  with Approve, Reject (with a reason) and Approve-selected; **Decided** lists your past decisions.
  The Dock badge shows how many requests are waiting.

Connections go directly to the database host (for example over your VPN); no tunnel is created.
Commands for all of this are in the palette (⌘K): "Request access…", "Show access requests",
"Show approvals".

### Rolling out to a team

**Preconfigured providers.** An organisation can deploy a `providers.json` that the app reads at
start-up (for example with device management), so nobody has to type a URL:

| Where | File |
|---|---|
| macOS, all users | `/Library/Application Support/Lord of the Rows/providers.json` |
| Linux, all users | `/etc/lord-of-the-rows/providers.json` |
| Windows, all users | `%ProgramData%\Lord of the Rows\providers.json` |
| One user | `providers.json` in the app's data folder |

```json
[{ "kind": "access-api", "name": "Company access", "url": "https://access.example.com" }]
```

`kind` is a provider type from the **Add provider** picker (`access-api` for the Access API). Entries are validated like providers
added in the app and merged by URL; the system-wide file wins. They are shown as "Managed by your
organization" and can't be edited or removed in the app. Invalid entries are skipped (logged).

**Links.** `lordoftherows://access?provider=<url-encoded provider URL>&request=<request id>`
opens the Access tab on that provider and shows the request (with Connect if it is ready). An
access-management service can put this link on its request pages. A link to a provider that
isn't set up asks before adding it (add `&kind=<type>` to pick the type); links never sign in or
connect by themselves. The scheme is registered by the installed app (macOS bundle; Linux and
Windows at start-up).

### Adding a new provider type

Providers live in `crates/dbs-access/src/providers/`; `providers/access_api/` (the Access API
client) is the reference implementation. Adding one is a single module plus one registry entry; the screens, filters, polling, keychain handling and expiry rules are shared and
need no changes.

1. Create `providers/<name>/` and implement the `AccessProvider` trait
   (`crates/dbs-access/src/lib.rs`):

   | Method | Required | Purpose |
   |---|---|---|
   | `kind`, `capabilities` | yes | identifier and the optional features below |
   | `sign_in`, `sign_out`, `current_user` | yes | authentication (browser sign-in via the loopback helper in `loopback.rs`, an API token, …) |
   | `list_resources` | yes | requestable databases, with environment and engine |
   | `resource_targets` | if `targets` | the databases on one of them (otherwise users type names) |
   | `create_request`, `list_requests`, `get_request` | yes | request and poll |
   | `cancel_request` | if `cancel` | withdraw a pending request |
   | `list_approvals`, `approve`, `reject` | if `approvals` | the Approvals tab |
   | `list_decided` | if `decided_history` | the Decided tab (cursor-paged) |
   | `connection_plan`, `fetch_credentials` | yes | host, port, user, database; then the secret, fetched once |

2. Map the product's states onto the neutral `RequestStatus` values (`Pending`, `Provisioning`,
   `Ready`, `Failed`, `Rejected`, `Expired`, `Revoked`, `Cancelled`): the tabs are built from
   these. Map HTTP errors onto `AccessError` (a 401 must become `SignedOut`; transient failures
   must not, so users are not signed out by a hiccup).
3. Set `Capabilities` honestly: tabs and buttons for features a provider lacks are hidden.
4. Register the type in `providers/mod.rs` (`provider_kinds` and `build_provider`).
5. Test it against a mock HTTP server (see the tests in `providers/access_api/`), and the shared rules against
   `testing.rs`'s in-memory provider.

## Layout

```
crates/dbs-core      types, driver trait, dialect quoting, parameterised SQL builders
crates/dbs-drivers   postgres, mysql, sqlite, redis, dynamodb
crates/dbs-safety    SQL lexer/classifier, safety policy, confirmation tokens
crates/dbs-audit     hash-chained audit log
crates/dbs-store     local app metadata (SQLite)
crates/dbs-secrets   OS keychain
crates/dbs-ssh       SSH tunnels
crates/dbs-io        import/export
crates/dbs-schema    schema diff, migrations, designer DDL
crates/dbs-ai        optional AI assistant: prompt builders, redaction, provider clients
crates/dbs-access    access providers (trait, Access API client, browser sign-in, connect/expiry rules)
src-tauri/           desktop shell + IPC commands
frontend/            React UI
e2e/                 WebDriver end-to-end tests (real app + real databases)
```

## Develop (Docker only; no local Rust/Node needed)

```sh
docker compose build dev
docker compose up -d postgres mysql redis sshd dynamodb
docker compose run --rm dev cargo test --workspace          # Rust unit + integration
docker compose run --rm -w /work/frontend dev npx vitest run # frontend unit
docker compose run --rm dev sh -c 'cd frontend && npx vite build && cd .. && cargo build -p dbstudio --features custom-protocol && e2e/run.sh'
docker compose up -d desktop   # preview the Linux build: http://localhost:6080/vnc.html?autoconnect=1&resize=scale
```

Test credentials (throwaway, local containers only): Postgres/MySQL `dbs_test`/`dbs_test` db `dbs_test`
(hosts `postgres`, `mysql`), Redis `redis:6379`, SSH bastion `sshd` user `tunnel`/`tunnelpw`,
DynamoDB Local endpoint `http://dynamodb:8000` (host: `http://127.0.0.1:58000`), region `us-east-1`, any alphanumeric
access key ID (e.g. `dbstest`) with any secret.

See [TEST_RESULTS.md](TEST_RESULTS.md), [SECURITY_FINDINGS.md](SECURITY_FINDINGS.md).
