# Security findings

Self-assessment with automated tools; **not** an independent penetration test.

| ID | Severity | Finding | Status | Evidence / fix |
|---|---|---|---|---|
| SF-001 | Medium | Bundled SQLite (libsqlite3-sys 0.30) affected by CVE (RUSTSEC-2026-0459) | Fixed | Upgraded rusqlite 0.32 → 0.41 (libsqlite3-sys 0.39); `cargo audit`: 0 vulnerabilities |
| SF-002 | Critical (advisory) | `dompurify` (runtime dep of monaco-editor) XSS advisories | Fixed | npm `overrides` → dompurify ^3.4.17; `npm audit`: 0 |
| SF-003 | Moderate (dev only) | `minimatch` ReDoS in lint toolchain | Fixed | override to ^11.0.1 for typescript-estree |
| SF-004 | Info | Unmaintained/unsound transitive crates on Linux only (gtk-rs `glib`, `proc-macro-error`, `zbus`/`zvariant` via Secret Service) | Accepted (tracked) | Listed in `deny.toml` with reasons; not used in a way that triggers the unsoundness |
| SF-005 | Low | Tauri `freezePrototype` disabled (breaks bundled Monaco) | Accepted | Mitigated by strict CSP (no remote scripts, no eval), navigation guard, no remote content |
| SF-006 | — | Credential leakage in errors | Mitigated | `redact_secrets` on all error text; E2E asserts wrong DB/SSH passwords are never echoed |
| SF-007 | — | SQL injection via identifiers/values in app-generated SQL | Mitigated | All generated SQL parameterised; identifiers quoted per dialect; UT injection cases |
| SF-008 | — | MITM on SSH | Mitigated | Strict host-key verification; changed keys refused even with approval (IT + E2E) |
| SF-009 | — | MITM on DB TLS | Mitigated | verify-full default; untrusted certs rejected (IT); hostname kept through SSH tunnels |
| SF-010 | — | Arbitrary file read/write from a compromised webview | Mitigated | Webview never sends paths: files only via backend-opened native dialogs returning opaque grants |

Tool runs (latest): `cargo audit` 0 vulnerabilities · `cargo deny` advisories/licenses/sources ok ·
`npm audit` 0 · gitleaks 0 leaks · semgrep (rust, typescript, react, secrets, owasp-top-ten) 0 findings ·
osv-scanner: only SF-004 items.

Not yet done: CodeQL, Trivy/Syft SBOM, fuzzing beyond the lexer, plugin sandbox review (no plugins yet),
update-integrity tests (no updater yet), external penetration test.
