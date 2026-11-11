use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use dbs_core::*;
use futures_util::{pin_mut, StreamExt};
use native_tls::{Certificate, Identity, TlsConnector};
use postgres_native_tls::MakeTlsConnector;
use tokio_postgres::{AsyncMessage, CancelToken, Client, NoTls};
use tokio_util::sync::CancellationToken;

use crate::pg_types::{PgAny, PgParam};
use crate::util::{elapsed_ms, excerpt, guarded};

pub struct PgDriver;

#[derive(Clone)]
enum Tls {
    None,
    Native(MakeTlsConnector),
}

pub struct PgConnection {
    client: Client,
    engine: Engine,
    cancel: CancelToken,
    tls: Tls,
    notices: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}

/// Build a native-tls connector honouring the connection's SSL mode:
/// * `VerifyIdentity`: certificate chain + hostname verified.
/// * `VerifyCa`: chain verified, hostname not verified.
/// * `Required` / `Preferred`: encrypted, certificate NOT verified (the user's explicit choice;
///   `Preferred` additionally falls back to plaintext, see the `ssl_mode` call in `connect`).
pub fn build_tls(cfg: &TlsConfig) -> DbResult<Option<TlsConnector>> {
    if cfg.mode == TlsMode::Disabled {
        return Ok(None);
    }
    let mut b = TlsConnector::builder();
    b.min_protocol_version(Some(native_tls::Protocol::Tlsv12));
    if let Some(ca) = &cfg.ca_cert_path {
        let pem = std::fs::read(ca).map_err(|e| DbError::new(ErrorKind::Tls, format!("cannot read CA bundle: {e}")))?;
        let cert = Certificate::from_pem(&pem).map_err(|e| DbError::new(ErrorKind::Tls, format!("invalid CA certificate: {e}")))?;
        b.add_root_certificate(cert);
    }
    if let (Some(cp), Some(kp)) = (&cfg.client_cert_path, &cfg.client_key_path) {
        let cert = std::fs::read(cp).map_err(|e| DbError::new(ErrorKind::Tls, format!("cannot read client certificate: {e}")))?;
        let key = std::fs::read(kp).map_err(|e| DbError::new(ErrorKind::Tls, format!("cannot read client key: {e}")))?;
        let id = Identity::from_pkcs8(&cert, &key).map_err(|e| DbError::new(ErrorKind::Tls, format!("invalid client identity: {e}")))?;
        b.identity(id);
    }
    match cfg.mode {
        TlsMode::VerifyIdentity | TlsMode::Disabled => {}
        TlsMode::VerifyCa => {
            b.danger_accept_invalid_hostnames(true);
        }
        TlsMode::Required | TlsMode::Preferred => {
            b.danger_accept_invalid_certs(true);
            b.danger_accept_invalid_hostnames(true);
        }
    }
    b.build().map(Some).map_err(|e| DbError::new(ErrorKind::Tls, e.to_string()))
}

pub(crate) fn map_pg_err(e: tokio_postgres::Error) -> DbError {
    if let Some(db) = e.as_db_error() {
        let code = db.code().code().to_string();
        let kind = match &code[..2] {
            "23" => ErrorKind::Constraint,
            "42" if code == "42501" => ErrorKind::Permission,
            "42" => ErrorKind::Syntax,
            "28" => ErrorKind::Authentication,
            "40" => ErrorKind::TransactionConflict,
            "57" if code == "57014" => ErrorKind::Cancelled,
            "25" if code == "25006" => ErrorKind::Permission, // read-only transaction
            "08" => ErrorKind::Connection,
            "3D" | "3F" => ErrorKind::NotFound,
            _ => ErrorKind::Internal,
        };
        let mut msg = db.message().to_string();
        if let Some(d) = db.detail() {
            msg.push_str(&format!(" ({d})"));
        }
        if let Some(tokio_postgres::error::ErrorPosition::Original(n)) = db.position() {
            msg.push_str(&format!(" at character {n}"));
        }
        let mut err = DbError::new(kind, msg).with_code(code);
        if let Some(h) = db.hint() {
            err = err.with_hint(h);
        }
        return err;
    }
    let s = e.to_string();
    let kind = if s.contains("tls") || s.contains("certificate") || s.contains("ssl") {
        ErrorKind::Tls
    } else if s.contains("password") || s.contains("authentication") {
        ErrorKind::Authentication
    } else if s.contains("timed out") {
        ErrorKind::Timeout
    } else {
        ErrorKind::Connection
    };
    DbError::new(kind, s)
}

#[async_trait]
impl DatabaseDriver for PgDriver {
    fn engines(&self) -> &'static [Engine] {
        &[Engine::Postgres, Engine::CockroachDb, Engine::YugabyteDb, Engine::Redshift, Engine::Greenplum]
    }

    async fn connect(&self, cfg: &ConnectionConfig, secrets: ConnectSecrets) -> DbResult<Box<dyn DatabaseConnection>> {
        cfg.validate()?;
        let mut pc = tokio_postgres::Config::new();
        if let Some(sock) = &cfg.socket_path {
            pc.host_path(sock);
        } else if let Some(h) = &cfg.host {
            pc.host(h);
        }
        // Note: tokio-postgres `port()`/`hostaddr()` append to lists; set each exactly once.
        if let Some((addr, port)) = &cfg.tunnel {
            // Dial the SSH tunnel but keep `host` for TLS SNI + hostname verification.
            let ip: std::net::IpAddr = addr.parse().map_err(|_| DbError::internal("invalid tunnel address"))?;
            pc.hostaddr(ip);
            pc.port(*port);
        } else {
            pc.port(cfg.effective_port().unwrap_or(5432));
        }
        if let Some(u) = &cfg.username {
            pc.user(u);
        }
        if let Some(p) = &secrets.password {
            pc.password(p.as_bytes());
        }
        pc.dbname(cfg.database.as_deref().unwrap_or("postgres"));
        pc.application_name("Lord of the Rows");
        pc.connect_timeout(Duration::from_secs(cfg.connect_timeout_secs as u64));
        pc.keepalives(true);
        pc.keepalives_idle(Duration::from_secs(30));
        pc.ssl_mode(match cfg.tls.mode {
            TlsMode::Disabled => tokio_postgres::config::SslMode::Disable,
            // libpq `prefer`: TLS when the server offers it, plaintext otherwise.
            TlsMode::Preferred => tokio_postgres::config::SslMode::Prefer,
            TlsMode::Required | TlsMode::VerifyCa | TlsMode::VerifyIdentity => tokio_postgres::config::SslMode::Require,
        });
        drop(secrets);

        let notices: Arc<Mutex<Vec<String>>> = Arc::default();
        let tls = match build_tls(&cfg.tls)? {
            None => Tls::None,
            Some(c) => Tls::Native(MakeTlsConnector::new(c)),
        };
        let n2 = notices.clone();
        let (client, task) = match &tls {
            Tls::None => {
                let (client, mut conn) = pc.connect(NoTls).await.map_err(map_pg_err)?;
                let task = tokio::spawn(async move {
                    let stream = futures_util::stream::poll_fn(move |cx| conn.poll_message(cx));
                    pump(stream, n2).await
                });
                (client, task)
            }
            Tls::Native(m) => {
                let (client, mut conn) = pc.connect(m.clone()).await.map_err(map_pg_err)?;
                let task = tokio::spawn(async move {
                    let stream = futures_util::stream::poll_fn(move |cx| conn.poll_message(cx));
                    pump(stream, n2).await
                });
                (client, task)
            }
        };
        let cancel = client.cancel_token();
        let me = PgConnection { client, engine: cfg.engine, cancel, tls, notices, task };
        if cfg.read_only {
            me.set_read_only(true).await?;
        }
        if let Some(init) = &cfg.init_sql {
            me.client.batch_execute(init).await.map_err(map_pg_err)?;
        }
        Ok(Box::new(me))
    }
}

async fn pump<S>(stream: S, notices: Arc<Mutex<Vec<String>>>)
where
    S: futures_util::Stream<Item = Result<AsyncMessage, tokio_postgres::Error>>,
{
    pin_mut!(stream);
    while let Some(m) = stream.next().await {
        match m {
            Ok(AsyncMessage::Notice(n)) => {
                let mut g = notices.lock().unwrap();
                if g.len() < 1000 {
                    g.push(format!("{}: {}", n.severity(), n.message()));
                }
            }
            Ok(AsyncMessage::Notification(n)) => {
                let mut g = notices.lock().unwrap();
                if g.len() < 1000 {
                    g.push(format!("NOTIFY {}: {}", n.channel(), n.payload()));
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
}

impl Drop for PgConnection {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl PgConnection {
    fn take_notices(&self) -> Vec<String> {
        std::mem::take(&mut *self.notices.lock().unwrap())
    }

    async fn send_cancel(&self) {
        let r = match &self.tls {
            Tls::None => self.cancel.cancel_query(NoTls).await,
            Tls::Native(m) => self.cancel.cancel_query(m.clone()).await,
        };
        if let Err(e) = r {
            tracing::warn!("cancel request failed: {e}");
        }
    }

    async fn text_rows(&self, sql: &str, params: &[&(dyn tokio_postgres::types::ToSql + Sync)]) -> DbResult<Vec<Vec<Option<String>>>> {
        let rows = self.client.query(sql, params).await.map_err(map_pg_err)?;
        Ok(rows.iter().map(|r| (0..r.len()).map(|i| r.try_get::<_, Option<String>>(i).ok().flatten()).collect()).collect())
    }

    async fn run_one(&self, idx: usize, text: &str, max_rows: usize) -> DbResult<StatementResult> {
        let t = Instant::now();
        let stmt = match self.client.prepare(text).await {
            Ok(s) => s,
            Err(e) => {
                // Some utility statements can't go through the extended protocol
                // (e.g. those with multiple commands). Fall back to the simple protocol.
                // (SQLSTATE 0A000 = feature_not_supported.) Real errors such as
                // syntax errors are returned as-is.
                let code = e.as_db_error().map(|d| d.code().code().to_string());
                if code.as_deref() == Some("0A000") {
                    return self.run_simple(idx, text, max_rows, t).await;
                }
                return Err(map_pg_err(e));
            }
        };
        if stmt.columns().is_empty() {
            let n = self.client.execute(&stmt, &[]).await.map_err(map_pg_err)?;
            return Ok(StatementResult {
                statement_index: idx,
                sql_excerpt: excerpt(text),
                result: None,
                rows_affected: Some(n),
                duration_ms: elapsed_ms(t),
                notices: self.take_notices(),
            });
        }
        let columns: Vec<ColumnMeta> =
            stmt.columns().iter().map(|c| ColumnMeta { name: c.name().into(), type_name: c.type_().name().into(), nullable: None, table: None }).collect();
        let ncol = columns.len();
        let stream = self.client.query_raw(&stmt, std::iter::empty::<PgParam>()).await.map_err(map_pg_err)?;
        pin_mut!(stream);
        let mut rows = Vec::new();
        let mut truncated = false;
        while let Some(r) = stream.next().await {
            let r = r.map_err(map_pg_err)?;
            if rows.len() >= max_rows {
                truncated = true;
                // Drain remaining rows without storing (memory stays bounded).
                continue;
            }
            let mut row = Vec::with_capacity(ncol);
            for i in 0..ncol {
                row.push(r.try_get::<_, PgAny>(i).map(|v| v.0).unwrap_or_else(|e| Value::Other { type_name: "error".into(), text: e.to_string() }));
            }
            rows.push(row);
        }
        let affected = stream.rows_affected();
        let verb = text.split_whitespace().next().unwrap_or("").to_ascii_uppercase();
        Ok(StatementResult {
            statement_index: idx,
            sql_excerpt: excerpt(text),
            result: Some(ResultSet { columns, rows, truncated }),
            rows_affected: if matches!(verb.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "WITH") { affected } else { None },
            duration_ms: elapsed_ms(t),
            notices: self.take_notices(),
        })
    }

    async fn run_simple(&self, idx: usize, text: &str, max_rows: usize, t: Instant) -> DbResult<StatementResult> {
        use tokio_postgres::SimpleQueryMessage as M;
        let msgs = self.client.simple_query(text).await.map_err(map_pg_err)?;
        let mut columns = Vec::new();
        let mut rows = Vec::new();
        let mut affected = None;
        let mut truncated = false;
        for m in msgs {
            match m {
                M::RowDescription(cols) => {
                    columns = cols.iter().map(|c| ColumnMeta { name: c.name().into(), type_name: "text".into(), nullable: None, table: None }).collect();
                }
                M::Row(r) => {
                    if columns.is_empty() {
                        columns =
                            r.columns().iter().map(|c| ColumnMeta { name: c.name().into(), type_name: "text".into(), nullable: None, table: None }).collect();
                    }
                    if rows.len() >= max_rows {
                        truncated = true;
                        continue;
                    }
                    rows.push((0..r.len()).map(|i| r.get(i).map(|s| Value::Text(s.into())).unwrap_or(Value::Null)).collect());
                }
                M::CommandComplete(n) => affected = Some(n),
                _ => {}
            }
        }
        Ok(StatementResult {
            statement_index: idx,
            sql_excerpt: excerpt(text),
            result: (!columns.is_empty()).then_some(ResultSet { columns, rows, truncated }),
            rows_affected: affected,
            duration_ms: elapsed_ms(t),
            notices: self.take_notices(),
        })
    }

    /// Streaming counterpart of [`Self::run_one`]: rows go to `sink` as they arrive
    /// from the `RowStream` (bounded by the sink's backpressure).
    async fn stream_one(&self, idx: usize, text: &str, sink: &mut RowSink) -> DbResult<()> {
        let t = Instant::now();
        let stmt = match self.client.prepare(text).await {
            Ok(s) => s,
            Err(e) => {
                let code = e.as_db_error().map(|d| d.code().code().to_string());
                if code.as_deref() == Some("0A000") {
                    // Simple protocol has no row stream; materialise (capped) and replay.
                    let r = self.run_simple(idx, text, sink.max_rows(), t).await?;
                    return sink.replay(vec![r]).await;
                }
                return Err(map_pg_err(e));
            }
        };
        if stmt.columns().is_empty() {
            let n = self.client.execute(&stmt, &[]).await.map_err(map_pg_err)?;
            return sink
                .end_statement(StatementSummary {
                    statement_index: idx,
                    sql_excerpt: excerpt(text),
                    rows_affected: Some(n),
                    duration_ms: elapsed_ms(t),
                    notices: self.take_notices(),
                })
                .await;
        }
        let columns: Vec<ColumnMeta> =
            stmt.columns().iter().map(|c| ColumnMeta { name: c.name().into(), type_name: c.type_().name().into(), nullable: None, table: None }).collect();
        let ncol = columns.len();
        let stream = self.client.query_raw(&stmt, std::iter::empty::<PgParam>()).await.map_err(map_pg_err)?;
        pin_mut!(stream);
        sink.begin_result(idx, excerpt(text), columns).await?;
        while let Some(r) = stream.next().await {
            let r = r.map_err(map_pg_err)?;
            if sink.is_full() {
                // Past the cap: drain without decoding so the connection stays in sync.
                sink.mark_truncated();
                continue;
            }
            let mut row = Vec::with_capacity(ncol);
            for i in 0..ncol {
                row.push(r.try_get::<_, PgAny>(i).map(|v| v.0).unwrap_or_else(|e| Value::Other { type_name: "error".into(), text: e.to_string() }));
            }
            sink.push_row(row).await?;
        }
        let affected = stream.rows_affected();
        let verb = text.split_whitespace().next().unwrap_or("").to_ascii_uppercase();
        sink.end_statement(StatementSummary {
            statement_index: idx,
            sql_excerpt: excerpt(text),
            rows_affected: if matches!(verb.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "WITH") { affected } else { None },
            duration_ms: elapsed_ms(t),
            notices: self.take_notices(),
        })
        .await
    }

    fn default_schema(s: Option<&str>) -> String {
        s.filter(|s| !s.is_empty()).unwrap_or("public").to_string()
    }
}

#[async_trait]
impl DatabaseConnection for PgConnection {
    fn engine(&self) -> Engine {
        self.engine
    }

    fn capabilities(&self) -> Capabilities {
        let full_pg = self.engine == Engine::Postgres;
        Capabilities {
            sql: true,
            transactions: true,
            schemas: true,
            multiple_databases: true,
            explain: true,
            explain_analyze: self.engine != Engine::Redshift,
            cancel: true,
            inline_edit: true,
            ddl_editing: true,
            read_only_session: true,
            sessions_monitor: self.engine != Engine::Redshift,
            kill_session: full_pg || self.engine == Engine::YugabyteDb || self.engine == Engine::Greenplum,
            native_backup: full_pg,
            object_kinds: vec![
                ObjectKind::Table,
                ObjectKind::View,
                ObjectKind::MaterializedView,
                ObjectKind::Function,
                ObjectKind::Procedure,
                ObjectKind::Sequence,
                ObjectKind::Enum,
                ObjectKind::Trigger,
                ObjectKind::Index,
                ObjectKind::Extension,
            ],
        }
    }

    async fn server_info(&self) -> DbResult<ServerInfo> {
        let r = self.text_rows("SELECT version(), current_database()::text, current_user::text", &[]).await?;
        let r = r.into_iter().next().unwrap_or_default();
        // Best effort (pg_stat_ssl exists since 9.5; forks may lack it): "" when plaintext.
        let tls_version = self
            .text_rows("SELECT CASE WHEN ssl THEN version::text ELSE '' END FROM pg_stat_ssl WHERE pid = pg_backend_pid()", &[])
            .await
            .ok()
            .and_then(|rows| rows.into_iter().next())
            .and_then(|row| row.first().cloned().flatten());
        Ok(ServerInfo {
            engine: self.engine,
            version: r.first().cloned().flatten().unwrap_or_default(),
            current_database: r.get(1).cloned().flatten(),
            current_user: r.get(2).cloned().flatten(),
            tls_version,
        })
    }

    async fn ping(&self) -> DbResult<()> {
        self.client.simple_query("SELECT 1").await.map(|_| ()).map_err(map_pg_err)
    }

    async fn close(&self) -> DbResult<()> {
        self.task.abort();
        Ok(())
    }

    async fn list_databases(&self) -> DbResult<Vec<String>> {
        Ok(self
            .text_rows("SELECT datname::text FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY 1", &[])
            .await?
            .into_iter()
            .filter_map(|r| r.into_iter().next().flatten())
            .collect())
    }

    async fn list_schemas(&self, _db: Option<&str>) -> DbResult<Vec<String>> {
        Ok(self
            .text_rows(
                "SELECT nspname::text FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp\\_%' ORDER BY nspname = 'public' DESC, nspname",
                &[],
            )
            .await?
            .into_iter()
            .filter_map(|r| r.into_iter().next().flatten())
            .collect())
    }

    async fn list_objects(&self, schema: Option<&str>) -> DbResult<Vec<ObjectRef>> {
        let s = Self::default_schema(schema);
        let rows = self
            .text_rows(
                "SELECT k, name FROM (
                   SELECT CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'f' THEN 'table'
                          WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view' WHEN 'S' THEN 'sequence' END AS k,
                          c.relname::text AS name
                   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = $1 AND c.relkind IN ('r','p','f','v','m','S') AND NOT c.relispartition
                   UNION ALL
                   SELECT CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END,
                          p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')'
                   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = $1 AND p.prokind IN ('f','p')
                   UNION ALL
                   SELECT 'enum', t.typname::text FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                   WHERE n.nspname = $1 AND t.typtype = 'e'
                   UNION ALL
                   SELECT 'trigger', tg.tgname::text || ' ON ' || c.relname::text FROM pg_trigger tg
                   JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = $1 AND NOT tg.tgisinternal
                 ) x ORDER BY k, name",
                &[&s],
            )
            .await?;
        let mut out: Vec<ObjectRef> = rows
            .into_iter()
            .filter_map(|r| {
                let kind = match r[0].as_deref()? {
                    "table" => ObjectKind::Table,
                    "view" => ObjectKind::View,
                    "materialized_view" => ObjectKind::MaterializedView,
                    "sequence" => ObjectKind::Sequence,
                    "function" => ObjectKind::Function,
                    "procedure" => ObjectKind::Procedure,
                    "enum" => ObjectKind::Enum,
                    "trigger" => ObjectKind::Trigger,
                    _ => return None,
                };
                Some(ObjectRef { kind, database: None, schema: Some(s.clone()), name: r[1].clone()? })
            })
            .collect();
        if s == "public" {
            if let Ok(ext) = self.text_rows("SELECT extname::text FROM pg_extension ORDER BY 1", &[]).await {
                out.extend(ext.into_iter().filter_map(|r| Some(ObjectRef { kind: ObjectKind::Extension, database: None, schema: None, name: r[0].clone()? })));
            }
        }
        Ok(out)
    }

    async fn describe_table(&self, target: &TableTarget) -> DbResult<TableDescription> {
        let s = Self::default_schema(target.schema.as_deref());
        let t = target.table.clone();
        let rel = self
            .text_rows(
                "SELECT c.oid::text, c.reltuples::bigint::text, obj_description(c.oid, 'pg_class'), c.relkind::text
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2",
                &[&s, &t],
            )
            .await?;
        let rel = rel.into_iter().next().ok_or_else(|| DbError::new(ErrorKind::NotFound, "table not found"))?;
        let oid: u32 = rel[0].as_deref().unwrap_or("0").parse().unwrap_or(0);
        let oid_s = oid.to_string();
        let cols = self
            .text_rows(
                "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), (NOT a.attnotnull)::text,
                        pg_get_expr(d.adbin, d.adrelid), (a.attidentity <> '' OR coalesce(pg_get_expr(d.adbin, d.adrelid),'') LIKE 'nextval(%')::text,
                        col_description(a.attrelid, a.attnum), a.attnum::text,
                        (EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)))::text
                 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                 WHERE a.attrelid = $1::text::oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
                &[&oid_s],
            )
            .await?;
        let columns: Vec<ColumnDef> = cols
            .iter()
            .map(|r| ColumnDef {
                name: r[0].clone().unwrap_or_default(),
                data_type: r[1].clone().unwrap_or_default(),
                nullable: r[2].as_deref() == Some("true"),
                default: r[3].clone(),
                is_identity: r[4].as_deref() == Some("true"),
                comment: r[5].clone(),
                ordinal: r[6].as_deref().and_then(|x| x.parse().ok()).unwrap_or(0),
                is_primary_key: r[7].as_deref() == Some("true"),
            })
            .collect();
        let pk_rows = self
            .text_rows(
                "SELECT a.attname::text FROM pg_index i
                 JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                 WHERE i.indrelid = $1::text::oid AND i.indisprimary ORDER BY k.ord",
                &[&oid_s],
            )
            .await?;
        let idx_rows = self
            .text_rows(
                "SELECT ic.relname::text, i.indisunique::text, i.indisprimary::text, pg_get_indexdef(i.indexrelid),
                        (SELECT string_agg(coalesce(a.attname::text, '<expr>'), ',' ORDER BY k.ord)
                         FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                         LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
                 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid WHERE i.indrelid = $1::text::oid ORDER BY 1",
                &[&oid_s],
            )
            .await?;
        let fk_rows = self
            .text_rows(
                "SELECT con.conname::text, rn.nspname::text, rc.relname::text,
                   (SELECT string_agg(a.attname::text, ',' ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(n, ord)
                      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n),
                   (SELECT string_agg(a.attname::text, ',' ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(n, ord)
                      JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n),
                   con.confupdtype::text, con.confdeltype::text
                 FROM pg_constraint con JOIN pg_class rc ON rc.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
                 WHERE con.conrelid = $1::text::oid AND con.contype = 'f' ORDER BY 1",
                &[&oid_s],
            )
            .await?;
        let action = |c: Option<&str>| {
            c.map(|c| {
                match c {
                    "a" => "NO ACTION",
                    "r" => "RESTRICT",
                    "c" => "CASCADE",
                    "n" => "SET NULL",
                    "d" => "SET DEFAULT",
                    _ => "NO ACTION",
                }
                .to_string()
            })
        };
        let split = |s: &Option<String>| s.clone().unwrap_or_default().split(',').filter(|x| !x.is_empty()).map(String::from).collect::<Vec<_>>();
        let con_rows = self
            .text_rows(
                "SELECT conname::text, CASE contype WHEN 'c' THEN 'CHECK' WHEN 'u' THEN 'UNIQUE' WHEN 'x' THEN 'EXCLUDE' WHEN 'p' THEN 'PRIMARY KEY' END,
                        pg_get_constraintdef(oid)
                 FROM pg_constraint WHERE conrelid = $1::text::oid AND contype IN ('c','u','x','p') ORDER BY 1",
                &[&oid_s],
            )
            .await?;
        let mut desc = TableDescription {
            object: ObjectRef {
                kind: if rel[3].as_deref() == Some("v") { ObjectKind::View } else { ObjectKind::Table },
                database: None,
                schema: Some(s.clone()),
                name: t.clone(),
            },
            columns,
            primary_key: pk_rows.into_iter().filter_map(|r| r[0].clone()).collect(),
            indexes: idx_rows
                .iter()
                .map(|r| IndexDef {
                    name: r[0].clone().unwrap_or_default(),
                    unique: r[1].as_deref() == Some("true"),
                    primary: r[2].as_deref() == Some("true"),
                    definition: r[3].clone(),
                    columns: split(&r[4]),
                })
                .collect(),
            foreign_keys: fk_rows
                .iter()
                .map(|r| ForeignKeyDef {
                    name: r[0].clone().unwrap_or_default(),
                    ref_schema: r[1].clone(),
                    ref_table: r[2].clone().unwrap_or_default(),
                    columns: split(&r[3]),
                    ref_columns: split(&r[4]),
                    on_update: action(r[5].as_deref()),
                    on_delete: action(r[6].as_deref()),
                })
                .collect(),
            constraints: con_rows
                .iter()
                .map(|r| ConstraintDef { name: r[0].clone().unwrap_or_default(), kind: r[1].clone().unwrap_or_default(), definition: r[2].clone() })
                .collect(),
            ddl: None,
            estimated_rows: rel[1].as_deref().and_then(|x| x.parse().ok()).filter(|n: &i64| *n >= 0),
            comment: rel[2].clone(),
        };
        desc.ddl = Some(if rel[3].as_deref() == Some("v") || rel[3].as_deref() == Some("m") {
            self.object_ddl(&desc.object).await?
        } else {
            generate_pg_table_ddl(&desc)?
        });
        Ok(desc)
    }

    async fn object_ddl(&self, o: &ObjectRef) -> DbResult<String> {
        let s = Self::default_schema(o.schema.as_deref());
        let q = |sql: &'static str| sql;
        let single = |rows: Vec<Vec<Option<String>>>| {
            rows.into_iter().next().and_then(|r| r.into_iter().next().flatten()).ok_or_else(|| DbError::new(ErrorKind::NotFound, "object not found"))
        };
        match o.kind {
            ObjectKind::Table => self.describe_table(&TableTarget { schema: Some(s), table: o.name.clone() }).await.map(|d| d.ddl.unwrap_or_default()),
            ObjectKind::View | ObjectKind::MaterializedView => {
                let kw = if o.kind == ObjectKind::View { "VIEW" } else { "MATERIALIZED VIEW" };
                let body = single(
                    self.text_rows(
                        q("SELECT pg_get_viewdef(c.oid, true) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2"),
                        &[&s, &o.name],
                    )
                    .await?,
                )?;
                let name = Dialect::Postgres.qualified(&TableTarget { schema: Some(s), table: o.name.clone() })?;
                Ok(format!("CREATE {kw} {name} AS\n{body}"))
            }
            ObjectKind::Function | ObjectKind::Procedure => single(
                self.text_rows(
                    q("SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                       WHERE n.nspname=$1 AND p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')' = $2"),
                    &[&s, &o.name],
                )
                .await?,
            ),
            ObjectKind::Trigger => {
                let (tg, _) = o.name.split_once(" ON ").unwrap_or((&o.name, ""));
                single(
                    self.text_rows(
                        q("SELECT pg_get_triggerdef(t.oid, true) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND t.tgname=$2"),
                        &[&s, &tg.to_string()],
                    )
                    .await?,
                )
                .map(|d| format!("{d};"))
            }
            ObjectKind::Enum => {
                let labels = self
                    .text_rows(
                        q("SELECT e.enumlabel::text FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1 AND t.typname=$2 ORDER BY e.enumsortorder"),
                        &[&s, &o.name],
                    )
                    .await?;
                let name = Dialect::Postgres.qualified(&TableTarget { schema: Some(s), table: o.name.clone() })?;
                let vals: Vec<String> = labels.into_iter().filter_map(|r| r[0].clone()).map(|l| Dialect::Postgres.literal(&Value::Text(l))).collect();
                Ok(format!("CREATE TYPE {name} AS ENUM ({});", vals.join(", ")))
            }
            ObjectKind::Sequence => {
                let r = self
                    .text_rows(
                        q("SELECT data_type::text, start_value::text, increment_by::text, min_value::text, max_value::text, cycle::text FROM pg_sequences WHERE schemaname=$1 AND sequencename=$2"),
                        &[&s, &o.name],
                    )
                    .await?;
                let r = r.into_iter().next().ok_or_else(|| DbError::new(ErrorKind::NotFound, "sequence not found"))?;
                let name = Dialect::Postgres.qualified(&TableTarget { schema: Some(s), table: o.name.clone() })?;
                Ok(format!(
                    "CREATE SEQUENCE {name} AS {} START {} INCREMENT {} MINVALUE {} MAXVALUE {}{};",
                    r[0].clone().unwrap_or_default(),
                    r[1].clone().unwrap_or_default(),
                    r[2].clone().unwrap_or_default(),
                    r[3].clone().unwrap_or_default(),
                    r[4].clone().unwrap_or_default(),
                    if r[5].as_deref() == Some("true") { " CYCLE" } else { "" }
                ))
            }
            ObjectKind::Extension => Ok(format!("CREATE EXTENSION IF NOT EXISTS {};", Dialect::Postgres.quote_ident(&o.name)?)),
            _ => Err(DbError::unsupported("DDL for this object type")),
        }
    }

    async fn execute(&self, sql: &str, opts: &ExecOptions, cancel: CancellationToken) -> DbResult<Vec<StatementResult>> {
        let stmts = dbs_safety::split_statements(sql, Dialect::Postgres);
        let fut = async {
            let mut out = Vec::new();
            for (i, s) in stmts.iter().enumerate() {
                match self.run_one(i, &s.text, opts.max_rows).await {
                    Ok(r) => out.push(r),
                    Err(mut e) => {
                        if stmts.len() > 1 {
                            e.message = format!("statement {} failed: {}", i + 1, e.message);
                        }
                        return Err(e);
                    }
                }
            }
            Ok(out)
        };
        guarded(fut, cancel, opts.timeout_ms, || self.send_cancel()).await
    }

    async fn execute_stream(&self, sql: &str, opts: &ExecOptions, cancel: CancellationToken, mut sink: RowSink) -> DbResult<()> {
        let stmts = dbs_safety::split_statements(sql, Dialect::Postgres);
        let n = stmts.len();
        let fut = async {
            for (i, s) in stmts.iter().enumerate() {
                if let Err(mut e) = self.stream_one(i, &s.text, &mut sink).await {
                    if n > 1 && e.kind != ErrorKind::Cancelled {
                        e.message = format!("statement {} failed: {}", i + 1, e.message);
                    }
                    return Err(e);
                }
            }
            Ok(())
        };
        guarded(fut, cancel, opts.timeout_ms, || self.send_cancel()).await
    }

    async fn execute_params(&self, stmt: &GeneratedStatement) -> DbResult<u64> {
        let params: Vec<PgParam> = stmt.params.iter().cloned().map(PgParam).collect();
        let refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params.iter().map(|p| p as _).collect();
        self.client.execute(stmt.sql.as_str(), &refs).await.map_err(map_pg_err)
    }

    async fn fetch_table(&self, target: &TableTarget, page: &PageRequest) -> DbResult<ResultSet> {
        let mut t = target.clone();
        t.schema = Some(Self::default_schema(t.schema.as_deref()));
        let g = build_page_query(Dialect::Postgres, &t, page)?;
        let params: Vec<PgParam> = g.params.into_iter().map(PgParam).collect();
        let refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params.iter().map(|p| p as _).collect();
        let stmt = self.client.prepare(&g.sql).await.map_err(map_pg_err)?;
        let rows = self.client.query(&stmt, &refs).await.map_err(map_pg_err)?;
        let columns = stmt
            .columns()
            .iter()
            .map(|c| ColumnMeta { name: c.name().into(), type_name: c.type_().name().into(), nullable: None, table: Some(t.table.clone()) })
            .collect::<Vec<_>>();
        let n = columns.len();
        let data = rows.iter().map(|r| (0..n).map(|i| r.try_get::<_, PgAny>(i).map(|v| v.0).unwrap_or(Value::Null)).collect()).collect();
        Ok(ResultSet { columns, rows: data, truncated: false })
    }

    async fn count_rows(&self, target: &TableTarget, filter: &[FilterCondition]) -> DbResult<u64> {
        let mut t = target.clone();
        t.schema = Some(Self::default_schema(t.schema.as_deref()));
        let q = Dialect::Postgres.qualified(&t)?;
        let (w, params) = build_filter(Dialect::Postgres, filter, 0)?;
        let params: Vec<PgParam> = params.into_iter().map(PgParam).collect();
        let refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params.iter().map(|p| p as _).collect();
        let row = self.client.query_one(format!("SELECT count(*) FROM {q}{w}").as_str(), &refs).await.map_err(map_pg_err)?;
        Ok(row.get::<_, i64>(0) as u64)
    }

    async fn begin(&self) -> DbResult<()> {
        self.client.batch_execute("BEGIN").await.map_err(map_pg_err)
    }
    async fn commit(&self) -> DbResult<()> {
        self.client.batch_execute("COMMIT").await.map_err(map_pg_err)
    }
    async fn rollback(&self) -> DbResult<()> {
        self.client.batch_execute("ROLLBACK").await.map_err(map_pg_err)
    }

    async fn explain(&self, sql: &str, analyze: bool) -> DbResult<ResultSet> {
        let prefix = if analyze { "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " } else { "EXPLAIN (FORMAT JSON) " };
        let r = self.run_one(0, &format!("{prefix}{sql}"), 10_000).await?;
        r.result.ok_or_else(|| DbError::internal("no plan returned"))
    }

    async fn use_schema(&self, schema: &str) -> DbResult<()> {
        // Keep `public` as a fallback so extensions installed there still resolve.
        let q = Dialect::Postgres.quote_ident(schema)?;
        let sql = if schema == "public" { format!("SET search_path TO {q}") } else { format!("SET search_path TO {q}, public") };
        self.client.batch_execute(&sql).await.map_err(map_pg_err)
    }

    async fn set_read_only(&self, ro: bool) -> DbResult<()> {
        let s = if ro {
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY; SET default_transaction_read_only = on"
        } else {
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE; SET default_transaction_read_only = off"
        };
        self.client.batch_execute(s).await.map_err(map_pg_err)
    }

    async fn list_sessions(&self) -> DbResult<Vec<SessionInfo>> {
        let rows = self
            .text_rows(
                "SELECT pid::text, usename::text, datname::text, coalesce(application_name,'') || ' ' || coalesce(client_addr::text,''),
                        state, left(query, 2000), (extract(epoch from (now() - query_start)) * 1000)::bigint::text,
                        nullif(array_to_string(pg_blocking_pids(pid), ','), '')
                 FROM pg_stat_activity WHERE backend_type = 'client backend' ORDER BY query_start NULLS LAST",
                &[],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| SessionInfo {
                id: r[0].clone().unwrap_or_default(),
                user: r[1].clone(),
                database: r[2].clone(),
                client: r[3].clone(),
                state: r[4].clone(),
                query: r[5].clone(),
                duration_ms: r[6].as_deref().and_then(|x| x.parse().ok()),
                blocked_by: r[7].clone(),
            })
            .collect())
    }

    async fn kill_session(&self, id: &str) -> DbResult<()> {
        let pid: i32 = id.parse().map_err(|_| DbError::invalid("invalid session id"))?;
        let r = self.client.query_one("SELECT pg_terminate_backend($1)", &[&pid]).await.map_err(map_pg_err)?;
        if r.get::<_, bool>(0) {
            Ok(())
        } else {
            Err(DbError::new(ErrorKind::NotFound, "session not found or not terminated"))
        }
    }

    async fn cancel_running(&self) -> DbResult<()> {
        self.send_cancel().await;
        Ok(())
    }
}

/// CREATE TABLE statement reconstructed from catalog metadata.
pub fn generate_pg_table_ddl(d: &TableDescription) -> DbResult<String> {
    let dl = Dialect::Postgres;
    let name = dl.qualified(&TableTarget { schema: d.object.schema.clone(), table: d.object.name.clone() })?;
    let mut lines = Vec::new();
    for c in &d.columns {
        let mut l = format!("  {} {}", dl.quote_ident(&c.name)?, c.data_type);
        if let Some(def) = &c.default {
            l.push_str(&format!(" DEFAULT {def}"));
        }
        if !c.nullable {
            l.push_str(" NOT NULL");
        }
        lines.push(l);
    }
    for con in &d.constraints {
        if let Some(def) = &con.definition {
            lines.push(format!("  CONSTRAINT {} {}", dl.quote_ident(&con.name)?, def));
        }
    }
    for fk in &d.foreign_keys {
        let cols = fk.columns.iter().map(|c| dl.quote_ident(c)).collect::<DbResult<Vec<_>>>()?.join(", ");
        let rcols = fk.ref_columns.iter().map(|c| dl.quote_ident(c)).collect::<DbResult<Vec<_>>>()?.join(", ");
        let rt = dl.qualified(&TableTarget { schema: fk.ref_schema.clone(), table: fk.ref_table.clone() })?;
        lines.push(format!(
            "  CONSTRAINT {} FOREIGN KEY ({cols}) REFERENCES {rt} ({rcols}) ON UPDATE {} ON DELETE {}",
            dl.quote_ident(&fk.name)?,
            fk.on_update.as_deref().unwrap_or("NO ACTION"),
            fk.on_delete.as_deref().unwrap_or("NO ACTION")
        ));
    }
    let mut out = format!("CREATE TABLE {name} (\n{}\n);", lines.join(",\n"));
    for i in &d.indexes {
        if i.primary || d.constraints.iter().any(|c| c.name == i.name) {
            continue;
        }
        if let Some(def) = &i.definition {
            out.push_str(&format!("\n{def};"));
        }
    }
    if let Some(c) = &d.comment {
        out.push_str(&format!("\nCOMMENT ON TABLE {name} IS {};", dl.literal(&Value::Text(c.clone()))));
    }
    for c in &d.columns {
        if let Some(cm) = &c.comment {
            out.push_str(&format!("\nCOMMENT ON COLUMN {name}.{} IS {};", dl.quote_ident(&c.name)?, dl.literal(&Value::Text(cm.clone()))));
        }
    }
    Ok(out)
}
