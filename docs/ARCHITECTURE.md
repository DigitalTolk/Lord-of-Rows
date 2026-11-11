# Architecture

```
┌──────────────────────────── Webview (React, TypeScript) ────────────────────────────┐
│ Launcher · Connection rail · Object tree · Tabs (Query/Table/Structure/ER/…)        │
│ Never holds secrets or file paths; renders only. Strict CSP, no remote content.     │
└───────────────────────────────▲─────────────────────────────────────────────────────┘
                                │ Tauri IPC (typed commands, args validated in Rust)
┌───────────────────────────────┴──────────── src-tauri (Rust) ───────────────────────┐
│ commands.rs: policy enforcement · audit · file grants · session registry           │
├────────────┬──────────────┬─────────────┬────────────┬────────────┬────────────────┤
│ dbs-safety │ dbs-audit    │ dbs-store   │ dbs-secrets│ dbs-ssh    │ dbs-io/schema  │
│ lexer,     │ hash-chained │ SQLite app  │ OS keychain│ tunnels,   │ import/export, │
│ classifier,│ audit log    │ metadata    │            │ host keys  │ diff/migrations│
│ policy     │              │             │            │            │                │
├────────────┴──────────────┴─────────────┴────────────┴────────────┴────────────────┤
│ dbs-core: Value, ResultSet, DatabaseDriver/Connection traits, dialect quoting,      │
│           parameterised SQL builders (CRUD, paging, filters)                        │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ dbs-drivers: postgres (tokio-postgres) · mysql/mariadb (mysql_async) · sqlite        │
│              (rusqlite, bundled) · redis · dynamodb (aws-sdk, PartiQL)              │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## Key decisions

| Decision | Why |
|---|---|
| Tauri 2 + Rust backend | Small binaries, OS webview, privileged work out of the renderer |
| One crate per concern | Testable without a GUI; security-critical code (safety, audit, ssh) isolated |
| Values cross IPC as tagged enums; bigints/decimals as strings | No precision loss through JS numbers; NULL ≠ '' |
| Safety policy evaluated in Rust; confirmation token = SHA-256(key, connection, exact SQL) | UI cannot bypass or reuse a confirmation for different SQL |
| Staged edits → parameterised UPDATE/DELETE including original values | Optimistic concurrency; remote changes become conflicts, never overwrites |
| File access via backend-opened dialogs returning opaque grants | A compromised webview cannot read/write arbitrary paths |
| App-managed SSH known_hosts with explicit fingerprint approval | No silent trust; changed keys refused |
| Selected schema sets `search_path` / `USE` | Unqualified SQL resolves against the schema chosen in the sidebar |
| Tests run against real servers in Docker; E2E via WebDriver | Verifies real behaviour, not mocks |

## Data flow: running SQL

1. Webview sends `evaluate_sql` → Rust lexes/classifies with the connection's dialect and policy.
2. If confirmation is needed, Rust returns a token; the UI shows findings; the user confirms (typed name for destructive on production).
3. Webview sends `run_sql` with token → Rust re-evaluates, verifies the token against the exact SQL, executes, audits, records history (text only if privacy setting allows).
