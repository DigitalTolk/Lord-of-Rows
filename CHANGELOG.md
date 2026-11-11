# Changelog

## Unreleased
- Access requests: request time-limited database access from an access-management provider without leaving the app. Add a provider (first one: passhub), sign in through the browser (single sign-on, PKCE + loopback redirect; the session token stays in the OS keychain), pick a database grouped by environment, choose read-only or read & write and the databases, give a reason, and follow the request (waiting for your manager → provisioning with a live log → ready). **Connect** fetches the password once into the keychain and opens the connection; later connects reuse it. Approvers get an Approvals inbox (approve / reject with a reason). Saved connections show a key badge with the time left, warn 15 minutes before the access ends, and when it ends (or the request is revoked) the password is wiped and the connection is marked "Expired — request again". Providers plug in through a provider-neutral interface (`crates/dbs-access`).

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
