//! Local application metadata in SQLite: connection definitions (no secrets),
//! snippets, query history, settings, workspace state, and saved documents
//! (ER layouts, dashboards). Versioned migrations run on open.

use std::path::Path;
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use dbs_core::{ConnectionConfig, DbError, DbResult, ErrorKind};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

fn e(err: rusqlite::Error) -> DbError {
    DbError::new(ErrorKind::Io, format!("app store: {err}"))
}

const MIGRATIONS: &[&str] = &[
    // v1
    "CREATE TABLE connections (id TEXT PRIMARY KEY, body TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
        last_used TEXT, created TEXT NOT NULL);
     CREATE TABLE snippets (id TEXT PRIMARY KEY, name TEXT NOT NULL, sql TEXT NOT NULL, folder TEXT,
        favorite INTEGER NOT NULL DEFAULT 0, connection_id TEXT, updated TEXT NOT NULL);
     CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, connection_id TEXT NOT NULL, ts TEXT NOT NULL,
        sql TEXT, duration_ms INTEGER, rows INTEGER, ok INTEGER NOT NULL, error TEXT);
     CREATE INDEX history_conn ON history(connection_id, id);
     CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
     CREATE TABLE documents (kind TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL,
        updated TEXT NOT NULL, PRIMARY KEY(kind, id));",
    // v2: installed plugins (the wasm itself lives in the app data dir)
    "CREATE TABLE plugins (id TEXT PRIMARY KEY, version TEXT NOT NULL, manifest TEXT NOT NULL, signer TEXT NOT NULL,
        wasm_sha256 TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, grants TEXT NOT NULL DEFAULT '[]',
        settings TEXT NOT NULL DEFAULT '{}', last_error TEXT, installed TEXT NOT NULL, updated TEXT NOT NULL);",
    // v3: connection-list groups. Membership stays in each connection's `group` field;
    // this table holds per-group metadata (display order, colour, collapsed state).
    // Backfilled from the groups already named on saved connections.
    "CREATE TABLE connection_groups (name TEXT PRIMARY KEY, color TEXT, collapsed INTEGER NOT NULL DEFAULT 0,
        sort INTEGER NOT NULL DEFAULT 0);
     INSERT OR IGNORE INTO connection_groups(name, sort)
        SELECT g, ROW_NUMBER() OVER (ORDER BY g) - 1 FROM
        (SELECT DISTINCT trim(json_extract(body, '$.group')) AS g FROM connections
         WHERE json_valid(body) AND trim(coalesce(json_extract(body, '$.group'), '')) <> '');",
    // v4: passwords an imported connection still has in another app's keychain,
    // read (one OS prompt each) the first time the connection is used.
    "CREATE TABLE deferred_secrets (connection_id TEXT NOT NULL, kind TEXT NOT NULL, service TEXT NOT NULL,
        account TEXT NOT NULL, PRIMARY KEY(connection_id, kind));",
];

/// A reference to a secret another application keeps in the OS keychain.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeferredSecret {
    pub kind: String,
    pub service: String,
    pub account: String,
}

pub struct AppStore {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoredConnection {
    pub config: ConnectionConfig,
    pub last_used: Option<String>,
    pub sort: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub sql: String,
    pub folder: Option<String>,
    pub favorite: bool,
    pub connection_id: Option<String>,
    pub updated: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistoryEntry {
    pub id: i64,
    pub connection_id: String,
    pub ts: String,
    pub sql: Option<String>,
    pub duration_ms: Option<i64>,
    pub rows: Option<i64>,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Document {
    pub kind: String,
    pub id: String,
    pub name: String,
    pub body: serde_json::Value,
    pub updated: String,
}

/// Registry row for an installed plugin. `manifest`/`signer` are opaque JSON
/// owned by `dbs-plugins`; `grants` are capability names the user approved.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PluginRecord {
    pub id: String,
    pub version: String,
    pub manifest: serde_json::Value,
    pub signer: serde_json::Value,
    pub wasm_sha256: String,
    pub enabled: bool,
    pub grants: Vec<String>,
    pub settings: serde_json::Value,
    /// Set when the plugin failed at run time (it is then disabled).
    pub last_error: Option<String>,
    pub installed: String,
    pub updated: String,
}

/// Metadata for a named group in the connection list. Connections reference a
/// group by name (`ConnectionConfig::group`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConnectionGroup {
    pub name: String,
    /// CSS hex colour (`#rgb` / `#rrggbb`), or none for the default.
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub sort: i64,
}

const GROUP_NAME_ERR: &str = "group name must be 1-100 characters without control characters";

/// Trim and validate a group name; empty means "no group".
fn group_name(name: &str) -> DbResult<Option<String>> {
    let n = name.trim();
    if n.is_empty() {
        return Ok(None);
    }
    if n.chars().count() > 100 || n.chars().any(char::is_control) {
        return Err(DbError::invalid(GROUP_NAME_ERR));
    }
    Ok(Some(n.to_string()))
}

fn valid_color(c: &str) -> bool {
    let h = c.strip_prefix('#').unwrap_or("");
    matches!(h.len(), 3 | 6) && h.chars().all(|x| x.is_ascii_hexdigit())
}

/// Rewrite the `group` of every connection currently in group `from`.
fn regroup(tx: &rusqlite::Transaction<'_>, from: &str, to: Option<&str>) -> DbResult<usize> {
    let rows: Vec<(String, String)> = {
        let mut st = tx.prepare("SELECT id, body FROM connections").map_err(e)?;
        let it = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
        it.collect::<Result<_, _>>().map_err(e)?
    };
    let mut n = 0;
    for (id, body) in rows {
        let Ok(mut cfg) = serde_json::from_str::<ConnectionConfig>(&body) else { continue };
        if cfg.group.as_deref().map(str::trim) != Some(from) {
            continue;
        }
        cfg.group = to.map(str::to_string);
        let body = serde_json::to_string(&cfg).map_err(|x| DbError::internal(x.to_string()))?;
        tx.execute("UPDATE connections SET body = ?1 WHERE id = ?2", params![body, id]).map_err(e)?;
        n += 1;
    }
    Ok(n)
}

/// Create the group (appended after the existing ones) if it doesn't exist.
fn ensure_group(c: &Connection, name: &str) -> DbResult<()> {
    c.execute("INSERT OR IGNORE INTO connection_groups(name, sort) VALUES(?1, (SELECT coalesce(max(sort), -1) + 1 FROM connection_groups))", [name])
        .map_err(e)?;
    Ok(())
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl AppStore {
    pub fn open(path: &Path) -> DbResult<Self> {
        Self::init(Connection::open(path).map_err(e)?)
    }
    pub fn open_in_memory() -> DbResult<Self> {
        Self::init(Connection::open_in_memory().map_err(e)?)
    }

    fn init(mut c: Connection) -> DbResult<Self> {
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;").map_err(e)?;
        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(e)?;
        for (i, m) in MIGRATIONS.iter().enumerate().skip(v as usize) {
            let tx = c.transaction().map_err(e)?;
            tx.execute_batch(m).map_err(e)?;
            tx.pragma_update(None, "user_version", (i + 1) as i64).map_err(e)?;
            tx.commit().map_err(e)?;
        }
        Ok(Self { conn: Mutex::new(c) })
    }

    // ---- connections ----
    /// Saves a connection. Its group name is trimmed (empty = ungrouped) and the
    /// group is created, appended at the end, if it is new.
    pub fn save_connection(&self, cfg: &ConnectionConfig) -> DbResult<()> {
        cfg.validate()?;
        let mut cfg = cfg.clone();
        cfg.group = group_name(cfg.group.as_deref().unwrap_or(""))?;
        let body = serde_json::to_string(&cfg).map_err(|x| DbError::internal(x.to_string()))?;
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction().map_err(e)?;
        tx.execute(
            "INSERT INTO connections(id, body, created) VALUES(?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET body = excluded.body",
            params![cfg.id.to_string(), body, now()],
        )
        .map_err(e)?;
        if let Some(g) = &cfg.group {
            ensure_group(&tx, g)?;
        }
        tx.commit().map_err(e)
    }

    pub fn get_connection(&self, id: Uuid) -> DbResult<ConnectionConfig> {
        let body: Option<String> =
            self.conn.lock().unwrap().query_row("SELECT body FROM connections WHERE id = ?1", [id.to_string()], |r| r.get(0)).optional().map_err(e)?;
        let body = body.ok_or_else(|| DbError::new(ErrorKind::NotFound, "connection not found"))?;
        serde_json::from_str(&body).map_err(|x| DbError::internal(x.to_string()))
    }

    pub fn list_connections(&self) -> DbResult<Vec<StoredConnection>> {
        let c = self.conn.lock().unwrap();
        let mut st = c.prepare("SELECT body, last_used, sort FROM connections ORDER BY sort, created").map_err(e)?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, i64>(2)?))).map_err(e)?;
        let mut out = Vec::new();
        for row in rows {
            let (body, last_used, sort) = row.map_err(e)?;
            match serde_json::from_str(&body) {
                Ok(config) => out.push(StoredConnection { config, last_used, sort }),
                Err(_) => continue, // skip unreadable rows rather than failing the whole list
            }
        }
        Ok(out)
    }

    pub fn delete_connection(&self, id: Uuid) -> DbResult<bool> {
        let c = self.conn.lock().unwrap();
        let n = c.execute("DELETE FROM connections WHERE id = ?1", [id.to_string()]).map_err(e)?;
        c.execute("DELETE FROM deferred_secrets WHERE connection_id = ?1", [id.to_string()]).map_err(e)?;
        Ok(n > 0)
    }

    pub fn touch_connection(&self, id: Uuid) -> DbResult<()> {
        self.conn.lock().unwrap().execute("UPDATE connections SET last_used = ?1 WHERE id = ?2", params![now(), id.to_string()]).map_err(e)?;
        Ok(())
    }

    pub fn reorder_connections(&self, ids: &[Uuid]) -> DbResult<()> {
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction().map_err(e)?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute("UPDATE connections SET sort = ?1 WHERE id = ?2", params![i as i64, id.to_string()]).map_err(e)?;
        }
        tx.commit().map_err(e)
    }

    // ---- connection groups ----
    pub fn list_groups(&self) -> DbResult<Vec<ConnectionGroup>> {
        let c = self.conn.lock().unwrap();
        let mut st = c.prepare("SELECT name, color, collapsed, sort FROM connection_groups ORDER BY sort, name").map_err(e)?;
        let it =
            st.query_map([], |r| Ok(ConnectionGroup { name: r.get(0)?, color: r.get(1)?, collapsed: r.get::<_, i64>(2)? != 0, sort: r.get(3)? })).map_err(e)?;
        it.collect::<Result<_, _>>().map_err(e)
    }

    /// Creates a group (appended at the end) or updates its colour / collapsed
    /// state. `sort` changes only through [`Self::reorder_groups`].
    pub fn save_group(&self, g: &ConnectionGroup) -> DbResult<ConnectionGroup> {
        let name = group_name(&g.name)?.ok_or_else(|| DbError::invalid(GROUP_NAME_ERR))?;
        let color = g.color.as_deref().map(str::trim).filter(|c| !c.is_empty());
        if color.is_some_and(|c| !valid_color(c)) {
            return Err(DbError::invalid("group colour must be a hex colour like #3b82f6"));
        }
        {
            let mut c = self.conn.lock().unwrap();
            let tx = c.transaction().map_err(e)?;
            ensure_group(&tx, &name)?;
            tx.execute("UPDATE connection_groups SET color = ?1, collapsed = ?2 WHERE name = ?3", params![color, g.collapsed as i64, name]).map_err(e)?;
            tx.commit().map_err(e)?;
        }
        self.list_groups()?.into_iter().find(|x| x.name == name).ok_or_else(|| DbError::internal("group vanished"))
    }

    /// Renames a group and moves its connections along. Fails if `to` already exists.
    pub fn rename_group(&self, from: &str, to: &str) -> DbResult<()> {
        let from = from.trim();
        let to = group_name(to)?.ok_or_else(|| DbError::invalid(GROUP_NAME_ERR))?;
        if from == to {
            return Ok(());
        }
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction().map_err(e)?;
        let exists = |n: &str| tx.query_row("SELECT 1 FROM connection_groups WHERE name = ?1", [n], |_| Ok(())).optional().map(|x| x.is_some()).map_err(e);
        if !exists(from)? {
            return Err(DbError::new(ErrorKind::NotFound, "group not found"));
        }
        if exists(&to)? {
            return Err(DbError::invalid(format!("a group named \"{to}\" already exists")));
        }
        tx.execute("UPDATE connection_groups SET name = ?1 WHERE name = ?2", params![to, from]).map_err(e)?;
        regroup(&tx, from, Some(&to))?;
        tx.commit().map_err(e)
    }

    /// Deletes a group; its connections become ungrouped. Returns how many moved.
    pub fn delete_group(&self, name: &str) -> DbResult<usize> {
        let name = name.trim();
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction().map_err(e)?;
        tx.execute("DELETE FROM connection_groups WHERE name = ?1", [name]).map_err(e)?;
        let n = regroup(&tx, name, None)?;
        tx.commit().map_err(e)?;
        Ok(n)
    }

    /// Sets the display order of groups; groups not listed follow, in their previous order.
    pub fn reorder_groups(&self, names: &[String]) -> DbResult<()> {
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction().map_err(e)?;
        tx.execute("UPDATE connection_groups SET sort = sort + ?1", [names.len() as i64]).map_err(e)?;
        for (i, n) in names.iter().enumerate() {
            tx.execute("UPDATE connection_groups SET sort = ?1 WHERE name = ?2", params![i as i64, n.trim()]).map_err(e)?;
        }
        tx.commit().map_err(e)
    }

    /// Moves one connection into `group` (created if new), or out of any group
    /// when `group` is `None` or blank.
    pub fn set_connection_group(&self, id: Uuid, group: Option<&str>) -> DbResult<ConnectionConfig> {
        let mut cfg = self.get_connection(id)?;
        cfg.group = group_name(group.unwrap_or(""))?;
        self.save_connection(&cfg)?;
        Ok(cfg)
    }

    // ---- snippets ----
    pub fn save_snippet(&self, mut s: Snippet) -> DbResult<Snippet> {
        if s.name.trim().is_empty() {
            return Err(DbError::invalid("snippet name required"));
        }
        if s.id.is_empty() {
            s.id = Uuid::new_v4().to_string();
        }
        s.updated = now();
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO snippets(id,name,sql,folder,favorite,connection_id,updated) VALUES(?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name, sql=excluded.sql, folder=excluded.folder,
                 favorite=excluded.favorite, connection_id=excluded.connection_id, updated=excluded.updated",
                params![s.id, s.name, s.sql, s.folder, s.favorite, s.connection_id, s.updated],
            )
            .map_err(e)?;
        Ok(s)
    }

    pub fn list_snippets(&self) -> DbResult<Vec<Snippet>> {
        let c = self.conn.lock().unwrap();
        let mut st = c.prepare("SELECT id,name,sql,folder,favorite,connection_id,updated FROM snippets ORDER BY favorite DESC, name").map_err(e)?;
        let rows = st
            .query_map([], |r| {
                Ok(Snippet {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    sql: r.get(2)?,
                    folder: r.get(3)?,
                    favorite: r.get(4)?,
                    connection_id: r.get(5)?,
                    updated: r.get(6)?,
                })
            })
            .map_err(e)?;
        rows.collect::<Result<_, _>>().map_err(e)
    }

    pub fn delete_snippet(&self, id: &str) -> DbResult<()> {
        self.conn.lock().unwrap().execute("DELETE FROM snippets WHERE id=?1", [id]).map_err(e)?;
        Ok(())
    }

    // ---- history ----
    /// `sql` is `None` unless the user's privacy setting allows storing query text.
    pub fn add_history(&self, h: &HistoryEntry, keep_last: u32) -> DbResult<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO history(connection_id, ts, sql, duration_ms, rows, ok, error) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![h.connection_id, now(), h.sql, h.duration_ms, h.rows, h.ok, h.error],
        )
        .map_err(e)?;
        c.execute(
            "DELETE FROM history WHERE connection_id=?1 AND id NOT IN
             (SELECT id FROM history WHERE connection_id=?1 ORDER BY id DESC LIMIT ?2)",
            params![h.connection_id, keep_last],
        )
        .map_err(e)?;
        Ok(())
    }

    pub fn list_history(&self, connection_id: &str, limit: u32) -> DbResult<Vec<HistoryEntry>> {
        let c = self.conn.lock().unwrap();
        let mut st =
            c.prepare("SELECT id,connection_id,ts,sql,duration_ms,rows,ok,error FROM history WHERE connection_id=?1 ORDER BY id DESC LIMIT ?2").map_err(e)?;
        let rows = st
            .query_map(params![connection_id, limit], |r| {
                Ok(HistoryEntry {
                    id: r.get(0)?,
                    connection_id: r.get(1)?,
                    ts: r.get(2)?,
                    sql: r.get(3)?,
                    duration_ms: r.get(4)?,
                    rows: r.get(5)?,
                    ok: r.get(6)?,
                    error: r.get(7)?,
                })
            })
            .map_err(e)?;
        rows.collect::<Result<_, _>>().map_err(e)
    }

    pub fn clear_history(&self, connection_id: Option<&str>) -> DbResult<()> {
        let c = self.conn.lock().unwrap();
        match connection_id {
            Some(id) => c.execute("DELETE FROM history WHERE connection_id=?1", [id]),
            None => c.execute("DELETE FROM history", []),
        }
        .map_err(e)?;
        let _ = c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
        Ok(())
    }

    // ---- deferred (not yet imported) keychain secrets ----
    /// Replaces the connection's deferred secret references.
    pub fn set_deferred_secrets(&self, id: Uuid, items: &[DeferredSecret]) -> DbResult<()> {
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction().map_err(e)?;
        tx.execute("DELETE FROM deferred_secrets WHERE connection_id=?1", [id.to_string()]).map_err(e)?;
        for d in items {
            tx.execute(
                "INSERT OR REPLACE INTO deferred_secrets(connection_id, kind, service, account) VALUES(?1,?2,?3,?4)",
                params![id.to_string(), d.kind, d.service, d.account],
            )
            .map_err(e)?;
        }
        tx.commit().map_err(e)
    }

    pub fn deferred_secret(&self, id: Uuid, kind: &str) -> DbResult<Option<DeferredSecret>> {
        self.conn
            .lock()
            .unwrap()
            .query_row("SELECT kind, service, account FROM deferred_secrets WHERE connection_id=?1 AND kind=?2", params![id.to_string(), kind], |r| {
                Ok(DeferredSecret { kind: r.get(0)?, service: r.get(1)?, account: r.get(2)? })
            })
            .optional()
            .map_err(e)
    }

    pub fn delete_deferred_secret(&self, id: Uuid, kind: &str) -> DbResult<()> {
        self.conn.lock().unwrap().execute("DELETE FROM deferred_secrets WHERE connection_id=?1 AND kind=?2", params![id.to_string(), kind]).map_err(e)?;
        Ok(())
    }

    // ---- settings ----
    pub fn get_setting(&self, k: &str) -> DbResult<Option<serde_json::Value>> {
        let v: Option<String> = self.conn.lock().unwrap().query_row("SELECT v FROM settings WHERE k=?1", [k], |r| r.get(0)).optional().map_err(e)?;
        Ok(v.and_then(|s| serde_json::from_str(&s).ok()))
    }

    pub fn set_setting(&self, k: &str, v: &serde_json::Value) -> DbResult<()> {
        if k.is_empty() || k.len() > 200 {
            return Err(DbError::invalid("invalid setting key"));
        }
        self.conn
            .lock()
            .unwrap()
            .execute("INSERT INTO settings(k,v) VALUES(?1,?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v", params![k, v.to_string()])
            .map_err(e)?;
        Ok(())
    }

    pub fn all_settings(&self) -> DbResult<serde_json::Map<String, serde_json::Value>> {
        let c = self.conn.lock().unwrap();
        let mut st = c.prepare("SELECT k, v FROM settings").map_err(e)?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e)?;
        let mut m = serde_json::Map::new();
        for row in rows {
            let (k, v) = row.map_err(e)?;
            if let Ok(v) = serde_json::from_str(&v) {
                m.insert(k, v);
            }
        }
        Ok(m)
    }

    pub fn reset_settings(&self) -> DbResult<()> {
        self.conn.lock().unwrap().execute("DELETE FROM settings", []).map_err(e)?;
        Ok(())
    }

    // ---- documents (ER layouts, dashboards, workspaces, saved queries) ----
    pub fn save_document(&self, kind: &str, id: &str, name: &str, body: &serde_json::Value) -> DbResult<()> {
        if !matches!(kind, "er_layout" | "dashboard" | "workspace" | "keymap" | "theme") {
            return Err(DbError::invalid("unknown document kind"));
        }
        let s = body.to_string();
        if s.len() > 8 * 1024 * 1024 {
            return Err(DbError::invalid("document too large"));
        }
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO documents(kind,id,name,body,updated) VALUES(?1,?2,?3,?4,?5)
                 ON CONFLICT(kind,id) DO UPDATE SET name=excluded.name, body=excluded.body, updated=excluded.updated",
                params![kind, id, name, s, now()],
            )
            .map_err(e)?;
        Ok(())
    }

    pub fn list_documents(&self, kind: &str) -> DbResult<Vec<Document>> {
        let c = self.conn.lock().unwrap();
        let mut st = c.prepare("SELECT kind,id,name,body,updated FROM documents WHERE kind=?1 ORDER BY name").map_err(e)?;
        let rows = st
            .query_map([kind], |r| {
                let body: String = r.get(3)?;
                Ok(Document {
                    kind: r.get(0)?,
                    id: r.get(1)?,
                    name: r.get(2)?,
                    body: serde_json::from_str(&body).unwrap_or(serde_json::Value::Null),
                    updated: r.get(4)?,
                })
            })
            .map_err(e)?;
        rows.collect::<Result<_, _>>().map_err(e)
    }

    pub fn delete_document(&self, kind: &str, id: &str) -> DbResult<()> {
        self.conn.lock().unwrap().execute("DELETE FROM documents WHERE kind=?1 AND id=?2", [kind, id]).map_err(e)?;
        Ok(())
    }
}

impl AppStore {
    // ---- plugins ----
    pub fn save_plugin(&self, p: &PluginRecord) -> DbResult<PluginRecord> {
        let mut p = p.clone();
        p.updated = now();
        if p.installed.is_empty() {
            p.installed = p.updated.clone();
        }
        let js = |v: &serde_json::Value| v.to_string();
        let grants = serde_json::to_string(&p.grants).map_err(|x| DbError::internal(x.to_string()))?;
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO plugins(id,version,manifest,signer,wasm_sha256,enabled,grants,settings,last_error,installed,updated)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
                 ON CONFLICT(id) DO UPDATE SET version=excluded.version, manifest=excluded.manifest, signer=excluded.signer,
                 wasm_sha256=excluded.wasm_sha256, enabled=excluded.enabled, grants=excluded.grants, settings=excluded.settings,
                 last_error=excluded.last_error, updated=excluded.updated",
                params![
                    p.id,
                    p.version,
                    js(&p.manifest),
                    js(&p.signer),
                    p.wasm_sha256,
                    p.enabled,
                    grants,
                    js(&p.settings),
                    p.last_error,
                    p.installed,
                    p.updated
                ],
            )
            .map_err(e)?;
        Ok(p)
    }

    fn plugin_rows(&self, id: Option<&str>) -> DbResult<Vec<PluginRecord>> {
        let c = self.conn.lock().unwrap();
        let mut st = c
            .prepare("SELECT id,version,manifest,signer,wasm_sha256,enabled,grants,settings,last_error,installed,updated FROM plugins WHERE ?1 IS NULL OR id=?1 ORDER BY id")
            .map_err(e)?;
        let json = |s: String| serde_json::from_str(&s).unwrap_or(serde_json::Value::Null);
        let rows = st
            .query_map([id], |r| {
                Ok(PluginRecord {
                    id: r.get(0)?,
                    version: r.get(1)?,
                    manifest: json(r.get(2)?),
                    signer: json(r.get(3)?),
                    wasm_sha256: r.get(4)?,
                    enabled: r.get(5)?,
                    grants: serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or_default(),
                    settings: json(r.get(7)?),
                    last_error: r.get(8)?,
                    installed: r.get(9)?,
                    updated: r.get(10)?,
                })
            })
            .map_err(e)?;
        rows.collect::<Result<_, _>>().map_err(e)
    }

    pub fn list_plugins(&self) -> DbResult<Vec<PluginRecord>> {
        self.plugin_rows(None)
    }

    pub fn get_plugin(&self, id: &str) -> DbResult<PluginRecord> {
        self.plugin_rows(Some(id))?.pop().ok_or_else(|| DbError::new(ErrorKind::NotFound, "plugin is not installed"))
    }

    pub fn delete_plugin(&self, id: &str) -> DbResult<bool> {
        Ok(self.conn.lock().unwrap().execute("DELETE FROM plugins WHERE id=?1", [id]).map_err(e)? > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbs_core::*;

    fn cfg(name: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: Uuid::new_v4(),
            name: name.into(),
            engine: Engine::Sqlite,
            host: None,
            port: None,
            database: Some("/tmp/x.db".into()),
            username: None,
            socket_path: None,
            tls: TlsConfig::default(),
            ssh: None,
            environment: EnvironmentKind::Local,
            read_only: false,
            color: None,
            group: None,
            tags: vec![],
            notes: None,
            favorite: false,
            connect_timeout_secs: 10,
            query_timeout_secs: None,
            init_sql: None,
            key_separator: None,
            managed_by: None,
            tunnel: None,
        }
    }

    #[test]
    fn connections_crud_and_reorder() {
        let s = AppStore::open_in_memory().unwrap();
        let a = cfg("a");
        let b = cfg("b");
        s.save_connection(&a).unwrap();
        s.save_connection(&b).unwrap();
        s.reorder_connections(&[b.id, a.id]).unwrap();
        let l = s.list_connections().unwrap();
        assert_eq!(l.iter().map(|c| c.config.name.as_str()).collect::<Vec<_>>(), ["b", "a"]);
        let mut a2 = a.clone();
        a2.name = "renamed".into();
        s.save_connection(&a2).unwrap();
        assert_eq!(s.get_connection(a.id).unwrap().name, "renamed");
        assert!(s.delete_connection(a.id).unwrap());
        assert!(s.get_connection(a.id).is_err());
    }

    fn grouped(name: &str, group: &str) -> ConnectionConfig {
        let mut c = cfg(name);
        c.group = Some(group.into());
        c
    }

    fn group_of(s: &AppStore, id: Uuid) -> Option<String> {
        s.get_connection(id).unwrap().group
    }

    #[test]
    fn groups_created_with_connections_and_ordered() {
        let s = AppStore::open_in_memory().unwrap();
        s.save_connection(&grouped("a", "  Work ")).unwrap();
        s.save_connection(&grouped("b", "Home")).unwrap();
        s.save_connection(&grouped("c", "Work")).unwrap();
        s.save_connection(&grouped("d", "   ")).unwrap();
        let names: Vec<_> = s.list_groups().unwrap().into_iter().map(|g| g.name).collect();
        assert_eq!(names, ["Work", "Home"], "trimmed, de-duplicated, in creation order; blank = ungrouped");
        let d = s.list_connections().unwrap().into_iter().find(|c| c.config.name == "d").unwrap();
        assert_eq!(d.config.group, None);
        s.reorder_groups(&["Home".into()]).unwrap();
        let names: Vec<_> = s.list_groups().unwrap().into_iter().map(|g| g.name).collect();
        assert_eq!(names, ["Home", "Work"]);
    }

    #[test]
    fn group_metadata_roundtrip_and_validation() {
        let s = AppStore::open_in_memory().unwrap();
        let g = s.save_group(&ConnectionGroup { name: "Prod".into(), color: Some("#ff0000".into()), collapsed: true, sort: 99 }).unwrap();
        assert_eq!(g, ConnectionGroup { name: "Prod".into(), color: Some("#ff0000".into()), collapsed: true, sort: 0 });
        let g2 = s.save_group(&ConnectionGroup { collapsed: false, color: None, ..g }).unwrap();
        assert!(!g2.collapsed && g2.color.is_none());
        assert!(s.save_group(&ConnectionGroup { name: " ".into(), color: None, collapsed: false, sort: 0 }).is_err());
        assert!(s.save_group(&ConnectionGroup { name: "x".into(), color: Some("red;}".into()), collapsed: false, sort: 0 }).is_err());
        assert!(s.save_group(&ConnectionGroup { name: "a\nb".into(), color: None, collapsed: false, sort: 0 }).is_err());
        assert!(s.save_group(&ConnectionGroup { name: "x".repeat(101), color: None, collapsed: false, sort: 0 }).is_err());
        assert_eq!(s.list_groups().unwrap().len(), 1);
    }

    #[test]
    fn rename_and_delete_group_move_connections() {
        let s = AppStore::open_in_memory().unwrap();
        let a = grouped("a", "Old");
        let b = grouped("b", "Old");
        let c = grouped("c", "Other");
        for x in [&a, &b, &c] {
            s.save_connection(x).unwrap();
        }
        s.save_group(&ConnectionGroup { name: "Old".into(), color: Some("#123".into()), collapsed: true, sort: 0 }).unwrap();
        assert!(s.rename_group("Old", "Other").is_err(), "no silent merge");
        assert!(s.rename_group("Missing", "X").is_err());
        s.rename_group("Old", "New").unwrap();
        assert_eq!(group_of(&s, a.id).as_deref(), Some("New"));
        assert_eq!(group_of(&s, b.id).as_deref(), Some("New"));
        assert_eq!(group_of(&s, c.id).as_deref(), Some("Other"));
        let g = s.list_groups().unwrap();
        assert_eq!(g[0], ConnectionGroup { name: "New".into(), color: Some("#123".into()), collapsed: true, sort: 0 }, "metadata kept");
        assert_eq!(s.delete_group("New").unwrap(), 2);
        assert_eq!(group_of(&s, a.id), None);
        assert_eq!(group_of(&s, b.id), None);
        assert_eq!(group_of(&s, c.id).as_deref(), Some("Other"));
        assert_eq!(s.list_groups().unwrap().into_iter().map(|g| g.name).collect::<Vec<_>>(), ["Other"]);
        assert_eq!(s.list_connections().unwrap().len(), 3, "deleting a group never deletes connections");
    }

    #[test]
    fn move_connection_between_groups() {
        let s = AppStore::open_in_memory().unwrap();
        let a = cfg("a");
        s.save_connection(&a).unwrap();
        assert_eq!(s.set_connection_group(a.id, Some("Team")).unwrap().group.as_deref(), Some("Team"));
        assert_eq!(s.list_groups().unwrap()[0].name, "Team");
        s.set_connection_group(a.id, None).unwrap();
        assert_eq!(group_of(&s, a.id), None);
        s.set_connection_group(a.id, Some("")).unwrap();
        assert_eq!(group_of(&s, a.id), None);
        assert!(s.set_connection_group(Uuid::new_v4(), Some("Team")).is_err());
    }

    #[test]
    fn v3_migration_backfills_groups_from_existing_connections() {
        let mut c = Connection::open_in_memory().unwrap();
        {
            let tx = c.transaction().unwrap();
            tx.execute_batch(MIGRATIONS[0]).unwrap();
            tx.execute_batch(MIGRATIONS[1]).unwrap();
            tx.pragma_update(None, "user_version", 2).unwrap();
            for (n, g) in [("a", Some("Zeta")), ("b", Some("Alpha")), ("c", None), ("d", Some("Zeta"))] {
                let mut x = cfg(n);
                x.group = g.map(Into::into);
                tx.execute("INSERT INTO connections(id, body, created) VALUES(?1, ?2, 'x')", params![x.id.to_string(), serde_json::to_string(&x).unwrap()])
                    .unwrap();
            }
            tx.execute("INSERT INTO connections(id, body, created) VALUES('bad', 'not json', 'x')", []).unwrap();
            tx.commit().unwrap();
        }
        let s = AppStore::init(c).unwrap();
        let g = s.list_groups().unwrap();
        assert_eq!(g.iter().map(|g| (g.name.as_str(), g.sort)).collect::<Vec<_>>(), [("Alpha", 0), ("Zeta", 1)]);
        assert_eq!(s.list_connections().unwrap().len(), 4);
    }

    #[test]
    fn invalid_connection_rejected() {
        let s = AppStore::open_in_memory().unwrap();
        let mut c = cfg("");
        c.name = "".into();
        assert!(s.save_connection(&c).is_err());
    }

    #[test]
    fn history_is_bounded() {
        let s = AppStore::open_in_memory().unwrap();
        for i in 0..20 {
            s.add_history(
                &HistoryEntry { id: 0, connection_id: "c".into(), ts: String::new(), sql: None, duration_ms: Some(i), rows: None, ok: true, error: None },
                5,
            )
            .unwrap();
        }
        let h = s.list_history("c", 100).unwrap();
        assert_eq!(h.len(), 5);
        assert_eq!(h[0].duration_ms, Some(19));
    }

    #[test]
    fn settings_and_documents() {
        let s = AppStore::open_in_memory().unwrap();
        s.set_setting("editor.fontSize", &serde_json::json!(14)).unwrap();
        assert_eq!(s.get_setting("editor.fontSize").unwrap(), Some(serde_json::json!(14)));
        s.save_document("dashboard", "d1", "Sales", &serde_json::json!({"widgets": []})).unwrap();
        assert_eq!(s.list_documents("dashboard").unwrap().len(), 1);
        assert!(s.save_document("evil", "x", "x", &serde_json::json!({})).is_err());
    }

    #[test]
    fn plugin_registry() {
        let s = AppStore::open_in_memory().unwrap();
        let rec = PluginRecord {
            id: "com.example.p".into(),
            version: "1.0.0".into(),
            manifest: serde_json::json!({"id": "com.example.p"}),
            signer: serde_json::json!({"kind": "unsigned"}),
            wasm_sha256: "ab".into(),
            enabled: false,
            grants: vec![],
            settings: serde_json::json!({}),
            last_error: None,
            installed: String::new(),
            updated: String::new(),
        };
        s.save_plugin(&rec).unwrap();
        let mut got = s.get_plugin("com.example.p").unwrap();
        assert!(!got.enabled && got.grants.is_empty() && !got.installed.is_empty());
        got.enabled = true;
        got.grants = vec!["format_sql".into()];
        s.save_plugin(&got).unwrap();
        assert_eq!(s.list_plugins().unwrap()[0].grants, ["format_sql"]);
        assert!(s.delete_plugin("com.example.p").unwrap());
        assert!(s.get_plugin("com.example.p").is_err());
    }
}
