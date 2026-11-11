# User guide

## Connect
1. **Create a new connection** → pick an engine → fill *Host/IP* (or switch the label to *Socket*), *Port*, *User*,
   *Password*, *Database* → **Test** → **Connect**. Or paste a URL (e.g. `postgresql://user:pass@host:5432/db?sslmode=require`;
   `sslmode` / `ssl-mode` and libpq's `sslrootcert`, `sslcert`, `sslkey` are understood).
2. **Tag** = environment. *Production* shows a red banner and requires confirmation for writes and the connection name
   typed for destructive statements. **Safe mode → Read-only** is enforced by the database session. *Status color*
   tints the connection in the launcher.
3. **Password:** *Store in keychain* saves it in the OS credential store; *Ask every time* saves nothing and you are
   prompted when connecting.
4. **Bootstrap commands:** statements run after every connect (same safety policy as your own SQL).
5. **SSL mode** (all network engines, including Redis):

   | Mode | Encrypted | Certificate checked | Hostname checked | Notes |
   |---|---|---|---|---|
   | **PREFERRED** (default) | if the server supports it | no | no | Falls back to plaintext when the server has no TLS |
   | **DISABLED** | no | – | – | Plaintext |
   | **REQUIRED** | yes | no | no | Protects against eavesdropping, not against an active man-in-the-middle |
   | **VERIFY-CA** | yes | yes (system trust or *CA Cert…*) | no | |
   | **VERIFY-IDENTITY** | yes | yes | yes | Most secure; use for anything that matters |

   *SSL keys*: **Key…**, **Cert…**, **CA Cert…** pick files with the native file dialog; only the path is stored (files are
   read at connect time), **—** clears them. MySQL client certificates must be PKCS#12 (.p12/.pfx). Redis supports the
   system trust store only, and new Redis connections start at DISABLED (a plaintext Redis doesn't answer
   a TLS hello, so PREFERRED would wait ~3 s for its probe to time out before falling back).

   **Production rule:** a *Production* connection to a non-local host is refused with DISABLED or PREFERRED (PREFERRED may
   silently fall back to plaintext) unless it goes *Over SSH*. REQUIRED / VERIFY-CA are allowed but VERIFY-IDENTITY is
   recommended.
6. **Over SSH** (bottom bar): enter the bastion and auth. On first connect you'll be shown the server's SHA-256
   fingerprint; confirm only if it matches what your admin gave you. Through a tunnel, PREFERRED means "no extra TLS"
   (the tunnel encrypts). PostgreSQL keeps full hostname verification through the tunnel; MySQL/MariaDB/Redis connect
   to the tunnel's local end, so VERIFY-IDENTITY is refused there (use VERIFY-CA or REQUIRED).
7. **Other options** / **⌄**: connect and query timeouts, group, tags, notes.
8. macOS: if a LAN database fails with *No route to host*, use **Open Local Network Settings** in the error and allow
   Lord of the Rows.

## Work
- **Connection rail** (far left): one icon per open database; click to switch (`Ctrl/⌘+1…9`). Each keeps its tabs.
- **Sidebar:** choose the schema (it also becomes the default for SQL), filter objects, right-click for SELECT/INSERT/DDL.
- **SQL:** `+` in the tab bar or `Ctrl/⌘+T`. `Ctrl/⌘+Enter` runs selection/current statement; *Run all* runs everything.
  Results: Grid / JSON / Text / Record / Chart; *Messages* shows notices and affected rows.
- **Edit data:** double-click a cell, add/delete rows → **Commit…** shows the exact SQL → **Commit** runs it in one
  transaction. If someone changed the row meanwhile, nothing is overwritten and you're told.
- **Structure / Data** switch at the bottom of a table tab. **ER diagram**, **Monitor**, **Audit log**, **Settings** in the toolbar.
- **Command palette:** `Ctrl/⌘+K` — open tables, connections, tools.

## Shortcuts
`⌘/Ctrl+K` open database · `⌘/Ctrl+P` (or `⌘/Ctrl+Shift+P`) palette · `⌘/Ctrl+T` new query · `⌘/Ctrl+W` close tab · `⌘/Ctrl+Shift+T` reopen · `⌘/Ctrl+Enter` run ·
`⌘/Ctrl+Shift+Enter` run all · `⌘/Ctrl+.` cancel · `⌘/Ctrl+S` review changes · `⌘/Ctrl+Z` undo edit · `⌘/Ctrl+B` sidebar
