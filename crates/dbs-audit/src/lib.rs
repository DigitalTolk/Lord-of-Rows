//! Local, tamper-evident application audit log.
//!
//! Each entry stores `hash = SHA-256(prev_hash || canonical_json(entry))`.
//! `verify()` recomputes the chain and reports the first broken link, so edits,
//! deletions in the middle, or reordering are detected.
//!
//! Limitations (documented in docs/AUDIT_LOGGING.md): an attacker with write
//! access to the file can rewrite the whole chain from the start, or truncate the
//! tail. Detecting that requires anchoring the head hash elsewhere (enterprise
//! forwarding, see `head()`), which is why forwarding is supported. This log
//! complements, and never replaces, server-side database auditing.
//!
//! Never logged: passwords, keys, tokens, connection strings, row data. Query
//! text is omitted by default (`QueryTextPolicy::Omit`).

use std::path::Path;
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use dbs_core::{redact_secrets, DbError, DbResult, ErrorKind};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    ConnectionCreated,
    ConnectionModified,
    ConnectionDeleted,
    ConnectionOpened,
    ConnectionFailed,
    CredentialChanged,
    CredentialDeleted,
    QueryExecuted,
    DdlExecuted,
    DmlExecuted,
    DataEdited,
    SafetyBlocked,
    SafetyConfirmed,
    Import,
    Export,
    Backup,
    Restore,
    PrivilegeChange,
    SessionKilled,
    SettingsChanged,
    SecurityPolicyChanged,
    PluginInstalled,
    PluginPermissionChanged,
    PluginRemoved,
    AppUpdated,
    AuditExported,
    AuditPurged,
    AiRequest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Success,
    Failure,
    Denied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum QueryTextPolicy {
    #[default]
    Omit,
    /// Store only the SHA-256 of the text (lets you correlate without storing it).
    Hash,
    /// Store redacted text (string literals replaced by '?').
    Redacted,
}

/// Input for a new audit event. Fields mirror the spec; all optional except category/outcome.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NewEvent {
    pub category: Option<Category>,
    pub outcome: Option<Outcome>,
    pub engine: Option<String>,
    pub connection_id: Option<String>,
    pub environment: Option<String>,
    pub object: Option<String>,
    pub duration_ms: Option<u64>,
    pub rows_affected: Option<u64>,
    pub session_id: Option<String>,
    pub error_kind: Option<ErrorKind>,
    pub statement_kinds: Option<Vec<String>>,
    /// Raw query text; transformed according to `QueryTextPolicy` before storage.
    #[serde(skip)]
    pub query_text: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditEntry {
    #[serde(default)]
    pub seq: i64,
    pub id: String,
    pub ts: String,
    pub category: Category,
    pub outcome: Outcome,
    pub app_version: String,
    pub engine: Option<String>,
    pub connection_id: Option<String>,
    pub environment: Option<String>,
    pub object: Option<String>,
    pub duration_ms: Option<u64>,
    pub rows_affected: Option<u64>,
    pub session_id: Option<String>,
    pub error_kind: Option<ErrorKind>,
    pub statement_kinds: Option<Vec<String>>,
    pub query: Option<String>,
    pub detail: Option<String>,
    #[serde(default)]
    pub prev_hash: String,
    #[serde(default)]
    pub hash: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AuditFilter {
    pub category: Option<Category>,
    pub outcome: Option<Outcome>,
    pub connection_id: Option<String>,
    pub text: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
    pub limit: Option<u32>,
    pub before_seq: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VerifyReport {
    pub entries: u64,
    pub ok: bool,
    pub first_bad_seq: Option<i64>,
    pub head_hash: String,
}

pub struct AuditLog {
    conn: Mutex<Connection>,
    app_version: String,
    pub query_policy: Mutex<QueryTextPolicy>,
}

const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn map_err(e: rusqlite::Error) -> DbError {
    DbError::new(ErrorKind::Io, format!("audit store: {e}"))
}

impl AuditLog {
    pub fn open(path: &Path, app_version: &str) -> DbResult<Self> {
        let c = Connection::open(path).map_err(map_err)?;
        Self::init(c, app_version)
    }

    pub fn open_in_memory(app_version: &str) -> DbResult<Self> {
        Self::init(Connection::open_in_memory().map_err(map_err)?, app_version)
    }

    fn init(c: Connection, app_version: &str) -> DbResult<Self> {
        c.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
             CREATE TABLE IF NOT EXISTS audit (
               seq INTEGER PRIMARY KEY AUTOINCREMENT,
               body TEXT NOT NULL,
               prev_hash TEXT NOT NULL,
               hash TEXT NOT NULL,
               ts TEXT NOT NULL,
               category TEXT NOT NULL,
               outcome TEXT NOT NULL,
               connection_id TEXT
             );
             CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
             CREATE INDEX IF NOT EXISTS audit_cat ON audit(category);
             CREATE TABLE IF NOT EXISTS audit_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);",
        )
        .map_err(map_err)?;
        Ok(Self { conn: Mutex::new(c), app_version: app_version.into(), query_policy: Mutex::new(QueryTextPolicy::Omit) })
    }

    fn transform_query(&self, q: &str) -> String {
        match *self.query_policy.lock().unwrap() {
            QueryTextPolicy::Omit => String::new(),
            QueryTextPolicy::Hash => format!("sha256:{}", hex::encode(Sha256::digest(q.as_bytes()))),
            QueryTextPolicy::Redacted => redact_literals(q),
        }
    }

    pub fn record(&self, ev: NewEvent) -> DbResult<AuditEntry> {
        let category = ev.category.ok_or_else(|| DbError::invalid("audit category required"))?;
        let outcome = ev.outcome.unwrap_or(Outcome::Success);
        let query = ev.query_text.as_deref().map(|q| self.transform_query(q)).filter(|s| !s.is_empty());
        let c = self.conn.lock().unwrap();
        let prev_hash: String = c
            .query_row("SELECT hash FROM audit ORDER BY seq DESC LIMIT 1", [], |r| r.get(0))
            .unwrap_or_else(|_| c.query_row("SELECT v FROM audit_meta WHERE k='anchor'", [], |r| r.get(0)).unwrap_or_else(|_| GENESIS.to_string()));
        let mut entry = AuditEntry {
            seq: 0,
            id: Uuid::new_v4().to_string(),
            ts: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            category,
            outcome,
            app_version: self.app_version.clone(),
            engine: ev.engine,
            connection_id: ev.connection_id,
            environment: ev.environment,
            object: ev.object,
            duration_ms: ev.duration_ms,
            rows_affected: ev.rows_affected,
            session_id: ev.session_id,
            error_kind: ev.error_kind,
            statement_kinds: ev.statement_kinds,
            query,
            detail: ev.detail.map(|d| redact_secrets(&d)),
            prev_hash: prev_hash.clone(),
            hash: String::new(),
        };
        let body = canonical_body(&entry);
        entry.hash = chain_hash(&prev_hash, &body);
        c.execute(
            "INSERT INTO audit (body, prev_hash, hash, ts, category, outcome, connection_id) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![body, entry.prev_hash, entry.hash, entry.ts, enum_str(&entry.category), enum_str(&entry.outcome), entry.connection_id],
        )
        .map_err(map_err)?;
        entry.seq = c.last_insert_rowid();
        Ok(entry)
    }

    pub fn query(&self, f: &AuditFilter) -> DbResult<Vec<AuditEntry>> {
        let c = self.conn.lock().unwrap();
        let mut sql = String::from("SELECT seq, body, prev_hash, hash FROM audit WHERE 1=1");
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(cat) = &f.category {
            sql.push_str(" AND category = ?");
            args.push(Box::new(enum_str(cat)));
        }
        if let Some(o) = &f.outcome {
            sql.push_str(" AND outcome = ?");
            args.push(Box::new(enum_str(o)));
        }
        if let Some(cid) = &f.connection_id {
            sql.push_str(" AND connection_id = ?");
            args.push(Box::new(cid.clone()));
        }
        if let Some(s) = &f.since {
            sql.push_str(" AND ts >= ?");
            args.push(Box::new(s.clone()));
        }
        if let Some(u) = &f.until {
            sql.push_str(" AND ts <= ?");
            args.push(Box::new(u.clone()));
        }
        if let Some(t) = &f.text {
            sql.push_str(" AND body LIKE ? ESCAPE '\\'");
            let e = t.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
            args.push(Box::new(format!("%{e}%")));
        }
        if let Some(b) = f.before_seq {
            sql.push_str(" AND seq < ?");
            args.push(Box::new(b));
        }
        sql.push_str(" ORDER BY seq DESC LIMIT ?");
        args.push(Box::new(f.limit.unwrap_or(500).min(10_000) as i64));
        let mut st = c.prepare(&sql).map_err(map_err)?;
        let rows = st
            .query_map(rusqlite::params_from_iter(args.iter().map(|b| b.as_ref())), |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
            })
            .map_err(map_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, body, prev, hash) = row.map_err(map_err)?;
            let mut e: AuditEntry = serde_json::from_str(&body).map_err(|e| DbError::internal(e.to_string()))?;
            e.seq = seq;
            e.prev_hash = prev;
            e.hash = hash;
            out.push(e);
        }
        Ok(out)
    }

    /// Recompute the whole chain.
    pub fn verify(&self) -> DbResult<VerifyReport> {
        let c = self.conn.lock().unwrap();
        let mut prev: String = c.query_row("SELECT v FROM audit_meta WHERE k='anchor'", [], |r| r.get(0)).unwrap_or_else(|_| GENESIS.to_string());
        let mut st = c.prepare("SELECT seq, body, prev_hash, hash FROM audit ORDER BY seq ASC").map_err(map_err)?;
        let mut rows = st.query([]).map_err(map_err)?;
        let mut n = 0u64;
        while let Some(r) = rows.next().map_err(map_err)? {
            let seq: i64 = r.get(0).map_err(map_err)?;
            let body: String = r.get(1).map_err(map_err)?;
            let stored_prev: String = r.get(2).map_err(map_err)?;
            let hash: String = r.get(3).map_err(map_err)?;
            n += 1;
            if stored_prev != prev || chain_hash(&prev, &body) != hash {
                return Ok(VerifyReport { entries: n, ok: false, first_bad_seq: Some(seq), head_hash: prev });
            }
            prev = hash;
        }
        Ok(VerifyReport { entries: n, ok: true, first_bad_seq: None, head_hash: prev })
    }

    /// Delete entries older than `before_ts`. The hash of the last deleted entry
    /// becomes the new anchor so the remaining chain still verifies, and a
    /// `AuditPurged` event records the purge.
    pub fn purge_before(&self, before_ts: &str) -> DbResult<u64> {
        let n = {
            let mut c = self.conn.lock().unwrap();
            let tx = c.transaction().map_err(map_err)?;
            let last: Option<String> = tx.query_row("SELECT hash FROM audit WHERE ts < ?1 ORDER BY seq DESC LIMIT 1", [before_ts], |r| r.get(0)).ok();
            let Some(anchor) = last else { return Ok(0) };
            let n = tx.execute("DELETE FROM audit WHERE ts < ?1", [before_ts]).map_err(map_err)?;
            tx.execute("INSERT INTO audit_meta(k,v) VALUES('anchor',?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [anchor]).map_err(map_err)?;
            tx.commit().map_err(map_err)?;
            // Reclaim space so deleted entries are not left in free pages.
            let _ = c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
            n as u64
        };
        self.record(NewEvent {
            category: Some(Category::AuditPurged),
            outcome: Some(Outcome::Success),
            rows_affected: Some(n),
            detail: Some(format!("entries before {before_ts}")),
            ..Default::default()
        })?;
        Ok(n)
    }

    /// JSON Lines export, each line one entry including hashes.
    pub fn export_jsonl(&self, f: &AuditFilter) -> DbResult<String> {
        let mut entries = self.query(f)?;
        entries.reverse();
        let mut s = String::new();
        for e in entries {
            s.push_str(&serde_json::to_string(&e).map_err(|e| DbError::internal(e.to_string()))?);
            s.push('\n');
        }
        Ok(s)
    }

    #[doc(hidden)]
    pub fn tamper_for_test(&self, seq: i64, new_body: &str) {
        let c = self.conn.lock().unwrap();
        c.execute("UPDATE audit SET body=?1 WHERE seq=?2", params![new_body, seq]).unwrap();
    }
}

fn enum_str<T: Serialize>(v: &T) -> String {
    serde_json::to_value(v).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

fn canonical_body(e: &AuditEntry) -> String {
    // seq/hash are excluded (assigned by storage / derived from body).
    let mut v = serde_json::to_value(e).expect("serialisable");
    if let Some(o) = v.as_object_mut() {
        o.remove("seq");
        o.remove("hash");
        o.remove("prev_hash");
    }
    // serde_json::Map is a BTreeMap without `preserve_order`, so keys are sorted.
    serde_json::to_string(&v).expect("serialisable")
}

fn chain_hash(prev: &str, body: &str) -> String {
    let mut h = Sha256::new();
    h.update(prev.as_bytes());
    h.update(b"\n");
    h.update(body.as_bytes());
    hex::encode(h.finalize())
}

/// Replace string and numeric literals with `?` so stored query shapes do not
/// carry data values.
pub fn redact_literals(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    let mut prev_word = false;
    while let Some(c) = chars.next() {
        if c == '\'' {
            while let Some(n) = chars.next() {
                if n == '\'' {
                    if chars.peek() == Some(&'\'') {
                        chars.next();
                        continue;
                    }
                    break;
                }
            }
            out.push('?');
            prev_word = false;
        } else if c.is_ascii_digit() && !prev_word {
            while chars.peek().is_some_and(|n| n.is_ascii_alphanumeric() || *n == '.') {
                chars.next();
            }
            out.push('?');
        } else {
            prev_word = c.is_alphanumeric() || c == '_';
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(cat: Category) -> NewEvent {
        NewEvent { category: Some(cat), outcome: Some(Outcome::Success), connection_id: Some("c1".into()), ..Default::default() }
    }

    #[test]
    fn chain_verifies_and_detects_tamper() {
        let log = AuditLog::open_in_memory("0.1.0").unwrap();
        for _ in 0..5 {
            log.record(ev(Category::QueryExecuted)).unwrap();
        }
        let r = log.verify().unwrap();
        assert!(r.ok);
        assert_eq!(r.entries, 5);
        let entries = log.query(&AuditFilter::default()).unwrap();
        let target = &entries[2];
        let mut forged = target.clone();
        forged.outcome = Outcome::Failure;
        log.tamper_for_test(target.seq, &canonical_body(&forged));
        let r = log.verify().unwrap();
        assert!(!r.ok);
        assert_eq!(r.first_bad_seq, Some(target.seq));
    }

    #[test]
    fn query_text_omitted_by_default_and_secrets_redacted() {
        let log = AuditLog::open_in_memory("0.1.0").unwrap();
        let mut e = ev(Category::QueryExecuted);
        e.query_text = Some("select * from users where password = 'hunter2'".into());
        e.detail = Some("connect postgres://u:hunter2@h/db failed".into());
        let entry = log.record(e).unwrap();
        assert_eq!(entry.query, None);
        assert!(!entry.detail.unwrap().contains("hunter2"));

        *log.query_policy.lock().unwrap() = QueryTextPolicy::Redacted;
        let mut e = ev(Category::QueryExecuted);
        e.query_text = Some("select * from t where a = 'secret' and b = 42".into());
        let entry = log.record(e).unwrap();
        assert_eq!(entry.query.as_deref(), Some("select * from t where a = ? and b = ?"));

        *log.query_policy.lock().unwrap() = QueryTextPolicy::Hash;
        let mut e = ev(Category::QueryExecuted);
        e.query_text = Some("x".into());
        assert!(log.record(e).unwrap().query.unwrap().starts_with("sha256:"));
        assert!(log.verify().unwrap().ok);
    }

    #[test]
    fn filter_and_purge_keep_chain_valid() {
        let log = AuditLog::open_in_memory("0.1.0").unwrap();
        log.record(ev(Category::ConnectionCreated)).unwrap();
        log.record(ev(Category::Export)).unwrap();
        log.record(ev(Category::Export)).unwrap();
        let only = log.query(&AuditFilter { category: Some(Category::Export), ..Default::default() }).unwrap();
        assert_eq!(only.len(), 2);
        std::thread::sleep(std::time::Duration::from_millis(5));
        let cutoff = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        std::thread::sleep(std::time::Duration::from_millis(5));
        log.record(ev(Category::Backup)).unwrap();
        let purged = log.purge_before(&cutoff).unwrap();
        assert_eq!(purged, 3);
        let r = log.verify().unwrap();
        assert!(r.ok, "{r:?}");
        assert_eq!(r.entries, 2); // Backup + AuditPurged
    }

    #[test]
    fn redact_literals_works() {
        assert_eq!(redact_literals("a = 'it''s' or b=3.14 or col2 = 1"), "a = ? or b=? or col2 = ?");
    }
}
