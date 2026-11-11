//! Redis driver. Redis is not SQL: "execute" takes one command per line
//! (`GET key`, `HSET h f v`), tokenised with shell-style quoting. Objects are keys
//! discovered with SCAN (never KEYS). Destructive/admin commands are classified
//! by `classify_redis_command` for the safety policy.

use std::time::Instant;

use async_trait::async_trait;
use dbs_core::*;
use redis::aio::MultiplexedConnection;
use redis::{AsyncCommands, RedisError};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::util::{elapsed_ms, excerpt, guarded};

pub struct RedisDriver;

pub struct RedisConnection {
    conn: Mutex<MultiplexedConnection>,
    read_only: bool,
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

/// Risk class for a Redis command (mirrors `dbs_safety::Risk` names).
pub fn classify_redis_command(cmd: &str) -> &'static str {
    match cmd.to_ascii_uppercase().as_str() {
        "GET" | "MGET" | "EXISTS" | "TYPE" | "TTL" | "PTTL" | "STRLEN" | "HGET" | "HGETALL" | "HMGET" | "HKEYS" | "HVALS" | "HLEN" | "LRANGE" | "LLEN"
        | "LINDEX" | "SMEMBERS" | "SCARD" | "SISMEMBER" | "ZRANGE" | "ZRANGEBYSCORE" | "ZCARD" | "ZSCORE" | "SCAN" | "HSCAN" | "SSCAN" | "ZSCAN" | "INFO"
        | "DBSIZE" | "PING" | "ECHO" | "XRANGE" | "XLEN" | "XINFO" | "OBJECT" | "MEMORY" | "GETRANGE" | "BITCOUNT" | "PFCOUNT" | "GEOPOS" | "GEODIST"
        | "TIME" | "LASTSAVE" | "ROLE" => "read",
        "FLUSHALL" | "FLUSHDB" | "DEL" | "UNLINK" => "destructive",
        "CONFIG" | "SHUTDOWN" | "DEBUG" | "SLAVEOF" | "REPLICAOF" | "MODULE" | "ACL" | "CLIENT" | "SAVE" | "BGSAVE" | "BGREWRITEAOF" | "MIGRATE"
        | "FAILOVER" | "CLUSTER" | "SCRIPT" | "FUNCTION" | "KEYS" | "MONITOR" | "SYNC" | "PSYNC" => "admin",
        "EVAL" | "EVALSHA" | "EVAL_RO" | "FCALL" | "MULTI" | "EXEC" => "unknown",
        _ => "write",
    }
}

/// Split one command line respecting "double", 'single' quotes and backslash escapes.
pub fn tokenize_command(line: &str) -> DbResult<Vec<String>> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_tok = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' | '\'' => {
                in_tok = true;
                let q = c;
                loop {
                    match chars.next() {
                        Some('\\') if q == '"' => match chars.next() {
                            Some('n') => cur.push('\n'),
                            Some('t') => cur.push('\t'),
                            Some(o) => cur.push(o),
                            None => return Err(DbError::invalid("unterminated escape")),
                        },
                        Some(x) if x == q => break,
                        Some(x) => cur.push(x),
                        None => return Err(DbError::invalid("unterminated quote")),
                    }
                }
            }
            c if c.is_whitespace() => {
                if in_tok {
                    out.push(std::mem::take(&mut cur));
                    in_tok = false;
                }
            }
            c => {
                in_tok = true;
                cur.push(c);
            }
        }
    }
    if in_tok {
        out.push(cur);
    }
    Ok(out)
}

fn to_value(v: redis::Value) -> Value {
    use redis::Value as R;
    match v {
        R::Nil => Value::Null,
        R::Int(i) => Value::from_i64(i),
        R::BulkString(b) => match String::from_utf8(b) {
            Ok(s) => Value::Text(s),
            Err(e) => Value::from_bytes(e.as_bytes()),
        },
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

#[async_trait]
impl DatabaseDriver for RedisDriver {
    fn engines(&self) -> &'static [Engine] {
        &[Engine::Redis]
    }

    async fn connect(&self, cfg: &ConnectionConfig, secrets: ConnectSecrets) -> DbResult<Box<dyn DatabaseConnection>> {
        cfg.validate()?;
        let host = cfg.host.clone().unwrap_or_else(|| "localhost".into());
        let port = cfg.effective_port().unwrap_or(6379);
        let db: i64 = cfg.database.as_deref().unwrap_or("0").parse().map_err(|_| DbError::invalid("Redis database must be a number"))?;
        let addr = if cfg.tls.mode == TlsMode::Disable {
            redis::ConnectionAddr::Tcp(host, port)
        } else {
            if cfg.tls.ca_cert_path.is_some() || cfg.tls.client_cert_path.is_some() {
                return Err(DbError::unsupported("custom CA / client certificates for Redis (use system trust store)"));
            }
            redis::ConnectionAddr::TcpTls { host, port, insecure: false, tls_params: None }
        };
        let info = redis::ConnectionInfo {
            addr,
            redis: redis::RedisConnectionInfo {
                db,
                username: cfg.username.clone().filter(|u| !u.is_empty()),
                password: secrets.password.clone(),
                ..Default::default()
            },
        };
        drop(secrets);
        let client = redis::Client::open(info).map_err(map_err)?;
        let conn = tokio::time::timeout(std::time::Duration::from_secs(cfg.connect_timeout_secs as u64), client.get_multiplexed_async_connection())
            .await
            .map_err(|_| DbError::new(ErrorKind::Timeout, "connection timed out"))?
            .map_err(map_err)?;
        Ok(Box::new(RedisConnection { conn: Mutex::new(conn), read_only: cfg.read_only }))
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
            schemas: false,
            multiple_databases: true,
            cancel: false,
            object_kinds: vec![ObjectKind::Key],
            ..Default::default()
        }
    }

    async fn server_info(&self) -> DbResult<ServerInfo> {
        let info: String = redis::cmd("INFO").arg("server").query_async(&mut *self.conn.lock().await).await.map_err(map_err)?;
        let version = info.lines().find_map(|l| l.strip_prefix("redis_version:")).unwrap_or("").to_string();
        Ok(ServerInfo { engine: Engine::Redis, version, current_database: None, current_user: None, tls_version: None })
    }

    async fn ping(&self) -> DbResult<()> {
        let _: String = redis::cmd("PING").query_async(&mut *self.conn.lock().await).await.map_err(map_err)?;
        Ok(())
    }

    async fn close(&self) -> DbResult<()> {
        Ok(())
    }

    async fn list_databases(&self) -> DbResult<Vec<String>> {
        let n: Vec<String> = redis::cmd("CONFIG").arg("GET").arg("databases").query_async(&mut *self.conn.lock().await).await.unwrap_or_default();
        let count: usize = n.get(1).and_then(|s| s.parse().ok()).unwrap_or(16);
        Ok((0..count).map(|i| i.to_string()).collect())
    }

    async fn list_schemas(&self, _db: Option<&str>) -> DbResult<Vec<String>> {
        Ok(vec![])
    }

    /// First 5,000 keys via SCAN (pattern = `schema` if given, else `*`).
    async fn list_objects(&self, pattern: Option<&str>) -> DbResult<Vec<ObjectRef>> {
        let mut c = self.conn.lock().await;
        let pat = pattern.filter(|p| !p.is_empty()).unwrap_or("*").to_string();
        let mut cursor: u64 = 0;
        let mut out = Vec::new();
        loop {
            let (next, keys): (u64, Vec<String>) =
                redis::cmd("SCAN").arg(cursor).arg("MATCH").arg(&pat).arg("COUNT").arg(500).query_async(&mut *c).await.map_err(map_err)?;
            out.extend(keys.into_iter().map(|k| ObjectRef { kind: ObjectKind::Key, database: None, schema: None, name: k }));
            cursor = next;
            if cursor == 0 || out.len() >= 5000 {
                break;
            }
        }
        out.truncate(5000);
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    async fn describe_table(&self, target: &TableTarget) -> DbResult<TableDescription> {
        let mut c = self.conn.lock().await;
        let ty: String = redis::cmd("TYPE").arg(&target.table).query_async(&mut *c).await.map_err(map_err)?;
        let ttl: i64 = c.ttl(&target.table).await.map_err(map_err)?;
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
                let parts = tokenize_command(line)?;
                let Some((name, args)) = parts.split_first() else { continue };
                let class = classify_redis_command(name);
                if self.read_only && class != "read" {
                    return Err(DbError::new(ErrorKind::PolicyBlocked, format!("{name} is not allowed on a read-only connection")));
                }
                if matches!(name.to_ascii_uppercase().as_str(), "MONITOR" | "SUBSCRIBE" | "PSUBSCRIBE" | "SSUBSCRIBE" | "SYNC" | "PSYNC") {
                    return Err(DbError::unsupported(&format!("{name} (streaming command)")));
                }
                let mut cmd = redis::cmd(name);
                for a in args {
                    cmd.arg(a);
                }
                let v: redis::Value = cmd.query_async(&mut *self.conn.lock().await).await.map_err(map_err)?;
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

    async fn fetch_table(&self, target: &TableTarget, page: &PageRequest) -> DbResult<ResultSet> {
        let mut c = self.conn.lock().await;
        let key = &target.table;
        let ty: String = redis::cmd("TYPE").arg(key).query_async(&mut *c).await.map_err(map_err)?;
        let start = page.offset as isize;
        let stop = (page.offset + page.limit.clamp(1, MAX_PAGE_SIZE)) as isize - 1;
        let col = |n: &str| ColumnMeta { name: n.into(), type_name: "text".into(), nullable: None, table: None };
        let (columns, rows) = match ty.as_str() {
            "string" => {
                let v: Option<Vec<u8>> = c.get(key).await.map_err(map_err)?;
                (
                    vec![col("value")],
                    vec![vec![v.map(|b| String::from_utf8(b).map(Value::Text).unwrap_or_else(|e| Value::from_bytes(e.as_bytes()))).unwrap_or(Value::Null)]],
                )
            }
            "list" => {
                let v: Vec<String> = c.lrange(key, start, stop).await.map_err(map_err)?;
                (vec![col("index"), col("value")], v.into_iter().enumerate().map(|(i, s)| vec![Value::Int(start as i64 + i as i64), Value::Text(s)]).collect())
            }
            "hash" => {
                let (_, v): (u64, Vec<(String, String)>) =
                    redis::cmd("HSCAN").arg(key).arg(0).arg("COUNT").arg(page.limit.max(100)).query_async(&mut *c).await.map_err(map_err)?;
                (vec![col("field"), col("value")], v.into_iter().map(|(f, x)| vec![Value::Text(f), Value::Text(x)]).collect())
            }
            "set" => {
                let (_, v): (u64, Vec<String>) =
                    redis::cmd("SSCAN").arg(key).arg(0).arg("COUNT").arg(page.limit.max(100)).query_async(&mut *c).await.map_err(map_err)?;
                (vec![col("member")], v.into_iter().map(|m| vec![Value::Text(m)]).collect())
            }
            "zset" => {
                let v: Vec<(String, f64)> = c.zrange_withscores(key, start, stop).await.map_err(map_err)?;
                (vec![col("member"), col("score")], v.into_iter().map(|(m, s)| vec![Value::Text(m), Value::Float(s)]).collect())
            }
            "none" => return Err(DbError::new(ErrorKind::NotFound, "key not found")),
            other => return Err(DbError::unsupported(&format!("browsing {other} values"))),
        };
        Ok(ResultSet { columns, rows, truncated: false })
    }

    async fn count_rows(&self, target: &TableTarget, _f: &[FilterCondition]) -> DbResult<u64> {
        let mut c = self.conn.lock().await;
        let ty: String = redis::cmd("TYPE").arg(&target.table).query_async(&mut *c).await.map_err(map_err)?;
        let cmd = match ty.as_str() {
            "list" => "LLEN",
            "hash" => "HLEN",
            "set" => "SCARD",
            "zset" => "ZCARD",
            "stream" => "XLEN",
            _ => return Ok(1),
        };
        redis::cmd(cmd).arg(&target.table).query_async(&mut *c).await.map_err(map_err)
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizes_quotes() {
        assert_eq!(tokenize_command(r#"SET "my key" 'a b' c\d"#).unwrap(), vec!["SET", "my key", "a b", "c\\d"]);
        assert_eq!(tokenize_command(r#"SET k "line\nnext""#).unwrap(), vec!["SET", "k", "line\nnext"]);
        assert!(tokenize_command("SET \"oops").is_err());
    }

    #[test]
    fn classifies() {
        assert_eq!(classify_redis_command("get"), "read");
        assert_eq!(classify_redis_command("FLUSHALL"), "destructive");
        assert_eq!(classify_redis_command("config"), "admin");
        assert_eq!(classify_redis_command("set"), "write");
        assert_eq!(classify_redis_command("eval"), "unknown");
    }
}
