use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use dbs_core::*;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, InterruptHandle, OpenFlags};
use tokio_util::sync::CancellationToken;

use crate::util::{elapsed_ms, excerpt, guarded};

pub struct SqliteDriver;

#[async_trait]
impl DatabaseDriver for SqliteDriver {
    fn engines(&self) -> &'static [Engine] {
        &[Engine::Sqlite]
    }

    async fn connect(&self, cfg: &ConnectionConfig, _secrets: ConnectSecrets) -> DbResult<Box<dyn DatabaseConnection>> {
        cfg.validate()?;
        let path = cfg.database.clone().ok_or_else(|| DbError::invalid("database path required"))?;
        let read_only = cfg.read_only;
        let conn = tokio::task::spawn_blocking(move || SqliteConnection::open(&path, read_only)).await.map_err(|e| DbError::internal(e.to_string()))??;
        Ok(Box::new(conn))
    }
}

pub struct SqliteConnection {
    conn: Arc<Mutex<Connection>>,
    interrupt: Arc<InterruptHandle>,
}

fn map_err(e: rusqlite::Error) -> DbError {
    let msg = e.to_string();
    let kind = match &e {
        rusqlite::Error::SqliteFailure(f, _) => match f.code {
            rusqlite::ErrorCode::ConstraintViolation => ErrorKind::Constraint,
            rusqlite::ErrorCode::OperationInterrupted => ErrorKind::Cancelled,
            rusqlite::ErrorCode::PermissionDenied | rusqlite::ErrorCode::ReadOnly => ErrorKind::Permission,
            rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked => ErrorKind::TransactionConflict,
            rusqlite::ErrorCode::CannotOpen | rusqlite::ErrorCode::NotADatabase => ErrorKind::Connection,
            _ if msg.contains("syntax error") => ErrorKind::Syntax,
            _ if msg.contains("no such") => ErrorKind::NotFound,
            _ => ErrorKind::Internal,
        },
        rusqlite::Error::InvalidParameterCount(..) | rusqlite::Error::InvalidParameterName(_) => ErrorKind::InvalidInput,
        _ => ErrorKind::Internal,
    };
    let code = match &e {
        rusqlite::Error::SqliteFailure(f, _) => Some(f.extended_code.to_string()),
        _ => None,
    };
    let mut err = DbError::new(kind, msg);
    err.code = code;
    err
}

impl SqliteConnection {
    pub fn open(path: &str, read_only: bool) -> DbResult<Self> {
        let flags = if path == ":memory:" {
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_MEMORY
        } else if read_only {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        } else {
            // No CREATE: a typo in the path must not silently create an empty database.
            OpenFlags::SQLITE_OPEN_READ_WRITE
        } | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI;
        if path != ":memory:" && !Path::new(path).exists() {
            return Err(DbError::new(ErrorKind::NotFound, "database file does not exist"));
        }
        let c = Connection::open_with_flags(path, flags).map_err(map_err)?;
        c.busy_timeout(std::time::Duration::from_secs(5)).map_err(map_err)?;
        c.execute_batch("PRAGMA foreign_keys = ON;").map_err(map_err)?;
        if read_only {
            c.execute_batch("PRAGMA query_only = ON;").map_err(map_err)?;
        }
        // Validate it is actually a database.
        c.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(())).map_err(map_err)?;
        let interrupt = Arc::new(c.get_interrupt_handle());
        Ok(Self { conn: Arc::new(Mutex::new(c)), interrupt })
    }

    async fn with<T: Send + 'static>(&self, f: impl FnOnce(&Connection) -> DbResult<T> + Send + 'static) -> DbResult<T> {
        let c = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let g = c.lock().map_err(|_| DbError::internal("connection poisoned"))?;
            f(&g)
        })
        .await
        .map_err(|e| DbError::internal(e.to_string()))?
    }
}

pub(crate) fn sqlite_value(v: ValueRef<'_>, decl: Option<&str>) -> Value {
    let decl = decl.map(|d| d.to_ascii_uppercase()).unwrap_or_default();
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) if decl.contains("BOOL") => Value::Bool(i != 0),
        ValueRef::Integer(i) => Value::from_i64(i),
        ValueRef::Real(f) => Value::Float(f),
        ValueRef::Text(t) => {
            let s = String::from_utf8_lossy(t).into_owned();
            if decl.contains("JSON") {
                match serde_json::from_str(&s) {
                    Ok(j) => Value::Json(j),
                    Err(_) => Value::Text(s),
                }
            } else if decl == "DATE" {
                Value::Date(s)
            } else if decl.contains("TIMESTAMP") || decl == "DATETIME" {
                Value::Timestamp { iso: s, tz: false }
            } else if decl.contains("DECIMAL") || decl.contains("NUMERIC") {
                Value::Decimal(s)
            } else {
                Value::Text(s)
            }
        }
        ValueRef::Blob(b) => Value::from_bytes(b),
    }
}

pub(crate) fn to_sqlite(v: &Value) -> DbResult<rusqlite::types::Value> {
    use rusqlite::types::Value as S;
    Ok(match v {
        Value::Null => S::Null,
        Value::Bool(b) => S::Integer(*b as i64),
        Value::Int(i) => S::Integer(*i),
        Value::BigInt(s) => s.parse::<i64>().map(S::Integer).unwrap_or_else(|_| S::Text(s.clone())),
        Value::Float(f) => S::Real(*f),
        Value::Bytes { hex, truncated, .. } => {
            if *truncated {
                return Err(DbError::invalid("cannot write a truncated binary value"));
            }
            S::Blob(hex_decode(hex).ok_or_else(|| DbError::invalid("invalid hex"))?)
        }
        Value::Json(j) => S::Text(j.to_string()),
        other => S::Text(other.to_plain().unwrap_or_default()),
    })
}

fn run_script(c: &Connection, sql: &str, opts: &ExecOptions) -> DbResult<Vec<StatementResult>> {
    let mut out = Vec::new();
    for (idx, st) in dbs_safety::split_statements(sql, Dialect::Sqlite).iter().enumerate() {
        let t = Instant::now();
        let mut stmt = c.prepare(&st.text).map_err(map_err)?;
        let ncols = stmt.column_count();
        if ncols == 0 {
            let n = stmt.execute([]).map_err(map_err)?;
            out.push(StatementResult {
                statement_index: idx,
                sql_excerpt: excerpt(&st.text),
                result: None,
                rows_affected: Some(n as u64),
                duration_ms: elapsed_ms(t),
                notices: vec![],
            });
            continue;
        }
        let cols: Vec<ColumnMeta> = stmt
            .columns()
            .map(|col| ColumnMeta { name: col.name().to_string(), type_name: col.decl_type().unwrap_or("").to_string(), nullable: None, table: None })
            .collect();
        let decls: Vec<Option<String>> = stmt.columns().map(|c| c.decl_type().map(String::from)).collect();
        let mut rows = stmt.query([]).map_err(map_err)?;
        let mut data = Vec::new();
        let mut truncated = false;
        while let Some(r) = rows.next().map_err(map_err)? {
            if data.len() >= opts.max_rows {
                truncated = true;
                break;
            }
            let row = (0..ncols).map(|i| r.get_ref(i).map(|v| sqlite_value(v, decls[i].as_deref())).unwrap_or(Value::Null)).collect();
            data.push(row);
        }
        let changes = c.changes();
        out.push(StatementResult {
            statement_index: idx,
            sql_excerpt: excerpt(&st.text),
            result: Some(ResultSet { columns: cols, rows: data, truncated }),
            rows_affected: (changes > 0 && !st.text.trim_start().to_ascii_uppercase().starts_with("SELECT")).then_some(changes),
            duration_ms: elapsed_ms(t),
            notices: vec![],
        });
    }
    Ok(out)
}

fn query_rows(c: &Connection, sql: &str, params: &[Value], max: usize) -> DbResult<ResultSet> {
    let mut stmt = c.prepare(sql).map_err(map_err)?;
    let ps = params.iter().map(to_sqlite).collect::<DbResult<Vec<_>>>()?;
    let ncols = stmt.column_count();
    let cols: Vec<ColumnMeta> = stmt
        .columns()
        .map(|col| ColumnMeta { name: col.name().into(), type_name: col.decl_type().unwrap_or("").into(), nullable: None, table: None })
        .collect();
    let decls: Vec<Option<String>> = stmt.columns().map(|c| c.decl_type().map(String::from)).collect();
    let mut rows = stmt.query(rusqlite::params_from_iter(ps.iter())).map_err(map_err)?;
    let mut data = Vec::new();
    let mut truncated = false;
    while let Some(r) = rows.next().map_err(map_err)? {
        if data.len() >= max {
            truncated = true;
            break;
        }
        data.push((0..ncols).map(|i| r.get_ref(i).map(|v| sqlite_value(v, decls[i].as_deref())).unwrap_or(Value::Null)).collect());
    }
    Ok(ResultSet { columns: cols, rows: data, truncated })
}

fn text_rows(c: &Connection, sql: &str, params: &[&dyn rusqlite::ToSql]) -> DbResult<Vec<Vec<Option<String>>>> {
    let mut st = c.prepare(sql).map_err(map_err)?;
    let n = st.column_count();
    let rows = st
        .query_map(params, |r| {
            (0..n)
                .map(|i| {
                    Ok(match r.get_ref(i)? {
                        ValueRef::Null => None,
                        ValueRef::Integer(x) => Some(x.to_string()),
                        ValueRef::Real(x) => Some(x.to_string()),
                        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
                        ValueRef::Blob(_) => Some("<blob>".into()),
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(map_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(map_err)
}

fn schema_name(s: Option<&str>) -> String {
    s.filter(|s| !s.is_empty()).unwrap_or("main").to_string()
}

#[async_trait]
impl DatabaseConnection for SqliteConnection {
    fn engine(&self) -> Engine {
        Engine::Sqlite
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            sql: true,
            transactions: true,
            schemas: true, // attached databases act as schemas
            multiple_databases: false,
            explain: true,
            explain_analyze: false,
            cancel: true,
            inline_edit: true,
            ddl_editing: true,
            read_only_session: true,
            sessions_monitor: false,
            kill_session: false,
            native_backup: true,
            object_kinds: vec![ObjectKind::Table, ObjectKind::View, ObjectKind::Index, ObjectKind::Trigger],
        }
    }

    async fn server_info(&self) -> DbResult<ServerInfo> {
        self.with(|c| {
            let v: String = c.query_row("SELECT sqlite_version()", [], |r| r.get(0)).map_err(map_err)?;
            Ok(ServerInfo { engine: Engine::Sqlite, version: v, current_database: Some("main".into()), current_user: None })
        })
        .await
    }

    async fn ping(&self) -> DbResult<()> {
        self.with(|c| c.query_row("SELECT 1", [], |_| Ok(())).map_err(map_err)).await
    }

    async fn close(&self) -> DbResult<()> {
        Ok(())
    }

    async fn list_databases(&self) -> DbResult<Vec<String>> {
        Ok(vec!["main".into()])
    }

    async fn list_schemas(&self, _database: Option<&str>) -> DbResult<Vec<String>> {
        self.with(|c| Ok(text_rows(c, "SELECT name FROM pragma_database_list ORDER BY seq", &[])?.into_iter().filter_map(|r| r[0].clone()).collect())).await
    }

    async fn list_objects(&self, schema: Option<&str>) -> DbResult<Vec<ObjectRef>> {
        let schema = schema_name(schema);
        self.with(move |c| {
            let master = format!("{}.sqlite_master", Dialect::Sqlite.quote_ident(&schema)?);
            let rows = text_rows(c, &format!("SELECT type, name FROM {master} WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"), &[])?;
            Ok(rows
                .into_iter()
                .filter_map(|r| {
                    let kind = match r[0].as_deref()? {
                        "table" => ObjectKind::Table,
                        "view" => ObjectKind::View,
                        "index" => ObjectKind::Index,
                        "trigger" => ObjectKind::Trigger,
                        _ => return None,
                    };
                    Some(ObjectRef { kind, database: None, schema: Some(schema.clone()), name: r[1].clone()? })
                })
                .collect())
        })
        .await
    }

    async fn describe_table(&self, target: &TableTarget) -> DbResult<TableDescription> {
        let schema = schema_name(target.schema.as_deref());
        let table = target.table.clone();
        self.with(move |c| {
            let qs = Dialect::Sqlite.quote_ident(&schema)?;
            let cols = text_rows(
                c,
                "SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_xinfo(?1, ?2) WHERE hidden IN (0,2,3)",
                &[&table, &schema],
            )?;
            if cols.is_empty() {
                return Err(DbError::new(ErrorKind::NotFound, "table not found"));
            }
            let mut pk: Vec<(i64, String)> = Vec::new();
            let columns = cols
                .iter()
                .map(|r| {
                    let name = r[1].clone().unwrap_or_default();
                    let pkpos: i64 = r[5].as_deref().and_then(|s| s.parse().ok()).unwrap_or(0);
                    if pkpos > 0 {
                        pk.push((pkpos, name.clone()));
                    }
                    let ty = r[2].clone().unwrap_or_default();
                    ColumnDef {
                        is_identity: pkpos > 0 && ty.eq_ignore_ascii_case("INTEGER"),
                        name,
                        data_type: ty,
                        nullable: r[3].as_deref() != Some("1"),
                        default: r[4].clone(),
                        is_primary_key: pkpos > 0,
                        comment: None,
                        ordinal: r[0].as_deref().and_then(|s| s.parse().ok()).unwrap_or(0),
                    }
                })
                .collect();
            pk.sort();
            let idx_rows = text_rows(c, "SELECT name, \"unique\", origin FROM pragma_index_list(?1, ?2)", &[&table, &schema])?;
            let mut indexes = Vec::new();
            for r in idx_rows {
                let name = r[0].clone().unwrap_or_default();
                let cols = text_rows(c, "SELECT name FROM pragma_index_info(?1, ?2) ORDER BY seqno", &[&name, &schema])?
                    .into_iter()
                    .map(|x| x[0].clone().unwrap_or_else(|| "<expr>".into()))
                    .collect();
                let def = text_rows(c, &format!("SELECT sql FROM {qs}.sqlite_master WHERE type='index' AND name=?1"), &[&name])?
                    .into_iter()
                    .next()
                    .and_then(|x| x[0].clone());
                indexes.push(IndexDef { name, columns: cols, unique: r[1].as_deref() == Some("1"), primary: r[2].as_deref() == Some("pk"), definition: def });
            }
            let fk_rows = text_rows(
                c,
                "SELECT id, \"table\", \"from\", \"to\", on_update, on_delete FROM pragma_foreign_key_list(?1, ?2) ORDER BY id, seq",
                &[&table, &schema],
            )?;
            let mut fks: Vec<ForeignKeyDef> = Vec::new();
            for r in fk_rows {
                let id = r[0].clone().unwrap_or_default();
                let name = format!("fk_{table}_{id}");
                if let Some(f) = fks.iter_mut().find(|f| f.name == name) {
                    f.columns.push(r[2].clone().unwrap_or_default());
                    f.ref_columns.push(r[3].clone().unwrap_or_default());
                } else {
                    fks.push(ForeignKeyDef {
                        name,
                        columns: vec![r[2].clone().unwrap_or_default()],
                        ref_schema: None,
                        ref_table: r[1].clone().unwrap_or_default(),
                        ref_columns: vec![r[3].clone().unwrap_or_default()],
                        on_update: r[4].clone(),
                        on_delete: r[5].clone(),
                    });
                }
            }
            let ddl = text_rows(c, &format!("SELECT sql FROM {qs}.sqlite_master WHERE name=?1 AND type IN ('table','view')"), &[&table])?
                .into_iter()
                .next()
                .and_then(|r| r[0].clone());
            let qt = Dialect::Sqlite.qualified(&TableTarget { schema: Some(schema.clone()), table: table.clone() })?;
            let est: Option<i64> = c.query_row(&format!("SELECT count(*) FROM {qt}"), [], |r| r.get(0)).ok();
            Ok(TableDescription {
                object: ObjectRef { kind: ObjectKind::Table, database: None, schema: Some(schema), name: table },
                columns,
                primary_key: pk.into_iter().map(|(_, n)| n).collect(),
                indexes,
                foreign_keys: fks,
                constraints: vec![],
                ddl,
                estimated_rows: est,
                comment: None,
            })
        })
        .await
    }

    async fn object_ddl(&self, object: &ObjectRef) -> DbResult<String> {
        let schema = schema_name(object.schema.as_deref());
        let name = object.name.clone();
        self.with(move |c| {
            let qs = Dialect::Sqlite.quote_ident(&schema)?;
            text_rows(c, &format!("SELECT sql FROM {qs}.sqlite_master WHERE name=?1"), &[&name])?
                .into_iter()
                .next()
                .and_then(|r| r[0].clone())
                .map(|s| format!("{s};"))
                .ok_or_else(|| DbError::new(ErrorKind::NotFound, "object not found"))
        })
        .await
    }

    async fn execute(&self, sql: &str, opts: &ExecOptions, cancel: CancellationToken) -> DbResult<Vec<StatementResult>> {
        let sql = sql.to_string();
        let o = opts.clone();
        let ih = self.interrupt.clone();
        let fut = self.with(move |c| run_script(c, &sql, &o));
        guarded(fut, cancel, opts.timeout_ms, || async move { ih.interrupt() }).await
    }

    async fn execute_params(&self, stmt: &GeneratedStatement) -> DbResult<u64> {
        let sql = stmt.sql.clone();
        let ps = stmt.params.iter().map(to_sqlite).collect::<DbResult<Vec<_>>>()?;
        self.with(move |c| c.execute(&sql, rusqlite::params_from_iter(ps.iter())).map(|n| n as u64).map_err(map_err)).await
    }

    async fn fetch_table(&self, target: &TableTarget, page: &PageRequest) -> DbResult<ResultSet> {
        let mut t = target.clone();
        t.schema = Some(schema_name(t.schema.as_deref()));
        let g = build_page_query(Dialect::Sqlite, &t, page)?;
        let max = page.limit.clamp(1, MAX_PAGE_SIZE) as usize;
        let table = t.table.clone();
        self.with(move |c| {
            let mut rs = query_rows(c, &g.sql, &g.params, max)?;
            for col in &mut rs.columns {
                col.table = Some(table.clone());
            }
            Ok(rs)
        })
        .await
    }

    async fn count_rows(&self, target: &TableTarget, filter: &[FilterCondition]) -> DbResult<u64> {
        let mut t = target.clone();
        t.schema = Some(schema_name(t.schema.as_deref()));
        let q = Dialect::Sqlite.qualified(&t)?;
        let (w, params) = build_filter(Dialect::Sqlite, filter, 0)?;
        self.with(move |c| {
            let rs = query_rows(c, &format!("SELECT count(*) FROM {q}{w}"), &params, 1)?;
            match rs.rows.first().and_then(|r| r.first()) {
                Some(Value::Int(n)) => Ok(*n as u64),
                _ => Ok(0),
            }
        })
        .await
    }

    async fn begin(&self) -> DbResult<()> {
        self.with(|c| c.execute_batch("BEGIN").map_err(map_err)).await
    }
    async fn commit(&self) -> DbResult<()> {
        self.with(|c| c.execute_batch("COMMIT").map_err(map_err)).await
    }
    async fn rollback(&self) -> DbResult<()> {
        self.with(|c| c.execute_batch("ROLLBACK").map_err(map_err)).await
    }

    async fn explain(&self, sql: &str, _analyze: bool) -> DbResult<ResultSet> {
        let q = format!("EXPLAIN QUERY PLAN {sql}");
        self.with(move |c| query_rows(c, &q, &[], 10_000)).await
    }

    async fn set_read_only(&self, ro: bool) -> DbResult<()> {
        let s = if ro { "PRAGMA query_only = ON" } else { "PRAGMA query_only = OFF" };
        self.with(move |c| c.execute_batch(s).map_err(map_err)).await
    }

    async fn cancel_running(&self) -> DbResult<()> {
        self.interrupt.interrupt();
        Ok(())
    }
}

/// Consistent online backup using SQLite's backup API.
pub async fn backup_to(src_path: &str, dest_path: &str) -> DbResult<()> {
    let s = src_path.to_string();
    let d = dest_path.to_string();
    tokio::task::spawn_blocking(move || {
        let src = Connection::open_with_flags(&s, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(map_err)?;
        let mut dst = Connection::open(&d).map_err(map_err)?;
        let b = rusqlite::backup::Backup::new(&src, &mut dst).map_err(map_err)?;
        b.run_to_completion(256, std::time::Duration::from_millis(5), None).map_err(map_err)?;
        drop(b);
        let ok: String = dst.query_row("PRAGMA integrity_check", [], |r| r.get(0)).map_err(map_err)?;
        if ok != "ok" {
            return Err(DbError::new(ErrorKind::Io, format!("backup integrity check failed: {ok}")));
        }
        Ok(())
    })
    .await
    .map_err(|e| DbError::internal(e.to_string()))?
}
