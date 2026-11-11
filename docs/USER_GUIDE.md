# User guide

## Connect
1. **Create a new connection** → pick an engine → fill host/user/password/database → **Test** → **Connect**.
   Or **Connect from URL** with `postgresql://user:pass@host:5432/db?sslmode=disable`.
2. Pick an **environment**. *Production* shows a red banner and requires confirmation for writes and the
   connection name typed for destructive statements. **Read-only** is enforced by the database session.
3. **SSH tunnel:** tick *Connect through an SSH tunnel*, enter the bastion and auth. On first connect you'll be
   shown the server's SHA-256 fingerprint; confirm only if it matches what your admin gave you.

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
`⌘/Ctrl+K` palette · `⌘/Ctrl+T` new query · `⌘/Ctrl+W` close tab · `⌘/Ctrl+Shift+T` reopen · `⌘/Ctrl+Enter` run ·
`⌘/Ctrl+Shift+Enter` run all · `⌘/Ctrl+.` cancel · `⌘/Ctrl+S` review changes · `⌘/Ctrl+Z` undo edit · `⌘/Ctrl+B` sidebar
