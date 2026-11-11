# Changelog

## Unreleased
- Redis key browser: logical databases (db0, db1, …) as schemas with key counts (sidebar, schema rail, Open database picker); a lazily expanded namespace tree (configurable separator, bounded SCAN batches with "Load more"); a SCAN-paged key grid (key, type, TTL, size, value preview) with a server-side Key pattern; values by type (string/JSON, hash, list, set, sorted set, stream, JSON documents) paged in the detail panel; staged key edits (set, TTL, rename, delete, field/member add/remove) previewed as commands and committed through the safety policy. `KEYS` is never used.

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
