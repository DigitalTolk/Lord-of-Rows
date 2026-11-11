# Feature matrix

Status values: `TESTED` (automated tests pass), `IMPLEMENTED_UNVERIFIED` (code exists, no automated test yet),
`IN_PROGRESS`, `NOT_STARTED`, `BLOCKED`. "E2E" = WebDriver test driving the real app + real databases
(`e2e/`); "IT" = Rust integration test against real servers; "UT" = unit test.
Test platform for everything below: **Linux (Debian bookworm, arm64) in Docker**. macOS and Windows are
**not yet tested** (see BLOCKERS.md).

## Database engines

| Engine | Driver | Status | Evidence |
|---|---|---|---|
| PostgreSQL 16 | `pg` (tokio-postgres) | TESTED | IT `postgres_end_to_end`, E2E (connect, browse, query, edit, conflicts, TLS, SSH) |
| CockroachDB / YugabyteDB / Redshift / Greenplum | `pg` (wire-compatible) | IMPLEMENTED_UNVERIFIED | no server in test matrix yet |
| MySQL 8.4 | `mysql` (mysql_async) | TESTED | IT `mysql_end_to_end`, E2E |
| MariaDB / Percona / SingleStore | `mysql` (wire-compatible) | IMPLEMENTED_UNVERIFIED | no server in test matrix yet |
| SQLite 3.5x | `sqlite` (rusqlite, bundled) | TESTED | IT `sqlite_end_to_end`, E2E |
| Redis 7 | `redis` | TESTED | IT `redis_end_to_end`, E2E |
| SQL Server, Oracle, MongoDB, Cassandra, DynamoDB, Elasticsearch, ClickHouse, BigQuery, Snowflake, Cloudflare D1, Vertica, DuckDB, libSQL, Turso | — | NOT_STARTED | shown as "coming soon" (disabled) in the UI |

## Connections & security

| Feature | Status | Evidence |
|---|---|---|
| Connection CRUD, duplicate, favorites, groups, search, reorder | TESTED (create/save/connect via E2E); others IMPLEMENTED_UNVERIFIED | E2E `connections` |
| Passwords in OS keychain (Secret Service on Linux) | TESTED on Linux | E2E (saved → reconnect after restart) |
| macOS Keychain / Windows Credential Manager | IMPLEMENTED_UNVERIFIED | needs native runs |
| Connection URL import (password split out to keychain) | TESTED | UT `url_parsing...`, E2E MySQL/SQLite/Redis via URL |
| TLS verify-full / verify-ca / custom CA / client certs | TESTED (verify-full + CA, untrusted-cert rejection) | IT postgres TLS, E2E production over TLS |
| Plaintext refused for remote production | TESTED | UT `rejects_plaintext_remote_production`, E2E |
| SSH tunnel: password, private key, encrypted key, agent | TESTED (agent: IMPLEMENTED_UNVERIFIED) | IT `dbs-ssh/tests/tunnel.rs` (6), E2E `15-ssh` (4) |
| SSH strict host-key checking (unknown→confirm, changed→refuse) | TESTED | IT `changed_host_key_is_refused`, E2E decline/trust |
| SSH jump hosts (multi-hop) | TESTED | IT `jump_host_chain` |
| TLS through SSH with hostname verification (Postgres) | TESTED | IT `pg_tls_verified_through_tunnel` |
| Kerberos / LDAP / Entra / IAM / OAuth auth | NOT_STARTED | |

## Workspace & UI

| Feature | Status | Evidence |
|---|---|---|
| Launcher, engine picker, connection form | TESTED | E2E |
| Connection rail (multiple DBs), per-connection tabs | TESTED | E2E `connection rail…` |
| Object tree (tables/views/functions/sequences/enums/triggers) + context menu | TESTED (tree), menu IMPLEMENTED_UNVERIFIED | E2E |
| Active schema = default for SQL (`search_path` / `USE`) | TESTED | IT + E2E schema switch |
| Monaco SQL editor, autocomplete, format, run current/selection/all | TESTED (run/all); others IMPLEMENTED_UNVERIFIED | E2E |
| Query cancel, timeouts | TESTED | IT + E2E cancel |
| Multiple result sets, messages, notices, SQLSTATE errors | TESTED | E2E |
| Virtualized grid, PK-ordered paging, sort, filters | TESTED (paging); sort/filter IMPLEMENTED_UNVERIFIED (backend UT) | E2E, UT `page_query_is_parameterised` |
| Staged edits, SQL review, commit, optimistic-concurrency conflicts | TESTED | E2E edit/commit/conflict, IT `crud_scenario` |
| Structure view + designer (DDL preview, reversibility) | TESTED (view), designer UT | E2E Structure/DDL, UT `dbs-schema` |
| Schema diff & migrations | IMPLEMENTED_UNVERIFIED in UI; engine TESTED | UT `dbs-schema` (7) |
| ER diagram | TESTED | E2E |
| Monitor (sessions, sizes, locks) | TESTED (PG) | E2E |
| Dashboards / charts | IMPLEMENTED_UNVERIFIED | |
| Command palette | TESTED | E2E |
| Session restore (tabs re-attach) | TESTED | E2E `after restart…` |
| Themes (light/dark/high contrast), UI scale | TESTED (dark) | E2E |
| Import CSV/TSV/JSON/JSONL, export CSV/TSV/JSON/JSONL/SQL/XLSX/MD/XML | engine TESTED, UI IMPLEMENTED_UNVERIFIED | UT `dbs-io` (13); native file dialogs not drivable by WebDriver |
| Backup/restore (pg_dump, mysqldump, SQLite backup API) | SQLite TESTED (IT); pg_dump/mysqldump IMPLEMENTED_UNVERIFIED | IT `sqlite_end_to_end` |

## Safety & audit

| Feature | Status | Evidence |
|---|---|---|
| Backend SQL classifier (DML/DDL/destructive/admin/unknown, writable CTEs, EXPLAIN ANALYZE) | TESTED | UT `dbs-safety` (23 incl. fuzz) |
| Production policy: confirm writes, typed name for destructive, token bound to exact SQL | TESTED | UT + E2E production safety |
| Read-only: DB-enforced session + backend block | TESTED | IT (PG/MySQL/SQLite) + E2E |
| Tamper-evident audit log (hash chain), viewer, verify, export, purge | TESTED | UT `dbs-audit`, E2E audit |

## Plugins (spec §24)

Tested natively on macOS arm64 (`cargo test -p dbs-plugins`), not in the Docker matrix yet.

| Feature | Status | Evidence |
|---|---|---|
| Wasm sandbox (wasmtime/Pulley interpreter, no imports/WASI, fresh instance per call) | TESTED | UT `dbs-plugins` (imports rejected, echo, example plugin) |
| CPU (fuel) and memory limits; trap/OOB pointer/bad UTF-8 contained | TESTED | UT infinite loop, memory hog, OOB pointers, trap |
| Manifest validation (id, semver, API version, capabilities, settings), compatibility check | TESTED | UT `manifest_validation`, `compatibility_check` |
| `.dbsplugin` zip validation (traversal, extra/duplicate entries, size caps, zip bomb) | TESTED | UT `zip_path_traversal…`, `oversized_entries_rejected` |
| ed25519 signatures (verified fingerprint vs unsigned; tamper/escalation detected) | TESTED | UT `signature_verifies_and_detects_tampering` |
| Capability gating (declared **and** granted) | TESTED | UT `capability_gating` |
| Registry (store migration v2), install/upgrade/remove, grants, enable/disable, settings, audit | IMPLEMENTED_UNVERIFIED | UT `plugin_registry` for the store only; Tauri commands not exercised by E2E yet |
| Settings → Plugins UI, "Format with <plugin>", "Export with plugin…" | IMPLEMENTED_UNVERIFIED | vitest for menu filtering only; not driven by E2E yet |
| Example plugin `examples/plugins/uppercase-keywords` | TESTED | UT `example_plugin_formats_sql` |
| `read_schema` capability | IMPLEMENTED_UNVERIFIED | runtime + gating only; no UI entry point yet |

## Not started (spec items)

AI assistant, auto-updater, signed installers (macOS DMG/notarization, Windows MSI/MSIX),
CI pipelines, localization beyond English (architecture in place), accessibility audit with assistive tech.
