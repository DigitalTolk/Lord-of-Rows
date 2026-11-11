# Known limitations

- **Engines:** PostgreSQL, MySQL, MariaDB, SQLite, Redis and DynamoDB (against DynamoDB Local) are tested. Wire-compatible engines (CockroachDB, YugabyteDB, Redshift, Greenplum, Percona, SingleStore) are untested. Other engines are not implemented.
- **Builds:** Linux (Docker) and macOS (local, unsigned) only. No Windows build. Unsigned macOS apps need right-click → Open (or `xattr -cr`) the first time if downloaded.
- **SSH:** host certificates are not supported (plain host keys only); agent auth is Unix-only; all jump hosts share the same user/auth.
- **TLS through SSH:** Postgres keeps full hostname verification; for MySQL/MariaDB/Redis TLS through a tunnel is refused (the tunnel already encrypts).
- **DynamoDB:**
  - The query editor runs PartiQL (`ExecuteStatement`), one call per statement; BEGIN/COMMIT and EXPLAIN are not available. Grid edits are committed atomically with `TransactWriteItems` (max 100 changes per commit) and carry conditions on the originally loaded values, so concurrent changes are reported as conflicts.
  - Browsing is a `Scan`: it consumes read capacity proportional to the data read, has no server-side sort (column sorting is disabled), and filters are applied after reading (`FilterExpression`), so a selective filter can still read the whole table. Continuation keys are cached per (table, filters), so paging forward is one Scan per page; jumping far ahead scans everything before it. `ends with` filters are not supported.
  - Row counts are exact `Scan(Select=COUNT)` up to a budget (200 pages / 15 s); beyond that the grid shows DynamoDB's `ItemCount` estimate (refreshed by AWS about every 6 hours), labelled as an estimate.
  - Items are schemaless: grid columns are the key attributes plus attributes seen in loaded pages; a missing attribute and a NULL attribute both show as NULL. Setting a cell to NULL removes the attribute. Key attributes cannot be edited (delete and re-insert). Exports use the attribute set of the first 5,000 items.
  - Numbers (`N`) are exact (decimal text). Inside maps/lists, numbers that are not exactly representable as JSON numbers are shown as strings and would be written back as strings if that map/list is edited. Binary inside maps/lists is shown as `\x…` text.
  - No SSH tunnels; use an endpoint URL. Credentials: access key + secret (keychain), `profile:NAME`, or the default AWS chain. Session tokens (STS temporary keys) can only be supplied through a profile or the environment.
- **Grid:** row-level edits need a primary key; tables without one are read-only in the grid (use SQL).
- **Large results:** results are capped (default 10,000 rows, configurable); rows beyond the cap are drained, not stored.
- **Audit log:** local and tamper-evident, not tamper-proof; it does not replace server-side auditing.
- **Backups:** pg_dump/mysqldump require client tools on PATH; SQL exports are logical, not physical backups.
- **Localisation:** en, de, es, ar (AI-produced translations, not yet reviewed by native speakers).
- **Not implemented:** reordering tabs or connection groups by keyboard drag; a text alternative for the ER diagram (see docs/ACCESSIBILITY.md).
