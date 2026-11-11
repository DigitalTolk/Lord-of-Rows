# Test results

Latest full run: 2026-11-11, Linux (Debian bookworm arm64) in Docker; Rust 1.99.1, Node 22.23.
Servers: PostgreSQL 16.15 (TLS on, test CA), MySQL 8.4, Redis 7.4, SQLite 3.5x, OpenSSH (bastion).

| Suite | Command | Result |
|---|---|---|
| Rust unit + integration (all crates) | `docker compose run --rm dev cargo test --workspace` | **96 passed, 0 failed** |
| Clippy (`-D warnings`), rustfmt | `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| Frontend unit (vitest) | `npx vitest run` | **15 passed** |
| ESLint (0 warnings), TypeScript strict | `npx eslint src --max-warnings 0`, `npx tsc -b` | clean |
| End-to-end (WebDriver → real app → real DBs) | `docker compose run --rm dev e2e/run.sh` | **34 passed, 0 failed** |

## End-to-end coverage (34)

- Launcher; create/test/save Postgres connection; wrong password (no echo); connect & schema auto-select
- Open table, paging (PK order), Structure + DDL
- SQL tab: unqualified names via active schema; schema switch changes resolution; multi-statement + messages;
  SQLSTATE errors; exact bigint/numeric/JSON/NULL vs ''; cancel 30 s query; EXPLAIN
- Edit cell → reviewed SQL → commit → verified in DB; stale edit → conflict, nothing overwritten
- Production: plaintext refused; verified TLS; banner; typed confirmation; cancel runs nothing; read-only blocks writes
- MySQL / SQLite / Redis via URL; connection rail + per-connection tabs
- Command palette, ER diagram, monitor, audit chain verify, dark theme
- SSH: unknown host key → confirm → tunnel; decline → no connection; production via SSH; known host no prompt; wrong SSH password
- Restart: saved connections persist; restored query tab re-attaches and runs

## Integration coverage highlights

- Drivers (`crates/dbs-drivers/tests/integration.rs`): CRUD + conflicts, type fidelity, cancel, timeout,
  read-only enforced by the DB, auth errors, TLS untrusted-cert rejection + verified TLS, schema switching.
- SSH (`crates/dbs-ssh/tests/tunnel.rs`): host-key trust/decline/changed, password/key/encrypted-key auth,
  jump hosts, timeout, Postgres TLS verified through the tunnel.

## Not covered by automation

Native file dialogs (import/export/backup UI), macOS/Windows runs, screen-reader testing, performance budgets.
