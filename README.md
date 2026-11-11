# Lord of the Rows

A desktop database client: Tauri 2 (Rust backend) + React/TypeScript.
Original code and artwork.

**Status:** working on Linux (tested in Docker). macOS/Windows builds and signing are not done yet;
see [FEATURE_MATRIX.md](FEATURE_MATRIX.md), [BLOCKERS.md](BLOCKERS.md).

## What works today

- PostgreSQL, MySQL, SQLite, Redis (plus wire-compatible engines, unverified)
- Connection launcher, engine picker, connection rail with per-database tabs
- SSH tunnels (password / key / passphrase / agent, jump hosts, strict host-key checks)
- SSL modes PREFERRED / DISABLED / REQUIRED / VERIFY-CA / VERIFY-IDENTITY (custom CA, client certs); plaintext-capable modes refused for remote production
- SQL editor (Monaco) with schema-aware completion; grid / JSON / text / record / chart results
- Inline editing with SQL review, single-transaction commit and conflict detection
- Structure view, table designer, schema diff → migrations (reversibility-aware)
- ER diagram, monitoring, dashboards, command palette, themes
- Production safe mode enforced in Rust; tamper-evident audit log; passwords in the OS keychain
- Optional AI assistant (off by default; prompt preview + explicit send; see [docs/AI_ASSISTANT.md](docs/AI_ASSISTANT.md))

## Layout

```
crates/dbs-core      types, driver trait, dialect quoting, parameterised SQL builders
crates/dbs-drivers   postgres, mysql, sqlite, redis
crates/dbs-safety    SQL lexer/classifier, safety policy, confirmation tokens
crates/dbs-audit     hash-chained audit log
crates/dbs-store     local app metadata (SQLite)
crates/dbs-secrets   OS keychain
crates/dbs-ssh       SSH tunnels
crates/dbs-io        import/export
crates/dbs-schema    schema diff, migrations, designer DDL
crates/dbs-ai        optional AI assistant: prompt builders, redaction, provider clients
src-tauri/           desktop shell + IPC commands
frontend/            React UI
e2e/                 WebDriver end-to-end tests (real app + real databases)
```

## Develop (Docker only; no local Rust/Node needed)

```sh
docker compose build dev
docker compose up -d postgres mysql redis sshd
docker compose run --rm dev cargo test --workspace          # Rust unit + integration
docker compose run --rm -w /work/frontend dev npx vitest run # frontend unit
docker compose run --rm dev sh -c 'cd frontend && npx vite build && cd .. && cargo build -p dbstudio --features custom-protocol && e2e/run.sh'
docker compose up -d desktop   # preview the Linux build: http://localhost:6080/vnc.html?autoconnect=1&resize=scale
```

Test credentials (throwaway, local containers only): Postgres/MySQL `dbs_test`/`dbs_test` db `dbs_test`
(hosts `postgres`, `mysql`), Redis `redis:6379`, SSH bastion `sshd` user `tunnel`/`tunnelpw`.

See [TEST_RESULTS.md](TEST_RESULTS.md), [SECURITY_FINDINGS.md](SECURITY_FINDINGS.md).
