# Changelog

## Unreleased
- Access requests: request time-limited database access from an access-management service without leaving the app. The app speaks its own documented, product-neutral **Access API** ([docs/access-api.md](docs/access-api.md)), so any service that implements it works. Add a provider, sign in through the browser (single sign-on, PKCE + loopback redirect; the session token stays in the OS keychain), pick a database grouped by environment, choose read-only or read & write and the databases, give a reason, and follow the request (waiting for your manager → provisioning with a live log → ready). **Connect** fetches the password once into the keychain and opens the connection; later connects reuse it. Approvers get an Approvals inbox (approve / reject with a reason). Saved connections show a key badge with the time left, warn 15 minutes before the access ends, and when it ends (or the request is revoked) the password is wiped and the connection is marked "Expired — request again". Providers plug in through a provider-neutral interface (`crates/dbs-access`).
- Access requests, continued: Active / Pending / History filters with search and environment chips; an Approvals "Decided" tab; a request detail drawer (timeline, provisioning log, reveals left, copyable connection details); optional ticket references; one-click "Request again"; expiry banners in the workspace (15 and 5 minutes) and a graceful "Access ended" state that keeps your tabs; a Dock badge, "Review" toasts and multi-select approve for approvers; command palette entries; preconfigured providers (`providers.json`) and `lordoftherows://access` links for company rollout.
- Import: saved passwords from another app's keychain (TablePlus) are no longer read during import, which made macOS ask once per connection. Each is read the first time you connect to that connection (one prompt), then kept in this app's keychain. Bringing passwords along is now on by default.
- Connection list: select several connections and delete them in one go — ⌘A in the list selects all shown, ⌘-click / ⇧-click pick several or a range, the right-click menu has Select / Select all, and the bottom-bar Delete (or the selection toolbar) deletes the selection after one confirmation that counts production connections.

- Fix: MySQL/MariaDB with SSL mode PREFERRED now falls back to an unencrypted connection when the TLS handshake fails (e.g. a server that only speaks TLS 1.0/1.1), matching MySQL's own definition of the mode. REQUIRED and VERIFY modes never fall back.

- Connection rail: every open connection shows its environment tag (LOCAL, DEV, STAGING, PROD…); production connections also get a red outline, so it is always clear where queries run.

- Connection form: tagging a remote connection Production raises SSL mode PREFERRED/DISABLED to REQUIRED automatically (with a note) instead of blocking the form; a stronger mode you picked is kept.

## 0.1.2
- Redis key browser: logical databases (db0, db1, …) as schemas with key counts (sidebar, schema rail, Open database picker); a lazily expanded namespace tree (configurable separator, bounded SCAN batches with "Load more"); a SCAN-paged key grid (key, type, TTL, size, value preview) with a server-side Key pattern; values by type (string/JSON, hash, list, set, sorted set, stream, JSON documents) paged in the detail panel; staged key edits (set, TTL, rename, delete, field/member add/remove) previewed as commands and committed through the safety policy. `KEYS` is never used.
- Import connections from other database tools (TablePlus, DBeaver, Sequel Ace / Sequel Pro, pgAdmin, DataGrip) or a list of connection URLs, with a preview, duplicate detection, groups and environment tags kept, and optional import of TablePlus passwords from the macOS Keychain.
- Fix: after Stop or a timeout on MySQL/MariaDB, the next query could fail with "Query execution was interrupted".
- Fix: the pending-changes preview stayed open (showing the previous tab's statements) after switching tabs.

## 0.1.1
- Fix: drag and drop inside the app (moving connections into groups, reordering tabs) did not work on macOS.

## 0.1.0
- Drivers: PostgreSQL, MySQL, MariaDB, SQLite, Redis.
- Desktop UI with a familiar workflow: launcher, connection rail, per-connection tabs, SQL editor, grid, structure, ER, monitor, palette.
- Staged editing with SQL review and conflict detection; PK-ordered paging.
- Production safe mode (Rust-enforced), read-only sessions, tamper-evident audit log.
- TLS verification (custom CA), SSH tunnels with strict host keys and jump hosts.
- Import/export (CSV, TSV, JSON, JSONL, SQL, XLSX, Markdown, XML), schema diff & migrations, backups.
- Tests: 97 Rust, 15 frontend, 35 end-to-end (WebDriver, real databases).
