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
];

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
    pub fn save_connection(&self, cfg: &ConnectionConfig) -> DbResult<()> {
        cfg.validate()?;
        let body = serde_json::to_string(cfg).map_err(|x| DbError::internal(x.to_string()))?;
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO connections(id, body, created) VALUES(?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET body = excluded.body",
                params![cfg.id.to_string(), body, now()],
            )
            .map_err(e)?;
        Ok(())
    }

    pub fn get_connection(&self, id: Uuid) -> DbResult<ConnectionConfig> {
        let body: Option<String> = self
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT body FROM connections WHERE id = ?1", [id.to_string()], |r| r.get(0))
            .optional()
            .map_err(e)?;
        let body = body.ok_or_else(|| DbError::new(ErrorKind::NotFound, "connection not found"))?;
        serde_json::from_str(&body).map_err(|x| DbError::internal(x.to_string()))
    }

    pub fn list_connections(&self) -> DbResult<Vec<StoredConnection>> {
        let c = self.conn.lock().unwrap();
        let mut st = c.prepare("SELECT body, last_used, sort FROM connections ORDER BY sort, created").map_err(e)?;
        let rows = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, i64>(2)?)))
            .map_err(e)?;
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
        let n = self.conn.lock().unwrap().execute("DELETE FROM connections WHERE id = ?1", [id.to_string()]).map_err(e)?;
        Ok(n > 0)
    }

    pub fn touch_connection(&self, id: Uuid) -> DbResult<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("UPDATE connections SET last_used = ?1 WHERE id = ?2", params![now(), id.to_string()])
            .map_err(e)?;
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
        let mut st = c
            .prepare("SELECT id,name,sql,folder,favorite,connection_id,updated FROM snippets ORDER BY favorite DESC, name")
            .map_err(e)?;
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
        let mut st = c
            .prepare("SELECT id,connection_id,ts,sql,duration_ms,rows,ok,error FROM history WHERE connection_id=?1 ORDER BY id DESC LIMIT ?2")
            .map_err(e)?;
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

    // ---- settings ----
    pub fn get_setting(&self, k: &str) -> DbResult<Option<serde_json::Value>> {
        let v: Option<String> = self
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT v FROM settings WHERE k=?1", [k], |r| r.get(0))
            .optional()
            .map_err(e)?;
        Ok(v.and_then(|s| serde_json::from_str(&s).ok()))
    }

    pub fn set_setting(&self, k: &str, v: &serde_json::Value) -> DbResult<()> {
        if k.is_empty() || k.len() > 200 {
            return Err(DbError::invalid("invalid setting key"));
        }
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO settings(k,v) VALUES(?1,?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                params![k, v.to_string()],
            )
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
}
