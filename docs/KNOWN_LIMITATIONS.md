# Known limitations

- **Engines:** PostgreSQL, MySQL, MariaDB, SQLite and Redis are tested. Wire-compatible engines (CockroachDB, YugabyteDB, Redshift, Greenplum, Percona, SingleStore) are untested. Other engines are not implemented.
- **Builds:** Linux (Docker) and macOS (local, unsigned) only. No Windows build. Unsigned macOS apps need right-click → Open (or `xattr -cr`) the first time if downloaded.
- **SSH:** host certificates are not supported (plain host keys only); agent auth is Unix-only; all jump hosts share the same user/auth.
- **TLS through SSH:** Postgres keeps full hostname verification; for MySQL/MariaDB/Redis TLS through a tunnel is refused (the tunnel already encrypts).
- **Grid:** row-level edits need a primary key; tables without one are read-only in the grid (use SQL).
- **Large results:** results are capped (default 10,000 rows, configurable); rows beyond the cap are drained, not stored.
- **Audit log:** local and tamper-evident, not tamper-proof; it does not replace server-side auditing.
- **Backups:** pg_dump/mysqldump require client tools on PATH; SQL exports are logical, not physical backups.
- **Not implemented:** plugins, AI assistant, auto-updater, multiple windows/split panes. Localisation: en, de, es, ar (AI-produced translations, not yet reviewed by native speakers); the connection dialog is still English-only.
