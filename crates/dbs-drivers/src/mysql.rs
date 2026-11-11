use std::time::{Duration, Instant};

use async_trait::async_trait;
use dbs_core::*;
use mysql_async::consts::{ColumnFlags, ColumnType};
use mysql_async::prelude::*;
use mysql_async::{Conn, Opts, OptsBuilder, SslOpts};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::util::{elapsed_ms, excerpt, guarded};

pub struct MySqlDriver;

pub struct MySqlConnection {
    conn: Mutex<Conn>,
    opts: Opts,
    conn_id: u32,
    engine: Engine,
}

fn map_err(e: mysql_async::Error) -> DbError {
    match &e {
        mysql_async::Error::Server(s) => {
            let kind = match s.code {
                1045 | 1044 | 1698 => ErrorKind::Authentication,
                1142 | 1143 | 1227 | 1370 => ErrorKind::Permission,
                1792 => ErrorKind::Permission, // read-only transaction
                1062 | 1451 | 1452 | 1048 | 1364 | 3819 | 1216 | 1217 => ErrorKind::Constraint,
                1064 | 1054 | 1052 | 1149 => ErrorKind::Syntax,
                1146 | 1049 | 1051 | 1091 => ErrorKind::NotFound,
                1205 | 1213 => ErrorKind::TransactionConflict,
                1317 => ErrorKind::Cancelled,
                3024 => ErrorKind::Timeout,
                _ => ErrorKind::Internal,
            };
            DbError::new(kind, s.message.clone()).with_code(format!("{} ({})", s.code, s.state))
        }
        mysql_async::Error::Io(_) => {
            let s = e.to_string();
            let kind = if s.to_ascii_lowercase().contains("tls") || s.contains("certificate") { ErrorKind::Tls } else { ErrorKind::Connection };
            DbError::new(kind, s)
        }
        mysql_async::Error::Driver(_) => DbError::new(ErrorKind::Connection, e.to_string()),
        _ => DbError::new(ErrorKind::Internal, e.to_string()),
    }
}

#[async_trait]
impl DatabaseDriver for MySqlDriver {
    fn engines(&self) -> &'static [Engine] {
        &[Engine::MySql, Engine::MariaDb, Engine::Percona, Engine::SingleStore]
    }

    async fn connect(&self, cfg: &ConnectionConfig, secrets: ConnectSecrets) -> DbResult<Box<dyn DatabaseConnection>> {
        cfg.validate()?;
        let mut b = OptsBuilder::default()
            .user(cfg.username.clone())
            .pass(secrets.password.clone())
            .db_name(cfg.database.clone().filter(|d| !d.is_empty()))
            .prefer_socket(false)
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .conn_ttl(None)
            .wait_timeout(Some(28_800))
            .client_found_rows(false);
        drop(secrets);
        if let Some(sock) = &cfg.socket_path {
            b = b.socket(Some(sock.clone()));
        } else {
            b = b.ip_or_hostname(cfg.host.clone().unwrap_or_default()).tcp_port(cfg.effective_port().unwrap_or(3306));
        }
        let plain: Opts = b.clone().into();
        if cfg.tls.mode != TlsMode::Disabled {
            let mut ssl = SslOpts::default();
            if let Some(ca) = &cfg.tls.ca_cert_path {
                ssl = ssl.with_root_certs(vec![std::path::PathBuf::from(ca).into()]);
            }
            if let Some(cert) = &cfg.tls.client_cert_path {
                // native-tls takes the client identity as a PKCS#12 archive.
                let lower = cert.to_ascii_lowercase();
                if !(lower.ends_with(".p12") || lower.ends_with(".pfx")) {
                    return Err(DbError::new(ErrorKind::Tls, "MySQL client certificates must be a PKCS#12 (.p12/.pfx) file"));
                }
                let id = mysql_async::ClientIdentity::new(std::path::PathBuf::from(cert).into());
                ssl = ssl.with_client_identity(Some(id));
            }
            ssl = match cfg.tls.mode {
                TlsMode::VerifyIdentity | TlsMode::Disabled => ssl,
                TlsMode::VerifyCa => ssl.with_danger_skip_domain_validation(true),
                TlsMode::Required | TlsMode::Preferred => ssl.with_danger_accept_invalid_certs(true).with_danger_skip_domain_validation(true),
            };
            b = b.ssl_opts(Some(ssl));
        }
        let timeout = Duration::from_secs(cfg.connect_timeout_secs as u64);
        let dial = |opts: Opts| async move {
            tokio::time::timeout(timeout, Conn::new(opts)).await.map_err(|_| DbError::new(ErrorKind::Timeout, "connection timed out"))
        };
        let mut opts: Opts = b.into();
        let conn = match dial(opts.clone()).await? {
            // PREFERRED (MySQL client default): only when the server doesn't offer TLS at all,
            // retry in plaintext. Any other TLS failure is reported, never silently downgraded.
            Err(mysql_async::Error::Driver(mysql_async::DriverError::NoClientSslFlagFromServer)) if cfg.tls.mode == TlsMode::Preferred => {
                tracing::info!("server does not support TLS; SSL mode PREFERRED falls back to plaintext");
                opts = plain;
                dial(opts.clone()).await?.map_err(map_err)?
            }
            r => r.map_err(map_err)?,
        };
        let conn_id = conn.id();
        let me = MySqlConnection { conn: Mutex::new(conn), opts, conn_id, engine: cfg.engine };
        if cfg.read_only {
            me.set_read_only(true).await?;
        }
        if let Some(init) = &cfg.init_sql {
            me.conn.lock().await.query_drop(init.as_str()).await.map_err(map_err)?;
        }
        Ok(Box::new(me))
    }
}

/// Text-protocol bytes → typed Value, using column metadata.
fn decode(v: mysql_async::Value, col: &mysql_async::Column) -> Value {
    use mysql_async::Value as M;
    let ct = col.column_type();
    let unsigned = col.flags().contains(ColumnFlags::UNSIGNED_FLAG);
    let binary_cs = col.character_set() == 63;
    match v {
        M::NULL => Value::Null,
        M::Int(i) => Value::from_i64(i),
        M::UInt(u) => Value::from_u64(u),
        M::Float(f) => Value::Float(f as f64),
        M::Double(f) => Value::Float(f),
        M::Date(y, mo, d, h, mi, s, us) => {
            if matches!(ct, ColumnType::MYSQL_TYPE_DATE | ColumnType::MYSQL_TYPE_NEWDATE) {
                Value::Date(format!("{y:04}-{mo:02}-{d:02}"))
            } else {
                Value::Timestamp { iso: format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}{}", frac(us)), tz: false }
            }
        }
        M::Time(neg, d, h, mi, s, us) => Value::Time(format!("{}{:02}:{mi:02}:{s:02}{}", if neg { "-" } else { "" }, d * 24 + h as u32, frac(us))),
        M::Bytes(b) => {
            use ColumnType::*;
            match ct {
                MYSQL_TYPE_TINY | MYSQL_TYPE_SHORT | MYSQL_TYPE_INT24 | MYSQL_TYPE_LONG | MYSQL_TYPE_LONGLONG | MYSQL_TYPE_YEAR => {
                    let s = String::from_utf8_lossy(&b);
                    if ct == MYSQL_TYPE_TINY && col.column_length() == 1 {
                        return Value::Bool(s != "0");
                    }
                    if unsigned {
                        s.parse::<u64>().map(Value::from_u64).unwrap_or_else(|_| Value::BigInt(s.into_owned()))
                    } else {
                        s.parse::<i64>().map(Value::from_i64).unwrap_or_else(|_| Value::BigInt(s.into_owned()))
                    }
                }
                MYSQL_TYPE_FLOAT | MYSQL_TYPE_DOUBLE => {
                    let s = String::from_utf8_lossy(&b);
                    s.parse::<f64>().map(Value::Float).unwrap_or_else(|_| Value::Text(s.into_owned()))
                }
                MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => Value::Decimal(String::from_utf8_lossy(&b).into_owned()),
                MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => Value::Date(String::from_utf8_lossy(&b).into_owned()),
                MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => Value::Time(String::from_utf8_lossy(&b).into_owned()),
                MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 | MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIMESTAMP2 => {
                    Value::Timestamp { iso: String::from_utf8_lossy(&b).replacen(' ', "T", 1), tz: false }
                }
                MYSQL_TYPE_JSON => match serde_json::from_slice(&b) {
                    Ok(j) => Value::Json(j),
                    Err(_) => Value::Text(String::from_utf8_lossy(&b).into_owned()),
                },
                MYSQL_TYPE_BIT => {
                    let mut n: u64 = 0;
                    for byte in b.iter().take(8) {
                        n = (n << 8) | *byte as u64;
                    }
                    if col.column_length() == 1 {
                        Value::Bool(n != 0)
                    } else {
                        Value::from_u64(n)
                    }
                }
                MYSQL_TYPE_GEOMETRY => Value::Other { type_name: "geometry".into(), text: hex_encode(&b) },
                _ if binary_cs => Value::from_bytes(&b),
                _ => match String::from_utf8(b) {
                    Ok(s) => Value::Text(s),
                    Err(e) => Value::from_bytes(e.as_bytes()),
                },
            }
        }
    }
}

fn frac(us: u32) -> String {
    if us == 0 {
        String::new()
    } else {
        format!(".{us:06}")
    }
}

fn type_name(c: &mysql_async::Column) -> String {
    format!("{:?}", c.column_type()).trim_start_matches("MYSQL_TYPE_").to_ascii_lowercase()
}

fn to_mysql(v: &Value) -> DbResult<mysql_async::Value> {
    use mysql_async::Value as M;
    Ok(match v {
        Value::Null => M::NULL,
        Value::Bool(b) => M::Int(*b as i64),
        Value::Int(i) => M::Int(*i),
        Value::Float(f) => M::Double(*f),
        Value::Bytes { hex, truncated, .. } => {
            if *truncated {
                return Err(DbError::invalid("cannot write a truncated binary value"));
            }
            M::Bytes(hex_decode(hex).ok_or_else(|| DbError::invalid("invalid hex"))?)
        }
        Value::Json(j) => M::Bytes(j.to_string().into_bytes()),
        Value::Timestamp { iso, .. } => M::Bytes(iso.trim_end_matches('Z').replacen('T', " ", 1).into_bytes()),
        other => M::Bytes(other.to_plain().unwrap_or_default().into_bytes()),
    })
}

impl MySqlConnection {
    async fn text_rows(&self, sql: &str, params: Vec<mysql_async::Value>) -> DbResult<Vec<Vec<Option<String>>>> {
        let mut c = self.conn.lock().await;
        let rows: Vec<mysql_async::Row> = c.exec(sql, mysql_async::Params::Positional(params)).await.map_err(map_err)?;
        Ok(rows
            .into_iter()
            .map(|r| {
                r.unwrap()
                    .into_iter()
                    .map(|v| match v {
                        mysql_async::Value::NULL => None,
                        mysql_async::Value::Bytes(b) => Some(String::from_utf8_lossy(&b).into_owned()),
                        mysql_async::Value::Int(i) => Some(i.to_string()),
                        mysql_async::Value::UInt(u) => Some(u.to_string()),
                        other => Some(other.as_sql(true).trim_matches('\'').to_string()),
                    })
                    .collect()
            })
            .collect())
    }

    async fn current_db(&self, schema: Option<&str>) -> DbResult<String> {
        if let Some(s) = schema.filter(|s| !s.is_empty()) {
            return Ok(s.to_string());
        }
        self.text_rows("SELECT DATABASE()", vec![])
            .await?
            .into_iter()
            .next()
            .and_then(|r| r.into_iter().next().flatten())
            .ok_or_else(|| DbError::invalid("no database selected"))
    }

    async fn kill_query(&self) {
        if let Ok(mut c) = Conn::new(self.opts.clone()).await {
            let _ = c.query_drop(format!("KILL QUERY {}", self.conn_id)).await;
            let _ = c.disconnect().await;
        }
    }

    async fn run_script(&self, sql: &str, max_rows: usize) -> DbResult<Vec<StatementResult>> {
        let stmts = dbs_safety::split_statements(sql, Dialect::MySql);
        let mut c = self.conn.lock().await;
        let mut out = Vec::new();
        for (idx, st) in stmts.iter().enumerate() {
            let t = Instant::now();
            let mut res = c.query_iter(st.text.as_str()).await.map_err(|e| {
                let mut e = map_err(e);
                if stmts.len() > 1 {
                    e.message = format!("statement {} failed: {}", idx + 1, e.message);
                }
                e
            })?;
            // A statement (e.g. CALL) may produce several result sets.
            loop {
                let columns_meta = res.columns();
                let cols: Vec<mysql_async::Column> = columns_meta.as_deref().map(|c| c.to_vec()).unwrap_or_default();
                let mut rows = Vec::new();
                let mut truncated = false;
                while let Some(mut row) = res.next().await.map_err(map_err)? {
                    if rows.len() >= max_rows {
                        truncated = true;
                        continue; // drain without storing
                    }
                    let vals = (0..cols.len()).map(|i| decode(row.take(i).unwrap_or(mysql_async::Value::NULL), &cols[i])).collect();
                    rows.push(vals);
                }
                let affected = res.affected_rows();
                let result = (!cols.is_empty()).then(|| ResultSet {
                    columns: cols
                        .iter()
                        .map(|c| ColumnMeta {
                            name: c.name_str().into_owned(),
                            type_name: type_name(c),
                            nullable: Some(!c.flags().contains(ColumnFlags::NOT_NULL_FLAG)),
                            table: Some(c.org_table_str().into_owned()).filter(|s| !s.is_empty()),
                        })
                        .collect(),
                    rows,
                    truncated,
                });
                let has_result = result.is_some();
                out.push(StatementResult {
                    statement_index: idx,
                    sql_excerpt: excerpt(&st.text),
                    result,
                    rows_affected: if has_result { None } else { Some(affected) },
                    duration_ms: elapsed_ms(t),
                    notices: vec![],
                });
                if res.is_empty() {
                    break;
                }
            }
            drop(res);
            // Warnings → notices
            if c.get_warnings() > 0 {
                if let Ok(w) = c.query::<(String, u32, String), _>("SHOW WARNINGS LIMIT 50").await {
                    if let Some(last) = out.last_mut() {
                        last.notices = w.into_iter().map(|(lvl, code, msg)| format!("{lvl} {code}: {msg}")).collect();
                    }
                }
            }
        }
        Ok(out)
    }
}

#[async_trait]
impl DatabaseConnection for MySqlConnection {
    fn engine(&self) -> Engine {
        self.engine
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            sql: true,
            transactions: true,
            schemas: true, // databases are presented as schemas
            multiple_databases: true,
            explain: true,
            explain_analyze: self.engine != Engine::SingleStore,
            cancel: true,
            inline_edit: true,
            ddl_editing: true,
            read_only_session: true,
            sessions_monitor: true,
            kill_session: true,
            native_backup: false,
            object_kinds: vec![
                ObjectKind::Table,
                ObjectKind::View,
                ObjectKind::Function,
                ObjectKind::Procedure,
                ObjectKind::Trigger,
                ObjectKind::Event,
                ObjectKind::Index,
            ],
        }
    }

    async fn server_info(&self) -> DbResult<ServerInfo> {
        let r = self.text_rows("SELECT VERSION(), DATABASE(), CURRENT_USER()", vec![]).await?;
        let r = r.into_iter().next().unwrap_or_default();
        Ok(ServerInfo {
            engine: self.engine,
            version: r.first().cloned().flatten().unwrap_or_default(),
            current_database: r.get(1).cloned().flatten(),
            current_user: r.get(2).cloned().flatten(),
        })
    }

    async fn ping(&self) -> DbResult<()> {
        self.conn.lock().await.ping().await.map_err(map_err)
    }

    async fn close(&self) -> DbResult<()> {
        Ok(())
    }

    async fn list_databases(&self) -> DbResult<Vec<String>> {
        Ok(self.text_rows("SHOW DATABASES", vec![]).await?.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
    }

    async fn list_schemas(&self, _db: Option<&str>) -> DbResult<Vec<String>> {
        self.list_databases().await
    }

    async fn list_objects(&self, schema: Option<&str>) -> DbResult<Vec<ObjectRef>> {
        let db = self.current_db(schema).await?;
        let rows = self
            .text_rows(
                "SELECT IF(TABLE_TYPE='VIEW','view','table'), TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?
                 UNION ALL SELECT LOWER(ROUTINE_TYPE), ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
                 UNION ALL SELECT 'trigger', TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
                 UNION ALL SELECT 'event', EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?
                 ORDER BY 1, 2",
                vec![db.clone().into(), db.clone().into(), db.clone().into(), db.clone().into()],
            )
            .await?;
        Ok(rows
            .into_iter()
            .filter_map(|r| {
                let kind = match r[0].as_deref()? {
                    "table" => ObjectKind::Table,
                    "view" => ObjectKind::View,
                    "function" => ObjectKind::Function,
                    "procedure" => ObjectKind::Procedure,
                    "trigger" => ObjectKind::Trigger,
                    "event" => ObjectKind::Event,
                    _ => return None,
                };
                Some(ObjectRef { kind, database: None, schema: Some(db.clone()), name: r[1].clone()? })
            })
            .collect())
    }

    async fn describe_table(&self, target: &TableTarget) -> DbResult<TableDescription> {
        let db = self.current_db(target.schema.as_deref()).await?;
        let t = target.table.clone();
        let p = || vec![mysql_async::Value::from(db.clone()), mysql_async::Value::from(t.clone())];
        let cols = self
            .text_rows(
                "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, ORDINAL_POSITION, COLUMN_KEY
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
                p(),
            )
            .await?;
        if cols.is_empty() {
            return Err(DbError::new(ErrorKind::NotFound, "table not found"));
        }
        let columns: Vec<ColumnDef> = cols
            .iter()
            .map(|r| ColumnDef {
                name: r[0].clone().unwrap_or_default(),
                data_type: r[1].clone().unwrap_or_default(),
                nullable: r[2].as_deref() == Some("YES"),
                default: r[3].clone(),
                is_identity: r[4].as_deref().unwrap_or("").contains("auto_increment"),
                comment: r[5].clone().filter(|s| !s.is_empty()),
                ordinal: r[6].as_deref().and_then(|x| x.parse().ok()).unwrap_or(0),
                is_primary_key: r[7].as_deref() == Some("PRI"),
            })
            .collect();
        let idx = self
            .text_rows(
                "SELECT INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COALESCE(COLUMN_NAME, '<expr>') ORDER BY SEQ_IN_INDEX SEPARATOR ','), MAX(INDEX_TYPE)
                 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? GROUP BY INDEX_NAME, NON_UNIQUE ORDER BY INDEX_NAME",
                p(),
            )
            .await?;
        let indexes: Vec<IndexDef> = idx
            .iter()
            .map(|r| IndexDef {
                name: r[0].clone().unwrap_or_default(),
                unique: r[1].as_deref() == Some("0"),
                primary: r[0].as_deref() == Some("PRIMARY"),
                columns: r[2].clone().unwrap_or_default().split(',').map(String::from).collect(),
                definition: r[3].clone(),
            })
            .collect();
        let primary_key = indexes.iter().find(|i| i.primary).map(|i| i.columns.clone()).unwrap_or_default();
        let fks = self
            .text_rows(
                "SELECT k.CONSTRAINT_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME,
                        GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ','),
                        GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ','),
                        MAX(r.UPDATE_RULE), MAX(r.DELETE_RULE)
                 FROM information_schema.KEY_COLUMN_USAGE k
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
                 WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
                 GROUP BY k.CONSTRAINT_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME ORDER BY 1",
                p(),
            )
            .await?;
        let split = |s: &Option<String>| s.clone().unwrap_or_default().split(',').filter(|x| !x.is_empty()).map(String::from).collect::<Vec<_>>();
        let checks = self
            .text_rows(
                "SELECT tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, cc.CHECK_CLAUSE FROM information_schema.TABLE_CONSTRAINTS tc
                 LEFT JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
                 WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE IN ('CHECK','UNIQUE')",
                p(),
            )
            .await
            .unwrap_or_default(); // CHECK_CONSTRAINTS is absent before MySQL 8.0.16 / MariaDB 10.2
        let meta = self
            .text_rows("SELECT TABLE_ROWS, TABLE_COMMENT, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", p())
            .await?;
        let meta = meta.into_iter().next().unwrap_or_default();
        let is_view = meta.get(2).cloned().flatten().as_deref() == Some("VIEW");
        let object = ObjectRef { kind: if is_view { ObjectKind::View } else { ObjectKind::Table }, database: None, schema: Some(db.clone()), name: t.clone() };
        let ddl = self.object_ddl(&object).await.ok();
        Ok(TableDescription {
            object,
            columns,
            primary_key,
            indexes,
            foreign_keys: fks
                .iter()
                .map(|r| ForeignKeyDef {
                    name: r[0].clone().unwrap_or_default(),
                    ref_schema: r[1].clone(),
                    ref_table: r[2].clone().unwrap_or_default(),
                    columns: split(&r[3]),
                    ref_columns: split(&r[4]),
                    on_update: r[5].clone(),
                    on_delete: r[6].clone(),
                })
                .collect(),
            constraints: checks
                .iter()
                .map(|r| ConstraintDef { name: r[0].clone().unwrap_or_default(), kind: r[1].clone().unwrap_or_default(), definition: r[2].clone() })
                .collect(),
            ddl,
            estimated_rows: meta.first().cloned().flatten().and_then(|x| x.parse().ok()),
            comment: meta.get(1).cloned().flatten().filter(|s| !s.is_empty()),
        })
    }

    async fn object_ddl(&self, o: &ObjectRef) -> DbResult<String> {
        let db = self.current_db(o.schema.as_deref()).await?;
        let name = Dialect::MySql.qualified(&TableTarget { schema: Some(db), table: o.name.clone() })?;
        let (kw, col) = match o.kind {
            ObjectKind::Table => ("TABLE", 1),
            ObjectKind::View => ("VIEW", 1),
            ObjectKind::Procedure => ("PROCEDURE", 2),
            ObjectKind::Function => ("FUNCTION", 2),
            ObjectKind::Trigger => ("TRIGGER", 2),
            ObjectKind::Event => ("EVENT", 3),
            _ => return Err(DbError::unsupported("DDL for this object type")),
        };
        let rows = self.text_rows(&format!("SHOW CREATE {kw} {name}"), vec![]).await?;
        rows.into_iter()
            .next()
            .and_then(|r| r.get(col).cloned().flatten())
            .map(|s| format!("{s};"))
            .ok_or_else(|| DbError::new(ErrorKind::NotFound, "object not found"))
    }

    async fn execute(&self, sql: &str, opts: &ExecOptions, cancel: CancellationToken) -> DbResult<Vec<StatementResult>> {
        guarded(self.run_script(sql, opts.max_rows), cancel, opts.timeout_ms, || self.kill_query()).await
    }

    async fn execute_params(&self, stmt: &GeneratedStatement) -> DbResult<u64> {
        let ps = stmt.params.iter().map(to_mysql).collect::<DbResult<Vec<_>>>()?;
        let mut c = self.conn.lock().await;
        c.exec_drop(stmt.sql.as_str(), mysql_async::Params::Positional(ps)).await.map_err(map_err)?;
        Ok(c.affected_rows())
    }

    async fn fetch_table(&self, target: &TableTarget, page: &PageRequest) -> DbResult<ResultSet> {
        let mut t = target.clone();
        t.schema = Some(self.current_db(t.schema.as_deref()).await?);
        let g = build_page_query(Dialect::MySql, &t, page)?;
        let ps = g.params.iter().map(to_mysql).collect::<DbResult<Vec<_>>>()?;
        let mut c = self.conn.lock().await;
        let mut res = c.exec_iter(g.sql.as_str(), mysql_async::Params::Positional(ps)).await.map_err(map_err)?;
        let cols: Vec<mysql_async::Column> = res.columns().as_deref().map(|c| c.to_vec()).unwrap_or_default();
        let mut rows = Vec::new();
        while let Some(mut row) = res.next().await.map_err(map_err)? {
            rows.push((0..cols.len()).map(|i| decode(row.take(i).unwrap_or(mysql_async::Value::NULL), &cols[i])).collect());
        }
        Ok(ResultSet {
            columns: cols
                .iter()
                .map(|c| ColumnMeta {
                    name: c.name_str().into_owned(),
                    type_name: type_name(c),
                    nullable: Some(!c.flags().contains(ColumnFlags::NOT_NULL_FLAG)),
                    table: Some(t.table.clone()),
                })
                .collect(),
            rows,
            truncated: false,
        })
    }

    async fn count_rows(&self, target: &TableTarget, filter: &[FilterCondition]) -> DbResult<u64> {
        let mut t = target.clone();
        t.schema = Some(self.current_db(t.schema.as_deref()).await?);
        let q = Dialect::MySql.qualified(&t)?;
        let (w, params) = build_filter(Dialect::MySql, filter, 0)?;
        let ps = params.iter().map(to_mysql).collect::<DbResult<Vec<_>>>()?;
        let r = self.text_rows(&format!("SELECT COUNT(*) FROM {q}{w}"), ps).await?;
        Ok(r.into_iter().next().and_then(|r| r[0].clone()).and_then(|s| s.parse().ok()).unwrap_or(0))
    }

    async fn begin(&self) -> DbResult<()> {
        self.conn.lock().await.query_drop("START TRANSACTION").await.map_err(map_err)
    }
    async fn commit(&self) -> DbResult<()> {
        self.conn.lock().await.query_drop("COMMIT").await.map_err(map_err)
    }
    async fn rollback(&self) -> DbResult<()> {
        self.conn.lock().await.query_drop("ROLLBACK").await.map_err(map_err)
    }

    async fn explain(&self, sql: &str, analyze: bool) -> DbResult<ResultSet> {
        let q = if analyze { format!("EXPLAIN ANALYZE {sql}") } else { format!("EXPLAIN FORMAT=JSON {sql}") };
        let mut r = self.run_script(&q, 10_000).await?;
        r.pop().and_then(|s| s.result).ok_or_else(|| DbError::internal("no plan returned"))
    }

    async fn use_schema(&self, schema: &str) -> DbResult<()> {
        let q = Dialect::MySql.quote_ident(schema)?;
        self.conn.lock().await.query_drop(format!("USE {q}")).await.map_err(map_err)
    }

    async fn set_read_only(&self, ro: bool) -> DbResult<()> {
        let s = if ro { "SET SESSION TRANSACTION READ ONLY" } else { "SET SESSION TRANSACTION READ WRITE" };
        self.conn.lock().await.query_drop(s).await.map_err(map_err)
    }

    async fn list_sessions(&self) -> DbResult<Vec<SessionInfo>> {
        let rows = self
            .text_rows(
                "SELECT ID, USER, DB, HOST, COMMAND, LEFT(INFO, 2000), TIME * 1000, STATE FROM information_schema.PROCESSLIST ORDER BY TIME DESC",
                vec![],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| SessionInfo {
                id: r[0].clone().unwrap_or_default(),
                user: r[1].clone(),
                database: r[2].clone(),
                client: r[3].clone(),
                state: r[4].clone().map(|c| match &r[7] {
                    Some(s) if !s.is_empty() => format!("{c} ({s})"),
                    _ => c,
                }),
                query: r[5].clone(),
                duration_ms: r[6].as_deref().and_then(|x| x.parse::<f64>().ok()).map(|x| x as i64),
                blocked_by: None,
            })
            .collect())
    }

    async fn kill_session(&self, id: &str) -> DbResult<()> {
        let n: u64 = id.parse().map_err(|_| DbError::invalid("invalid session id"))?;
        self.conn.lock().await.query_drop(format!("KILL {n}")).await.map_err(map_err)
    }

    async fn cancel_running(&self) -> DbResult<()> {
        self.kill_query().await;
        Ok(())
    }
}
