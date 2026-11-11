# Threat model (STRIDE, summary)

**Assets:** database credentials (passwords, SSH secrets, keys), database contents, ability to execute SQL on
production, audit trail integrity, local files.

**Trust boundaries:** (1) webview ↔ Rust (IPC), (2) app ↔ database / SSH servers (network), (3) app ↔ local
filesystem & OS keychain, (4) imported files (untrusted input).

| Threat | Boundary | Mitigation | Verified by |
|---|---|---|---|
| Credential disclosure in logs/errors/exports | 1,3 | Secrets only in keychain; `redact_secrets` on errors; exports omit secrets; secrets never sent to webview after save | UT redaction, E2E no-echo |
| MITM on DB connection | 2 | TLS verify-full default; plaintext refused for remote production; hostname verified even through SSH (Postgres) | IT TLS, E2E |
| MITM on SSH | 2 | Strict host-key checking, explicit fingerprint approval, changed key refused | IT + E2E |
| Accidental destructive SQL on production | 1 | Rust-side classifier + policy; typed confirmation; token bound to exact SQL; DB-enforced read-only sessions | UT + E2E |
| Classifier bypass (procedures, dynamic SQL, functions) | 1 | Unknown/dynamic treated as risky; read-only mode enforced by DB session; least-privilege accounts recommended | UT |
| SQL injection via app-generated SQL | 2 | Parameters for values; dialect-correct identifier quoting | UT |
| Lost updates when editing | 2 | Original values in WHERE; zero-row update = conflict → rollback | E2E |
| XSS / renderer compromise | 1 | Strict CSP, no remote content, navigation guard, React escaping, no innerHTML (lint rule), dompurify patched | lint, audit |
| Arbitrary file read/write via IPC | 1,3 | No path arguments from webview; grants issued by backend dialogs | code review |
| Malicious import files | 4 | Size caps, cell caps, encoding checks, no formula execution; CSV formula-injection guard on export | UT |
| Audit tampering | 3 | Hash chain + verify; anchor kept on purge. Limitation: full rewrite by a local admin is undetectable without external forwarding | UT + E2E |
| Supply chain | — | cargo-audit, cargo-deny, npm audit, osv-scanner, pinned lockfiles | CI |

Residual risks: see SECURITY_FINDINGS.md (SF-004, SF-005) and KNOWN_LIMITATIONS.md.
