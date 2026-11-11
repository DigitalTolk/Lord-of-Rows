# Changelog

## Unreleased
- Import connections from other database tools (TablePlus, DBeaver, Sequel Ace / Sequel Pro, pgAdmin, DataGrip) or a list of connection URLs, with a preview, duplicate detection, groups and environment tags kept, and optional import of TablePlus passwords from the macOS Keychain.

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
