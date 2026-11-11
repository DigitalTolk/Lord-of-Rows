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

## AI assistant (optional, off by default)

| Feature | Status | Evidence |
|---|---|---|
| Disabled by default; backend refuses when `ai.enabled` is off | TESTED (UT) | UT `dbs-ai` `disabled_by_default_and_refuses` |
| Prompt builders (explain/generate/optimize SQL, errors, plans, indexes, schema summary) with only user-approved context | TESTED (UT) | UT `dbs-ai` prompt tests (8) |
| Secret + literal redaction (toggle, default on) | TESTED (UT) | UT `dbs-ai` redact tests (4) |
| Preview token binds exact prompt + endpoint (no send without preview) | TESTED (UT, vitest) | UT `guard_binds_prompt_task_and_endpoint`, vitest `AiPanel` |
| Anthropic + OpenAI-compatible clients (key only in auth header, no redirects, clear errors) | TESTED against local mock HTTP server | UT `dbs-ai` provider tests (6); **no real provider call made** |
| AI panel in query tab, Settings → AI, API key in OS keychain, test connection, `ai_request` audit event | IMPLEMENTED_UNVERIFIED | typecheck/lint + vitest only; no E2E, not run against a live provider or keychain |

## Application updates

| Feature | Status | Evidence |
|---|---|---|
| Endpoint validation (https only; http loopback in dev builds), channel → endpoint resolution, no hardcoded URL | TESTED | UT `updater::tests` (endpoint/channel/setting validation) |
| Compatibility check: reject non-newer manifest versions; stable rejects pre-releases | TESTED | UT `only_newer_versions_are_accepted...` |
| Minisign signature check with shipped pubkey; tampered artifact / altered signed version / foreign key rejected | TESTED (at the minisign layer, mirroring the plugin's check) | UT `shipped_pubkey_verifies_release_signatures_and_rejects_tampering`, `shipped_updater_config_keeps_verification_strict` |
| Auto-check on startup is opt-in (no network when off) | TESTED | vitest `updates.test.ts` |
| Check now / release notes / download progress / install / restart prompt / failure recovery / `app_updated` audit events | IMPLEMENTED_UNVERIFIED | no end-to-end run against a real signed release + update server yet |

## Localisation & accessibility

| Feature | Status | Evidence |
|---|---|---|
| UI strings in `src/i18n/en.json` (i18next plurals, no hardcoded English in views/components) | TESTED (UT) except connection dialog | vitest `locales.test.ts` (every en key referenced from source). `ConnectionDialog.tsx` still has ~25 hardcoded labels (being redesigned on another branch) |
| German, Spanish, Arabic translations; key/plural-form/placeholder parity with English | TESTED (UT) | vitest `locales.test.ts` (per locale: missing, extra, empty, placeholders; CLDR plural categories via `Intl.PluralRules`). Translations are AI-produced and not yet reviewed by native speakers |
| Language picker (System default + each language), persisted, `<html lang dir>` sync | TESTED (UT) | vitest `locales.test.ts` (system mapping), `a11y.test.tsx` (`dir=rtl`/`lang=ar`) |
| RTL layout (Arabic) with logical Tailwind utilities; Monaco, data grid, SQL/JSON blocks pinned LTR | IMPLEMENTED_UNVERIFIED | axe passes in Arabic (jsdom, no layout); not yet looked at in the real webview |
| Locale-aware numbers/dates/bytes (`Intl`, active language) | TESTED (UT) | vitest `format.test.ts` (en/de/es); not every call site is covered |
| Automated a11y: axe-core (serious/critical) on launcher, connection dialog, shell + query tab, every Settings section, confirm + safety dialogs, command palette, Arabic | TESTED (jsdom) | vitest `a11y.test.tsx`; colour contrast via token tests in `theme.test.ts` (axe contrast cannot run in jsdom) |
| Keyboard: tree (`role=tree`, arrows), tab bar (roving tabindex, arrows, Delete), rail (arrows), context menus (Shift+F10), dialog focus trap + focus return, keyboard sidebar resize | TESTED (UT) | vitest `a11y.test.tsx` keyboard suite; see `docs/ACCESSIBILITY.md` |
| Screen reader (VoiceOver/NVDA) | NOT_STARTED | manual checklist in `docs/ACCESSIBILITY.md` |

## Not started (spec items)

Plugin system, signed installers (macOS DMG/notarization, Windows MSI/MSIX),
CI pipelines, accessibility audit with assistive tech (manual screen-reader pass).
