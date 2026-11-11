//! Redis driver. Redis is not SQL: "execute" takes one command per line
//! (`GET key`, `HSET h f v`), tokenised with shell-style quoting and classified
//! by `dbs_safety::classify_redis` for the safety policy.
//!
//! Logical databases (`db0`, `db1`, ...) are exposed as schemas. Keys are browsed
//! through [`KeyValueBrowser`]: a key grid paged with `SCAN cursor MATCH p COUNT n`
//! (never `KEYS`) and a per-pattern cursor cache, a namespace tree expanded in
//! bounded `SCAN` batches, and typed value pages (`HSCAN`, `LRANGE`, `SSCAN`,
//! `ZRANGE`, `XRANGE`, `GETRANGE`). Every call is bounded in keys, round trips and
//! time, so browsing a keyspace with millions of keys never blocks the server.
//!
//! One multiplexed connection is shared by the session; every operation selects
//! its database first (`SELECT n`, skipped when already selected).

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use dbs_core::*;
use dbs_safety::Risk;
use redis::aio::MultiplexedConnection;
use redis::RedisError;
use tokio::sync::{Mutex, MutexGuard};
use tokio_util::sync::CancellationToken;

use crate::util::{elapsed_ms, excerpt, guarded};

pub use dbs_safety::redis::tokenize_command;

pub struct RedisDriver;

struct Inner {
    conn: MultiplexedConnection,
    /// Database currently selected on the wire.
    selected: i64,
}

pub struct RedisConnection {
    inner: Mutex<Inner>,
    read_only: bool,
    /// Database used by the query tab (`use_schema` / a `SELECT n` the user ran).
    session_db: AtomicI64,
    /// Cleared after the first `MEMORY USAGE` failure (disabled or renamed command).
    memory_usage: AtomicBool,
    scans: std::sync::Mutex<ScanCache>,
}

fn map_err(e: RedisError) -> DbError {
    let kind = match e.kind() {
        redis::ErrorKind::AuthenticationFailed => ErrorKind::Authentication,
        redis::ErrorKind::IoError => ErrorKind::Connection,
        redis::ErrorKind::ReadOnly => ErrorKind::Permission,
        redis::ErrorKind::TypeError | redis::ErrorKind::ResponseError => ErrorKind::InvalidInput,
        _ => ErrorKind::Internal,
    };
    DbError::new(kind, e.to_string())
}

/// Risk class name for a Redis command (`read`, `session`, `write`, `destructive`, `admin`, `unknown`).
pub fn classify_redis_command(cmd: &str) -> &'static str {
    match dbs_safety::classify_redis(cmd) {
        Risk::Read => "read",
        Risk::Session => "session",
        Risk::Destructive => "destructive",
        Risk::Admin => "admin",
        Risk::Unknown => "unknown",
        _ => "write",
    }
}

fn to_value(v: redis::Value) -> Value {
    use redis::Value as R;
    match v {
        R::Nil => Value::Null,
        R::Int(i) => Value::from_i64(i),
        R::BulkString(b) => bytes_value(b),
        R::Array(a) | R::Set(a) => Value::Array(a.into_iter().map(to_value).collect()),
        R::SimpleString(s) => Value::Text(s),
        R::Okay => Value::Text("OK".into()),
        R::Map(m) => Value::Json(serde_json::Value::Object(
            m.into_iter().map(|(k, v)| (to_value(k).to_plain().unwrap_or_default(), serde_json::to_value(to_value(v)).unwrap_or_default())).collect(),
        )),
        R::Double(d) => Value::Float(d),
        R::Boolean(b) => Value::Bool(b),
        R::VerbatimString { text, .. } => Value::Text(text),
        R::BigNumber(n) => Value::BigInt(n.to_string()),
        other => Value::Text(format!("{other:?}")),
    }
}

fn bytes_value(b: Vec<u8>) -> Value {
    match String::from_utf8(b) {
        Ok(s) => Value::Text(s),
        Err(e) => Value::from_bytes(e.as_bytes()),
    }
}

fn val_string(v: &redis::Value) -> Option<String> {
    match v {
        redis::Value::BulkString(b) => Some(String::from_utf8_lossy(b).into_owned()),
        redis::Value::SimpleString(s) => Some(s.clone()),
        redis::Value::VerbatimString { text, .. } => Some(text.clone()),
        redis::Value::Okay => Some("OK".into()),
        _ => None,
    }
}

fn val_i64(v: &redis::Value) -> Option<i64> {
    match v {
        redis::Value::Int(i) => Some(*i),
        other => val_string(other).and_then(|s| s.parse().ok()),
    }
}

// ---------------------------------------------------------------- pure helpers

/// `db3` or `3` → 3.
pub fn parse_db(name: &str) -> DbResult<i64> {
    let n = name.trim();
    let digits = n.strip_prefix("db").unwrap_or(n);
    digits.parse::<i64>().ok().filter(|d| (0..=1_000_000).contains(d)).ok_or_else(|| DbError::invalid(format!("not a database: {name}")))
}

pub fn db_name(n: i64) -> String {
    format!("db{n}")
}

/// `INFO keyspace` → `(index, keys, expires)` per database, in server order.
pub fn parse_keyspace_info(info: &str) -> Vec<(i64, u64, u64)> {
    info.lines()
        .filter_map(|l| {
            let (name, rest) = l.trim().split_once(':')?;
            let idx = name.strip_prefix("db")?.parse().ok()?;
            let field = |k: &str| rest.split(',').find_map(|kv| kv.strip_prefix(k)?.strip_prefix('=')?.parse::<u64>().ok());
            Some((idx, field("keys")?, field("expires").unwrap_or(0)))
        })
        .collect()
}

/// Escape glob metacharacters so `s` matches literally in `SCAN MATCH`.
pub fn escape_glob(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '*' | '?' | '[' | ']' | '\\') {
            o.push('\\');
        }
        o.push(c);
    }
    o
}

/// Group keys under `prefix` into child namespaces (up to the next `sep`) and direct keys.
pub fn group_namespaces(prefix: &str, sep: &str, keys: impl IntoIterator<Item = String>) -> (Vec<NamespaceNode>, Vec<String>) {
    let mut children: BTreeMap<String, u64> = BTreeMap::new();
    let mut leaves = BTreeSet::new();
    for k in keys {
        let Some(rest) = k.strip_prefix(prefix) else { continue };
        match (!sep.is_empty()).then(|| rest.find(sep)).flatten() {
            Some(i) => *children.entry(rest[..i].to_string()).or_default() += 1,
            None => {
                leaves.insert(k);
            }
        }
    }
    let ns = children.into_iter().map(|(label, count)| NamespaceNode { prefix: format!("{prefix}{label}{sep}"), label, count }).collect();
    (ns, leaves.into_iter().collect())
}

/// Where a key scan stands: the server cursor to continue from, keys already
/// returned by the server but not yet handed out, and whether the server cursor
/// came back to 0 (end of the keyspace).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ScanState {
    pub cursor: u64,
    pub buffered: VecDeque<String>,
    pub finished: bool,
}

const MAX_CACHED_SCANS: usize = 16;
const MAX_POSITIONS_PER_SCAN: usize = 256;

/// Per (database, pattern) map of scan position → [`ScanState`], so page N
/// continues where page N-1 stopped instead of rescanning from the start.
#[derive(Debug, Default)]
pub struct ScanCache {
    map: HashMap<String, BTreeMap<u64, ScanState>>,
}

impl ScanCache {
    pub fn key(db: i64, pattern: &str) -> String {
        format!("{db}\u{0}{pattern}")
    }

    /// Nearest remembered state at or before `pos` (else the start of the scan).
    pub fn before(&self, ck: &str, pos: u64) -> (u64, ScanState) {
        self.map.get(ck).and_then(|m| m.range(..=pos).next_back()).map(|(p, s)| (*p, s.clone())).unwrap_or_default()
    }

    pub fn remember(&mut self, ck: &str, pos: u64, st: ScanState) {
        if !self.map.contains_key(ck) && self.map.len() >= MAX_CACHED_SCANS {
            self.map.clear();
        }
        let m = self.map.entry(ck.to_string()).or_default();
        if m.len() >= MAX_POSITIONS_PER_SCAN {
            m.clear();
        }
        m.insert(pos, st);
    }

    pub fn reset(&mut self, ck: &str) {
        self.map.remove(ck);
    }

    pub fn reset_db(&mut self, db: i64) {
        let p = format!("{db}\u{0}");
        self.map.retain(|k, _| !k.starts_with(&p));
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

/// One `SCAN` round trip (abstracted for tests).
#[async_trait]
pub trait ScanSource: Send {
    async fn scan(&mut self, cursor: u64) -> DbResult<(u64, Vec<String>)>;
}

/// Upper bound on SCAN round trips per key page / tree batch.
pub const MAX_SCAN_CALLS: usize = 200;
/// Upper bound on time spent scanning per key page / tree batch.
const SCAN_TIME_BUDGET: Duration = Duration::from_millis(1500);

/// Keys at scan positions `from..from+limit` (fewer when the round-trip or time
/// budget runs out first). Returns `(keys, next position, done)`.
pub async fn scan_page(
    cache: &std::sync::Mutex<ScanCache>,
    ck: &str,
    from: u64,
    limit: usize,
    max_calls: usize,
    src: &mut dyn ScanSource,
) -> DbResult<(Vec<String>, u64, bool)> {
    let (mut pos, mut st) = cache.lock().unwrap().before(ck, from);
    let started = Instant::now();
    let mut out = Vec::new();
    let mut calls = 0;
    while out.len() < limit {
        if let Some(k) = st.buffered.pop_front() {
            if pos >= from {
                out.push(k);
            }
            pos += 1;
            continue;
        }
        if st.finished || calls >= max_calls || started.elapsed() > SCAN_TIME_BUDGET {
            break;
        }
        let (next, keys) = src.scan(st.cursor).await?;
        calls += 1;
        st.cursor = next;
        st.finished = next == 0;
        st.buffered.extend(keys);
    }
    let done = st.finished && st.buffered.is_empty();
    cache.lock().unwrap().remember(ck, pos, st);
    Ok((out, pos, done))
}

struct ConnScan<'a> {
    conn: &'a mut MultiplexedConnection,
    pattern: &'a str,
    count: u64,
}

#[async_trait]
impl ScanSource for ConnScan<'_> {
    async fn scan(&mut self, cursor: u64) -> DbResult<(u64, Vec<String>)> {
        let (next, keys): (u64, Vec<Vec<u8>>) =
            redis::cmd("SCAN").arg(cursor).arg("MATCH").arg(self.pattern).arg("COUNT").arg(self.count).query_async(self.conn).await.map_err(map_err)?;
        Ok((next, keys.into_iter().map(|k| String::from_utf8_lossy(&k).into_owned()).collect()))
    }
}

/// Command-line form of one argument: bare when unambiguous, else quoted.
fn display_arg(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '+' | '-')) {
        s.to_string()
    } else {
        dbs_safety::quote_arg(s)
    }
}

fn need_key(k: &str) -> DbResult<()> {
    if k.is_empty() || k.len() > 64 * 1024 {
        return Err(DbError::invalid("key must be 1-65536 bytes"));
    }
    Ok(())
}

/// The command (name + arguments) one staged edit runs.
pub fn edit_args(e: &KvEdit) -> DbResult<Vec<String>> {
    need_key(e.key())?;
    let v = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    Ok(match e {
        KvEdit::SetString { key, value } => v(&["SET", key, value, "KEEPTTL"]),
        KvEdit::Expire { key, seconds } if *seconds < 0 => v(&["PERSIST", key]),
        KvEdit::Expire { seconds: 0, .. } => return Err(DbError::invalid("TTL must be a positive number of seconds (or -1 for no expiry)")),
        KvEdit::Expire { key, seconds } => v(&["EXPIRE", key, &seconds.to_string()]),
        KvEdit::Rename { key, to } => {
            need_key(to)?;
            if to == key {
                return Err(DbError::invalid("new key name is the same as the old one"));
            }
            v(&["RENAMENX", key, to])
        }
        KvEdit::Delete { key } => v(&["UNLINK", key]),
        KvEdit::HashSet { key, field, value } => v(&["HSET", key, field, value]),
        KvEdit::HashDelete { key, field } => v(&["HDEL", key, field]),
        KvEdit::ListPush { key, value } => v(&["RPUSH", key, value]),
        KvEdit::ListSet { key, index, value } => v(&["LSET", key, &index.to_string(), value]),
        KvEdit::ListRemove { key, value } => v(&["LREM", key, "1", value]),
        KvEdit::SetAdd { key, member } => v(&["SADD", key, member]),
        KvEdit::SetRemove { key, member } => v(&["SREM", key, member]),
        KvEdit::ZsetAdd { key, member, score } => {
            if score.is_nan() {
                return Err(DbError::invalid("score must be a number"));
            }
            let s = if score.is_infinite() {
                if *score > 0.0 {
                    "+inf".to_string()
                } else {
                    "-inf".to_string()
                }
            } else {
                score.to_string()
            };
            v(&["ZADD", key, &s, member])
        }
        KvEdit::ZsetRemove { key, member } => v(&["ZREM", key, member]),
    })
}

pub fn command_line(args: &[String]) -> String {
    let mut parts = args.iter();
    let mut s = parts.next().cloned().unwrap_or_default();
    for a in parts {
        s.push(' ');
        s.push_str(&display_arg(a));
    }
    s
}

/// Next stream id after `id` (`ms-seq` → `ms-(seq+1)`), for exclusive XRANGE paging.
fn next_stream_id(id: &str) -> Option<String> {
    let (ms, seq) = id.split_once('-')?;
    let ms: u64 = ms.parse().ok()?;
    let seq: u64 = seq.parse().ok()?;
    Some(match seq.checked_add(1) {
        Some(s) => format!("{ms}-{s}"),
        None => format!("{}-0", ms.checked_add(1)?),
    })
}

const PREVIEW_CHARS: usize = 200;
const PREVIEW_BYTES: i64 = 800;
const STRING_CHUNK: i64 = 256 * 1024;
const DEFAULT_VALUE_PAGE: u32 = 200;

fn kind_name(server_type: &str) -> String {
    match server_type {
        "ReJSON-RL" => "json".into(),
        t => t.to_string(),
    }
}

// ---------------------------------------------------------------- driver

#[async_trait]
impl DatabaseDriver for RedisDriver {
    fn engines(&self) -> &'static [Engine] {
        &[Engine::Redis]
    }

    async fn connect(&self, cfg: &ConnectionConfig, secrets: ConnectSecrets) -> DbResult<Box<dyn DatabaseConnection>> {
        cfg.validate()?;
        let host = cfg.host.clone().unwrap_or_else(|| "localhost".into());
        let port = cfg.effective_port().unwrap_or(6379);
        let db: i64 = cfg.database.as_deref().filter(|d| !d.trim().is_empty()).map(parse_db).transpose()?.unwrap_or(0);
        if cfg.tls.mode.verifies_certificate() && (cfg.tls.ca_cert_path.is_some() || cfg.tls.client_cert_path.is_some()) {
            return Err(DbError::unsupported("custom CA / client certificates for Redis (use system trust store)"));
        }
        let tls_addr = |mode: TlsMode, host: String| match mode {
            TlsMode::Disabled => redis::ConnectionAddr::Tcp(host, port),
            TlsMode::Required | TlsMode::Preferred => redis::ConnectionAddr::TcpTls { host, port, insecure: true, tls_params: None },
            TlsMode::VerifyIdentity => redis::ConnectionAddr::TcpTls { host, port, insecure: false, tls_params: None },
            TlsMode::VerifyCa => {
                let mut a = redis::ConnectionAddr::TcpTls { host, port, insecure: false, tls_params: None };
                a.set_danger_accept_invalid_hostnames(true);
                a
            }
        };
        let redis_info = redis::RedisConnectionInfo {
            db,
            username: cfg.username.clone().filter(|u| !u.is_empty()),
            password: secrets.password.clone(),
            ..Default::default()
        };
        drop(secrets);
        let timeout = std::time::Duration::from_secs(cfg.connect_timeout_secs as u64);
        let dial = |addr: redis::ConnectionAddr| {
            // A plaintext Redis may just sit on a TLS ClientHello; don't make PREFERRED wait the full timeout.
            let probe = cfg.tls.mode == TlsMode::Preferred && matches!(addr, redis::ConnectionAddr::TcpTls { .. });
            let timeout = if probe { timeout.min(std::time::Duration::from_secs(3)) } else { timeout };
            let info = redis::ConnectionInfo { addr, redis: redis_info.clone() };
            async move {
                let client = redis::Client::open(info).map_err(map_err)?;
                tokio::time::timeout(timeout, client.get_multiplexed_async_connection())
                    .await
                    .map_err(|_| DbError::new(ErrorKind::Timeout, "connection timed out"))?
                    .map_err(map_err)
            }
        };
        let conn = match dial(tls_addr(cfg.tls.mode, host.clone())).await {
            // PREFERRED: a server without TLS can't complete the handshake; retry in plaintext.
            // Authentication errors are not retried (they'd fail the same way).
            Err(e) if cfg.tls.mode == TlsMode::Preferred && e.kind != ErrorKind::Authentication => {
                tracing::info!("TLS to Redis failed ({}); SSL mode PREFERRED falls back to plaintext", e.message);
                dial(tls_addr(TlsMode::Disabled, host)).await?
            }
            r => r?,
        };
        Ok(Box::new(RedisConnection {
            inner: Mutex::new(Inner { conn, selected: db }),
            read_only: cfg.read_only,
            session_db: AtomicI64::new(db),
            memory_usage: AtomicBool::new(true),
            scans: std::sync::Mutex::new(ScanCache::default()),
        }))
    }
}

impl RedisConnection {
    /// The connection with database `db` selected.
    async fn on_db(&self, db: i64) -> DbResult<MutexGuard<'_, Inner>> {
        let mut g = self.inner.lock().await;
        if g.selected != db {
            redis::cmd("SELECT").arg(db).query_async::<()>(&mut g.conn).await.map_err(map_err)?;
            g.selected = db;
        }
        Ok(g)
    }

    async fn on_session_db(&self) -> DbResult<MutexGuard<'_, Inner>> {
        self.on_db(self.session_db.load(Ordering::Relaxed)).await
    }

    /// Pipeline whose individual command errors come back as values instead of failing the batch.
    async fn raw_pipe(conn: &mut MultiplexedConnection, p: &redis::Pipeline) -> DbResult<Vec<redis::Value>> {
        use redis::aio::ConnectionLike;
        conn.req_packed_commands(p, 0, p.len()).await.map_err(map_err)
    }

    async fn memory_usage(&self, conn: &mut MultiplexedConnection, keys: &[String]) -> Vec<Option<u64>> {
        if keys.is_empty() || !self.memory_usage.load(Ordering::Relaxed) {
            return vec![None; keys.len()];
        }
        let mut p = redis::pipe();
        for k in keys {
            p.cmd("MEMORY").arg("USAGE").arg(k);
        }
        match Self::raw_pipe(conn, &p).await {
            Ok(vals) => {
                if vals.iter().all(|v| matches!(v, redis::Value::ServerError(_))) {
                    self.memory_usage.store(false, Ordering::Relaxed);
                }
                let mut out: Vec<Option<u64>> = vals.iter().map(|v| val_i64(v).and_then(|n| u64::try_from(n).ok())).collect();
                out.resize(keys.len(), None);
                out
            }
            Err(_) => {
                self.memory_usage.store(false, Ordering::Relaxed);
                vec![None; keys.len()]
            }
        }
    }

    /// Type, TTL, size, length and preview for a page of keys: three pipelines, no per-key round trips.
    async fn describe_keys(&self, conn: &mut MultiplexedConnection, keys: Vec<String>) -> DbResult<Vec<KeyRow>> {
        if keys.is_empty() {
            return Ok(vec![]);
        }
        let mut p = redis::pipe();
        for k in &keys {
            p.cmd("TYPE").arg(k).cmd("TTL").arg(k);
        }
        let tt = Self::raw_pipe(conn, &p).await?;
        let sizes = self.memory_usage(conn, &keys).await;
        let mut rows: Vec<KeyRow> = Vec::with_capacity(keys.len());
        for (i, key) in keys.into_iter().enumerate() {
            let ty = tt.get(2 * i).and_then(val_string).unwrap_or_else(|| "none".into());
            if ty == "none" {
                continue; // deleted or expired since the scan
            }
            let ttl = tt.get(2 * i + 1).and_then(val_i64).unwrap_or(-1);
            rows.push(KeyRow { key, kind: ty, ttl: if ttl < -1 { -1 } else { ttl }, size: sizes[i], length: None, preview: None, preview_truncated: false });
        }
        // Lengths and string previews (GETRANGE keeps big strings cheap).
        let mut p = redis::pipe();
        let mut slots = Vec::new();
        for (i, r) in rows.iter().enumerate() {
            let len_cmd = match r.kind.as_str() {
                "string" => {
                    p.cmd("STRLEN").arg(&r.key).cmd("GETRANGE").arg(&r.key).arg(0).arg(PREVIEW_BYTES - 1);
                    slots.push((i, 2));
                    continue;
                }
                "hash" => "HLEN",
                "list" => "LLEN",
                "set" => "SCARD",
                "zset" => "ZCARD",
                "stream" => "XLEN",
                _ => continue,
            };
            p.cmd(len_cmd).arg(&r.key);
            slots.push((i, 1));
        }
        if let Ok(vals) = Self::raw_pipe(conn, &p).await {
            let mut it = vals.into_iter();
            for (i, n) in slots {
                let r = &mut rows[i];
                r.length = it.next().as_ref().and_then(val_i64).and_then(|x| u64::try_from(x).ok());
                if n == 2 {
                    if let Some(redis::Value::BulkString(b)) = it.next() {
                        let s = String::from_utf8_lossy(&b);
                        let mut chars = s.chars();
                        let preview: String = chars.by_ref().take(PREVIEW_CHARS).collect();
                        r.preview_truncated = chars.next().is_some() || r.length.is_some_and(|l| l > b.len() as u64);
                        r.preview = Some(preview);
                    }
                }
            }
        }
        for r in &mut rows {
            r.kind = kind_name(&r.kind);
        }
        Ok(rows)
    }
}

#[async_trait]
impl DatabaseConnection for RedisConnection {
    fn engine(&self) -> Engine {
        Engine::Redis
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            sql: false,
            transactions: false,
            schemas: true,
            multiple_databases: true,
            cancel: false,
            object_kinds: vec![ObjectKind::Key],
            ..Default::default()
        }
    }

    async fn server_info(&self) -> DbResult<ServerInfo> {
        let info: String = redis::cmd("INFO").arg("server").query_async(&mut self.inner.lock().await.conn).await.map_err(map_err)?;
        let version = info.lines().find_map(|l| l.strip_prefix("redis_version:")).unwrap_or("").trim().to_string();
        Ok(ServerInfo {
            engine: Engine::Redis,
            version,
            current_database: Some(db_name(self.session_db.load(Ordering::Relaxed))),
            current_user: None,
            tls_version: None,
        })
    }

    async fn ping(&self) -> DbResult<()> {
        let _: String = redis::cmd("PING").query_async(&mut self.inner.lock().await.conn).await.map_err(map_err)?;
        Ok(())
    }

    async fn close(&self) -> DbResult<()> {
        Ok(())
    }

    async fn list_databases(&self) -> DbResult<Vec<String>> {
        let n: Vec<String> = redis::cmd("CONFIG").arg("GET").arg("databases").query_async(&mut self.inner.lock().await.conn).await.unwrap_or_default();
        let count: usize = n.get(1).and_then(|s| s.parse().ok()).unwrap_or(16);
        Ok((0..count).map(|i| i.to_string()).collect())
    }

    /// Logical databases that hold keys, plus the selected one (`db0`, `db3`, ...).
    async fn list_schemas(&self, _db: Option<&str>) -> DbResult<Vec<String>> {
        Ok(self.keyspaces().await?.into_iter().map(|k| k.name).collect())
    }

    /// Keys are browsed through [`KeyValueBrowser`] (bounded SCAN batches), never listed in full.
    async fn list_objects(&self, _schema: Option<&str>) -> DbResult<Vec<ObjectRef>> {
        Ok(vec![])
    }

    async fn use_schema(&self, schema: &str) -> DbResult<()> {
        let db = parse_db(schema)?;
        drop(self.on_db(db).await?);
        self.session_db.store(db, Ordering::Relaxed);
        Ok(())
    }

    async fn describe_table(&self, target: &TableTarget) -> DbResult<TableDescription> {
        let mut g = self.on_session_db().await?;
        let ty: String = redis::cmd("TYPE").arg(&target.table).query_async(&mut g.conn).await.map_err(map_err)?;
        let ttl: i64 = redis::cmd("TTL").arg(&target.table).query_async(&mut g.conn).await.map_err(map_err)?;
        Ok(TableDescription {
            object: ObjectRef { kind: ObjectKind::Key, database: None, schema: None, name: target.table.clone() },
            columns: vec![ColumnDef {
                name: "value".into(),
                data_type: ty,
                nullable: false,
                default: None,
                is_primary_key: false,
                is_identity: false,
                comment: None,
                ordinal: 1,
            }],
            primary_key: vec![],
            indexes: vec![],
            foreign_keys: vec![],
            constraints: vec![],
            ddl: None,
            estimated_rows: None,
            comment: Some(format!("TTL: {}", if ttl < 0 { "none".into() } else { format!("{ttl}s") })),
        })
    }

    async fn object_ddl(&self, _o: &ObjectRef) -> DbResult<String> {
        Err(DbError::unsupported("DDL"))
    }

    async fn execute(&self, script: &str, opts: &ExecOptions, cancel: CancellationToken) -> DbResult<Vec<StatementResult>> {
        let fut = async {
            let mut out = Vec::new();
            for (idx, line) in script.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).enumerate() {
                let t = Instant::now();
                let parts = tokenize_command(line).map_err(DbError::invalid)?;
                let Some((name, args)) = parts.split_first() else { continue };
                let risk = dbs_safety::classify_redis(name);
                if self.read_only && risk > Risk::Session {
                    return Err(DbError::new(ErrorKind::PolicyBlocked, format!("{name} is not allowed on a read-only connection")));
                }
                let upper = name.to_ascii_uppercase();
                if matches!(upper.as_str(), "MONITOR" | "SUBSCRIBE" | "PSUBSCRIBE" | "SSUBSCRIBE" | "SYNC" | "PSYNC") {
                    return Err(DbError::unsupported(&format!("{name} (streaming command)")));
                }
                let mut cmd = redis::cmd(name);
                for a in args {
                    cmd.arg(a);
                }
                let mut g = self.on_session_db().await?;
                let v: redis::Value = cmd.query_async(&mut g.conn).await.map_err(map_err)?;
                if upper == "SELECT" {
                    if let Some(db) = args.first().and_then(|a| a.parse::<i64>().ok()) {
                        g.selected = db;
                        self.session_db.store(db, Ordering::Relaxed);
                    }
                }
                drop(g);
                let val = to_value(v);
                let rows: Vec<Vec<Value>> = match val {
                    Value::Array(items) => items.into_iter().take(opts.max_rows).map(|i| vec![i]).collect(),
                    other => vec![vec![other]],
                };
                out.push(StatementResult {
                    statement_index: idx,
                    sql_excerpt: excerpt(line),
                    result: Some(ResultSet {
                        columns: vec![ColumnMeta { name: "result".into(), type_name: "redis".into(), nullable: None, table: None }],
                        rows,
                        truncated: false,
                    }),
                    rows_affected: None,
                    duration_ms: elapsed_ms(t),
                    notices: vec![],
                });
            }
            Ok(out)
        };
        guarded(fut, cancel, opts.timeout_ms, || async {}).await
    }

    async fn execute_params(&self, _s: &GeneratedStatement) -> DbResult<u64> {
        Err(DbError::unsupported("parameterised SQL"))
    }

    /// One key's value (legacy single-key view; the key browser uses [`KeyValueBrowser::read_value`]).
    async fn fetch_table(&self, target: &TableTarget, page: &PageRequest) -> DbResult<ResultSet> {
        let db = target.schema.as_deref().map(parse_db).transpose()?.unwrap_or(self.session_db.load(Ordering::Relaxed));
        let cursor = if page.offset == 0 { String::new() } else { page.offset.to_string() };
        let vp = self.read_value(&db_name(db), &target.table, &ValueRequest { cursor, count: page.limit.min(MAX_VALUE_PAGE as u64) as u32 }).await?;
        let col = |n: &str| ColumnMeta { name: n.into(), type_name: "text".into(), nullable: None, table: None };
        if let Some(text) = vp.text {
            return Ok(ResultSet { columns: vec![col("value")], rows: vec![vec![Value::Text(text)]], truncated: vp.next.is_some() });
        }
        Ok(ResultSet { columns: vp.columns.iter().map(|c| col(c)).collect(), rows: vp.rows, truncated: false })
    }

    async fn count_rows(&self, target: &TableTarget, _f: &[FilterCondition]) -> DbResult<u64> {
        let mut g = self.on_session_db().await?;
        let ty: String = redis::cmd("TYPE").arg(&target.table).query_async(&mut g.conn).await.map_err(map_err)?;
        let cmd = match ty.as_str() {
            "list" => "LLEN",
            "hash" => "HLEN",
            "set" => "SCARD",
            "zset" => "ZCARD",
            "stream" => "XLEN",
            _ => return Ok(1),
        };
        redis::cmd(cmd).arg(&target.table).query_async(&mut g.conn).await.map_err(map_err)
    }

    async fn begin(&self) -> DbResult<()> {
        Err(DbError::unsupported("transactions"))
    }
    async fn commit(&self) -> DbResult<()> {
        Err(DbError::unsupported("transactions"))
    }
    async fn rollback(&self) -> DbResult<()> {
        Err(DbError::unsupported("transactions"))
    }

    fn key_value(&self) -> Option<&dyn KeyValueBrowser> {
        Some(self)
    }
}

#[async_trait]
impl KeyValueBrowser for RedisConnection {
    async fn keyspaces(&self) -> DbResult<Vec<KeyspaceInfo>> {
        let info: String = redis::cmd("INFO").arg("keyspace").query_async(&mut self.inner.lock().await.conn).await.map_err(map_err)?;
        let cur = self.session_db.load(Ordering::Relaxed);
        let mut dbs = parse_keyspace_info(&info);
        if !dbs.iter().any(|(i, _, _)| *i == cur) {
            dbs.push((cur, 0, 0));
        }
        dbs.sort_by_key(|(i, _, _)| *i);
        Ok(dbs.into_iter().map(|(index, keys, expires)| KeyspaceInfo { name: db_name(index), index, keys, expires, current: index == cur }).collect())
    }

    async fn scan_keys(&self, db: &str, pattern: &str, from: u64, limit: u64, restart: bool) -> DbResult<KeyPage> {
        let db = parse_db(db)?;
        let pattern = if pattern.is_empty() { "*" } else { pattern };
        if pattern.len() > 4096 {
            return Err(DbError::invalid("key pattern is too long"));
        }
        let limit = limit.clamp(1, MAX_KEY_PAGE) as usize;
        let ck = ScanCache::key(db, pattern);
        if restart {
            // New tab, refresh or changed pattern: start a new scan.
            self.scans.lock().unwrap().reset(&ck);
        }
        let mut g = self.on_db(db).await?;
        let count = (limit as u64).clamp(100, 1000);
        let (keys, next, done) = {
            let mut src = ConnScan { conn: &mut g.conn, pattern, count };
            scan_page(&self.scans, &ck, from, limit, MAX_SCAN_CALLS, &mut src).await?
        };
        let keys = self.describe_keys(&mut g.conn, keys).await?;
        let total = if pattern == "*" { Some(redis::cmd("DBSIZE").query_async::<u64>(&mut g.conn).await.map_err(map_err)?) } else { None };
        Ok(KeyPage { keys, next, done, total })
    }

    async fn namespace_children(&self, db: &str, prefix: &str, separator: &str, cursor: u64, limit: u64) -> DbResult<TreeBatch> {
        let db = parse_db(db)?;
        if prefix.len() > 4096 || separator.is_empty() || separator.len() > 32 {
            return Err(DbError::invalid("invalid namespace prefix or separator"));
        }
        let limit = limit.clamp(1, MAX_TREE_BATCH) as usize;
        let pattern = format!("{}*", escape_glob(prefix));
        let mut g = self.on_db(db).await?;
        let mut src = ConnScan { conn: &mut g.conn, pattern: &pattern, count: 1000 };
        let started = Instant::now();
        let mut keys = Vec::new();
        let mut cur = cursor;
        let mut calls = 0;
        loop {
            let (next, ks) = src.scan(cur).await?;
            keys.extend(ks);
            cur = next;
            calls += 1;
            if cur == 0 || keys.len() >= limit || calls >= MAX_SCAN_CALLS || started.elapsed() > SCAN_TIME_BUDGET {
                break;
            }
        }
        let scanned = keys.len() as u64;
        let (namespaces, keys) = group_namespaces(prefix, separator, keys);
        Ok(TreeBatch { namespaces, keys, cursor: cur, done: cur == 0, scanned })
    }

    async fn read_value(&self, db: &str, key: &str, req: &ValueRequest) -> DbResult<ValuePage> {
        let db = parse_db(db)?;
        need_key(key)?;
        let count = if req.count == 0 { DEFAULT_VALUE_PAGE } else { req.count.min(MAX_VALUE_PAGE) } as i64;
        let mut g = self.on_db(db).await?;
        let c = &mut g.conn;
        let (ty, ttl): (String, i64) = redis::pipe().cmd("TYPE").arg(key).cmd("TTL").arg(key).query_async(c).await.map_err(map_err)?;
        if ty == "none" {
            return Err(DbError::new(ErrorKind::NotFound, "key not found (deleted or expired)"));
        }
        let size = self.memory_usage(c, &[key.to_string()]).await.pop().flatten();
        let mut page =
            ValuePage { key: key.into(), kind: kind_name(&ty), ttl: ttl.max(-1), size, length: None, columns: vec![], rows: vec![], text: None, next: None };
        let off = |s: &str| -> DbResult<i64> {
            if s.is_empty() {
                Ok(0)
            } else {
                s.parse::<i64>().ok().filter(|n| *n >= 0).ok_or_else(|| DbError::invalid("invalid continuation"))
            }
        };
        let ucur = |s: &str| -> DbResult<u64> {
            if s.is_empty() {
                Ok(0)
            } else {
                s.parse::<u64>().map_err(|_| DbError::invalid("invalid continuation"))
            }
        };
        match ty.as_str() {
            "string" => {
                let start = off(&req.cursor)?;
                let len: i64 = redis::cmd("STRLEN").arg(key).query_async(c).await.map_err(map_err)?;
                let mut bytes: Vec<u8> = redis::cmd("GETRANGE").arg(key).arg(start).arg(start + STRING_CHUNK - 1).query_async(c).await.map_err(map_err)?;
                // Don't split a UTF-8 character across chunks.
                if let Err(e) = std::str::from_utf8(&bytes) {
                    if e.error_len().is_none() && e.valid_up_to() > 0 {
                        bytes.truncate(e.valid_up_to());
                    }
                }
                let end = start + bytes.len() as i64;
                page.length = Some(len as u64);
                page.text = Some(String::from_utf8_lossy(&bytes).into_owned());
                page.next = (end < len && !bytes.is_empty()).then(|| end.to_string());
            }
            "hash" => {
                page.length = Some(redis::cmd("HLEN").arg(key).query_async(c).await.map_err(map_err)?);
                let (next, items): (u64, Vec<(Vec<u8>, Vec<u8>)>) =
                    redis::cmd("HSCAN").arg(key).arg(ucur(&req.cursor)?).arg("COUNT").arg(count).query_async(c).await.map_err(map_err)?;
                page.columns = vec!["field".into(), "value".into()];
                page.rows = items.into_iter().map(|(f, v)| vec![bytes_value(f), bytes_value(v)]).collect();
                page.next = (next != 0).then(|| next.to_string());
            }
            "list" => {
                let len: i64 = redis::cmd("LLEN").arg(key).query_async(c).await.map_err(map_err)?;
                let start = off(&req.cursor)?;
                let items: Vec<Vec<u8>> = redis::cmd("LRANGE").arg(key).arg(start).arg(start + count - 1).query_async(c).await.map_err(map_err)?;
                page.length = Some(len as u64);
                page.columns = vec!["index".into(), "value".into()];
                let n = items.len() as i64;
                page.rows = items.into_iter().enumerate().map(|(i, v)| vec![Value::Int(start + i as i64), bytes_value(v)]).collect();
                page.next = (start + n < len && n > 0).then(|| (start + n).to_string());
            }
            "set" => {
                page.length = Some(redis::cmd("SCARD").arg(key).query_async(c).await.map_err(map_err)?);
                let (next, items): (u64, Vec<Vec<u8>>) =
                    redis::cmd("SSCAN").arg(key).arg(ucur(&req.cursor)?).arg("COUNT").arg(count).query_async(c).await.map_err(map_err)?;
                page.columns = vec!["member".into()];
                page.rows = items.into_iter().map(|m| vec![bytes_value(m)]).collect();
                page.next = (next != 0).then(|| next.to_string());
            }
            "zset" => {
                let len: i64 = redis::cmd("ZCARD").arg(key).query_async(c).await.map_err(map_err)?;
                let start = off(&req.cursor)?;
                let items: Vec<(Vec<u8>, f64)> =
                    redis::cmd("ZRANGE").arg(key).arg(start).arg(start + count - 1).arg("WITHSCORES").query_async(c).await.map_err(map_err)?;
                page.length = Some(len as u64);
                page.columns = vec!["member".into(), "score".into()];
                let n = items.len() as i64;
                page.rows = items.into_iter().map(|(m, s)| vec![bytes_value(m), Value::Float(s)]).collect();
                page.next = (start + n < len && n > 0).then(|| (start + n).to_string());
            }
            "stream" => {
                page.length = Some(redis::cmd("XLEN").arg(key).query_async(c).await.map_err(map_err)?);
                let start = if req.cursor.is_empty() { "-".to_string() } else { req.cursor.clone() };
                let v: redis::Value = redis::cmd("XRANGE").arg(key).arg(&start).arg("+").arg("COUNT").arg(count).query_async(c).await.map_err(map_err)?;
                page.columns = vec!["id".into(), "fields".into()];
                let entries = match v {
                    redis::Value::Array(a) => a,
                    _ => vec![],
                };
                let mut last = None;
                for e in entries {
                    let redis::Value::Array(parts) = e else { continue };
                    let mut it = parts.into_iter();
                    let Some(id) = it.next().as_ref().and_then(val_string) else { continue };
                    let fields = match it.next() {
                        Some(redis::Value::Array(f)) => f
                            .chunks(2)
                            .map(|kv| {
                                (
                                    kv.first().and_then(val_string).unwrap_or_default(),
                                    serde_json::Value::String(kv.get(1).and_then(val_string).unwrap_or_default()),
                                )
                            })
                            .collect::<serde_json::Map<_, _>>(),
                        Some(redis::Value::Map(m)) => {
                            m.iter().map(|(k, v)| (val_string(k).unwrap_or_default(), serde_json::Value::String(val_string(v).unwrap_or_default()))).collect()
                        }
                        _ => serde_json::Map::new(),
                    };
                    page.rows.push(vec![Value::Text(id.clone()), Value::Json(serde_json::Value::Object(fields))]);
                    last = Some(id);
                }
                page.next = if page.rows.len() as i64 == count { last.as_deref().and_then(next_stream_id) } else { None };
            }
            "ReJSON-RL" => {
                let raw: Option<String> = redis::cmd("JSON.GET").arg(key).query_async(c).await.map_err(map_err)?;
                let raw = raw.unwrap_or_default();
                page.text = Some(serde_json::from_str::<serde_json::Value>(&raw).ok().and_then(|j| serde_json::to_string_pretty(&j).ok()).unwrap_or(raw));
            }
            _ => {}
        }
        Ok(page)
    }

    fn edit_commands(&self, db: &str, edits: &[KvEdit]) -> DbResult<Vec<String>> {
        let db = parse_db(db)?;
        let mut out = vec![format!("SELECT {db}")];
        for e in edits {
            out.push(command_line(&edit_args(e)?));
        }
        Ok(out)
    }

    /// All edits in one `MULTI`/`EXEC`. A rename onto an existing key is refused up front (conflict).
    async fn apply_edits(&self, db: &str, edits: &[KvEdit]) -> DbResult<ApplyReport> {
        if self.read_only {
            return Err(DbError::new(ErrorKind::PolicyBlocked, "connection is read-only"));
        }
        if edits.is_empty() {
            return Ok(ApplyReport { committed: true, ..Default::default() });
        }
        if edits.len() > 10_000 {
            return Err(DbError::invalid("too many staged changes"));
        }
        let dbn = parse_db(db)?;
        let cmds = edits.iter().map(edit_args).collect::<DbResult<Vec<_>>>()?;
        let mut g = self.on_db(dbn).await?;
        let mut conflicts = Vec::new();
        for (i, e) in edits.iter().enumerate() {
            if let KvEdit::Rename { to, .. } = e {
                let exists: bool = redis::cmd("EXISTS").arg(to).query_async(&mut g.conn).await.map_err(map_err)?;
                if exists {
                    conflicts.push(i);
                }
            }
        }
        if !conflicts.is_empty() {
            return Ok(ApplyReport { applied: 0, rows_affected: 0, conflicts, committed: false });
        }
        let mut p = redis::pipe();
        p.atomic();
        for a in &cmds {
            let mut c = redis::cmd(&a[0]);
            for x in &a[1..] {
                c.arg(x);
            }
            p.add_command(c);
        }
        let res: Vec<redis::Value> = p.query_async(&mut g.conn).await.map_err(map_err)?;
        drop(g);
        self.scans.lock().unwrap().reset_db(dbn);
        // RENAMENX answers 0 when the target appeared after the check above.
        let conflicts: Vec<usize> =
            edits.iter().enumerate().filter(|(i, e)| matches!(e, KvEdit::Rename { .. }) && res.get(*i).and_then(val_i64) == Some(0)).map(|(i, _)| i).collect();
        let n = edits.len() - conflicts.len();
        Ok(ApplyReport { applied: n, rows_affected: n as u64, conflicts, committed: true })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies() {
        assert_eq!(classify_redis_command("get"), "read");
        assert_eq!(classify_redis_command("FLUSHALL"), "destructive");
        assert_eq!(classify_redis_command("config"), "admin");
        assert_eq!(classify_redis_command("set"), "write");
        assert_eq!(classify_redis_command("select"), "session");
        assert_eq!(classify_redis_command("eval"), "unknown");
    }

    #[test]
    fn parses_keyspace_info() {
        let info = "# Keyspace\r\ndb0:keys=48213,expires=12,avg_ttl=0\r\ndb1:keys=3,expires=0,avg_ttl=0,subexpiry=0\r\ndb15:keys=1,expires=1,avg_ttl=99\r\nbogus:line\r\n";
        assert_eq!(parse_keyspace_info(info), vec![(0, 48213, 12), (1, 3, 0), (15, 1, 1)]);
        assert!(parse_keyspace_info("# Keyspace\r\n").is_empty());
        assert_eq!(parse_db("db3").unwrap(), 3);
        assert_eq!(parse_db("7").unwrap(), 7);
        assert!(parse_db("dbx").is_err());
        assert!(parse_db("-1").is_err());
    }

    #[test]
    fn groups_namespaces() {
        let keys = ["app:user:1", "app:user:2", "app:cfg", "app:order:9:items", "other", "app:"].map(String::from);
        let (ns, leaves) = group_namespaces("app:", ":", keys.clone());
        assert_eq!(
            ns,
            vec![
                NamespaceNode { prefix: "app:order:".into(), label: "order".into(), count: 1 },
                NamespaceNode { prefix: "app:user:".into(), label: "user".into(), count: 2 },
            ]
        );
        assert_eq!(leaves, vec!["app:", "app:cfg"]);
        let (root, leaves) = group_namespaces("", ":", keys);
        assert_eq!(root.iter().map(|n| (n.label.as_str(), n.count)).collect::<Vec<_>>(), vec![("app", 5)]);
        assert_eq!(leaves, vec!["other"]);
        // Multi-character separators.
        let (ns, _) = group_namespaces("", "::", ["a::b::c".to_string(), "a::d".to_string(), "a:e".to_string()]);
        assert_eq!(ns, vec![NamespaceNode { prefix: "a::".into(), label: "a".into(), count: 2 }]);
        assert_eq!(escape_glob("a*b?[c]\\d"), "a\\*b\\?\\[c\\]\\\\d");
    }

    /// Fake keyspace: SCAN returns `per_call` keys per call; cursor = index of the next key.
    struct Fake {
        keys: Vec<String>,
        per_call: usize,
        calls: usize,
    }

    #[async_trait]
    impl ScanSource for Fake {
        async fn scan(&mut self, cursor: u64) -> DbResult<(u64, Vec<String>)> {
            self.calls += 1;
            let start = cursor as usize;
            let end = (start + self.per_call).min(self.keys.len());
            Ok((if end >= self.keys.len() { 0 } else { end as u64 }, self.keys[start..end].to_vec()))
        }
    }

    #[tokio::test]
    async fn scan_paging_uses_cursor_cache() {
        let keys: Vec<String> = (0..95).map(|i| format!("k{i:03}")).collect();
        let cache = std::sync::Mutex::new(ScanCache::default());
        let ck = ScanCache::key(0, "*");
        let mut src = Fake { keys: keys.clone(), per_call: 7, calls: 0 };
        let mut all = Vec::new();
        let mut from = 0;
        loop {
            let (page, next, done) = scan_page(&cache, &ck, from, 10, MAX_SCAN_CALLS, &mut src).await.unwrap();
            assert!(page.len() <= 10);
            all.extend(page);
            assert!(next >= from);
            from = next;
            if done {
                break;
            }
        }
        assert_eq!(all, keys, "pages are contiguous, without gaps or repeats");
        // Each key is fetched from the server once: page N continues from the cached state.
        assert_eq!(src.calls, 95_usize.div_ceil(7));
        // Re-reading page 3 (positions 30..40) reuses the cached position, no rescan from 0.
        let before = src.calls;
        let (p3, next, _) = scan_page(&cache, &ck, 30, 10, MAX_SCAN_CALLS, &mut src).await.unwrap();
        assert_eq!(p3, keys[30..40].to_vec());
        assert_eq!(next, 40);
        assert!(src.calls - before <= 2, "{} calls", src.calls - before);
        // A different pattern has its own scan; reset forgets one, reset_db all of a database.
        let ck2 = ScanCache::key(0, "k0*");
        scan_page(&cache, &ck2, 0, 5, MAX_SCAN_CALLS, &mut src).await.unwrap();
        assert_eq!(cache.lock().unwrap().len(), 2);
        cache.lock().unwrap().reset(&ck2);
        assert_eq!(cache.lock().unwrap().len(), 1);
        cache.lock().unwrap().reset_db(0);
        assert!(cache.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn scan_page_respects_call_budget() {
        // Sparse match: the server returns empty batches; the page stops at the budget and is not done.
        struct Empty(u64);
        #[async_trait]
        impl ScanSource for Empty {
            async fn scan(&mut self, cursor: u64) -> DbResult<(u64, Vec<String>)> {
                self.0 += 1;
                Ok((cursor + 1, vec![]))
            }
        }
        let cache = std::sync::Mutex::new(ScanCache::default());
        let mut src = Empty(0);
        let (keys, next, done) = scan_page(&cache, "x", 0, 10, 5, &mut src).await.unwrap();
        assert!(keys.is_empty());
        assert_eq!((next, done, src.0), (0, false, 5));
        // The next call continues from the remembered server cursor.
        scan_page(&cache, "x", 0, 10, 5, &mut src).await.unwrap();
        assert_eq!(cache.lock().unwrap().before("x", 0).1.cursor, 10);
    }

    #[test]
    fn edit_commands_are_quoted_and_classified() {
        let edits = vec![
            KvEdit::SetString { key: "user:1".into(), value: "say \"hi\"\nbye".into() },
            KvEdit::Expire { key: "k".into(), seconds: -1 },
            KvEdit::Expire { key: "k".into(), seconds: 60 },
            KvEdit::Rename { key: "a".into(), to: "b c".into() },
            KvEdit::Delete { key: "gone".into() },
            KvEdit::HashSet { key: "h".into(), field: "f".into(), value: "".into() },
            KvEdit::ZsetAdd { key: "z".into(), member: "m".into(), score: 1.5 },
            KvEdit::ListRemove { key: "l".into(), value: "x".into() },
        ];
        let lines: Vec<String> = edits.iter().map(|e| command_line(&edit_args(e).unwrap())).collect();
        assert_eq!(
            lines,
            vec![
                r#"SET "user:1" "say \"hi\"\nbye" KEEPTTL"#,
                "PERSIST k",
                "EXPIRE k 60",
                r#"RENAMENX a "b c""#,
                "UNLINK gone",
                r#"HSET h f """#,
                "ZADD z 1.5 m",
                "LREM l 1 x",
            ]
        );
        // What the preview shows is exactly what runs.
        for (l, e) in lines.iter().zip(&edits) {
            assert_eq!(tokenize_command(l).unwrap(), edit_args(e).unwrap());
        }
        let risks: Vec<Risk> = lines.iter().map(|l| dbs_safety::classify_redis(&tokenize_command(l).unwrap()[0])).collect();
        assert!(risks[..4].iter().all(|r| *r == Risk::Write));
        assert_eq!(risks[4], Risk::Destructive);
        assert!(edit_args(&KvEdit::Expire { key: "k".into(), seconds: 0 }).is_err());
        assert!(edit_args(&KvEdit::Rename { key: "k".into(), to: "k".into() }).is_err());
        assert!(edit_args(&KvEdit::Delete { key: "".into() }).is_err());
        assert!(edit_args(&KvEdit::ZsetAdd { key: "z".into(), member: "m".into(), score: f64::NAN }).is_err());
        assert_eq!(next_stream_id("1700000000000-3").as_deref(), Some("1700000000000-4"));
    }
}
