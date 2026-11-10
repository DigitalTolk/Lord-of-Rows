use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::*;

/// What a driver can do. The UI disables actions whose capability is false, and
/// the backend refuses them, so nothing is advertised that the engine can't do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Capabilities {
    pub sql: bool,
    pub transactions: bool,
    pub schemas: bool,
    pub multiple_databases: bool,
    pub explain: bool,
    pub explain_analyze: bool,
    pub cancel: bool,
    pub inline_edit: bool,
    pub ddl_editing: bool,
    pub read_only_session: bool,
    pub sessions_monitor: bool,
    pub kill_session: bool,
    pub native_backup: bool,
    pub object_kinds: Vec<ObjectKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecOptions {
    /// Stop reading after this many rows per result set (memory bound).
    pub max_rows: usize,
    pub timeout_ms: Option<u64>,
}

impl Default for ExecOptions {
    fn default() -> Self {
        Self { max_rows: 10_000, timeout_ms: None }
    }
}

/// Secrets resolved by the backend at connect time. Never serialised, never sent
/// to the frontend, dropped when the connection is established.
#[derive(Default)]
pub struct ConnectSecrets {
    pub password: Option<String>,
}

impl std::fmt::Debug for ConnectSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectSecrets").field("password", &self.password.as_ref().map(|_| "***")).finish()
    }
}

/// An open connection (session) to a database. One per tab/session; pooling is
/// handled by the session manager above this layer.
#[async_trait]
pub trait DatabaseConnection: Send + Sync {
    fn engine(&self) -> Engine;
    fn dialect(&self) -> Dialect {
        Dialect::from(self.engine())
    }
    fn capabilities(&self) -> Capabilities;

    async fn server_info(&self) -> DbResult<ServerInfo>;
    async fn ping(&self) -> DbResult<()>;
    async fn close(&self) -> DbResult<()>;

    async fn list_databases(&self) -> DbResult<Vec<String>>;
    async fn list_schemas(&self, database: Option<&str>) -> DbResult<Vec<String>>;
    async fn list_objects(&self, schema: Option<&str>) -> DbResult<Vec<ObjectRef>>;
    async fn describe_table(&self, target: &TableTarget) -> DbResult<TableDescription>;
    /// DDL for any object kind, where the engine can produce it.
    async fn object_ddl(&self, object: &ObjectRef) -> DbResult<String>;

    /// Execute user-authored SQL (possibly multiple statements). The safety
    /// policy has already been applied by the caller.
    async fn execute(&self, sql: &str, opts: &ExecOptions, cancel: CancellationToken) -> DbResult<Vec<StatementResult>>;

    /// Execute one application-generated parameterised statement.
    async fn execute_params(&self, stmt: &GeneratedStatement) -> DbResult<u64>;

    /// Paged table read with server-side sort/filter. `filter_sql` is a WHERE
    /// fragment built by [`crate::build_filter`]; values are passed as parameters.
    async fn fetch_table(&self, target: &TableTarget, page: &PageRequest) -> DbResult<ResultSet>;

    async fn count_rows(&self, target: &TableTarget, filter: &[FilterCondition]) -> DbResult<u64>;

    async fn begin(&self) -> DbResult<()>;
    async fn commit(&self) -> DbResult<()>;
    async fn rollback(&self) -> DbResult<()>;

    /// Apply staged grid changes atomically: all succeed or all roll back.
    /// Any change affecting 0 rows is a conflict and aborts the batch.
    async fn apply_changes(&self, target: &TableTarget, changes: &[RowChange]) -> DbResult<ApplyReport> {
        if !self.capabilities().inline_edit {
            return Err(DbError::unsupported("inline editing"));
        }
        let d = self.dialect();
        let stmts = changes.iter().map(|c| build_change_sql(d, target, c)).collect::<DbResult<Vec<_>>>()?;
        self.begin().await?;
        let mut report = ApplyReport::default();
        for (i, s) in stmts.iter().enumerate() {
            match self.execute_params(s).await {
                Ok(0) => report.conflicts.push(i),
                Ok(n) => {
                    report.applied += 1;
                    report.rows_affected += n;
                }
                Err(e) => {
                    let _ = self.rollback().await;
                    return Err(e);
                }
            }
        }
        if !report.conflicts.is_empty() {
            self.rollback().await?;
            return Ok(report);
        }
        self.commit().await?;
        report.committed = true;
        Ok(report)
    }

    async fn explain(&self, sql: &str, analyze: bool) -> DbResult<ResultSet> {
        let _ = (sql, analyze);
        Err(DbError::unsupported("EXPLAIN"))
    }

    async fn set_read_only(&self, read_only: bool) -> DbResult<()> {
        let _ = read_only;
        Err(DbError::unsupported("read-only sessions"))
    }

    async fn list_sessions(&self) -> DbResult<Vec<SessionInfo>> {
        Err(DbError::unsupported("session monitoring"))
    }

    async fn kill_session(&self, id: &str) -> DbResult<()> {
        let _ = id;
        Err(DbError::unsupported("session termination"))
    }

    /// Cancel whatever this connection is currently running.
    async fn cancel_running(&self) -> DbResult<()> {
        Err(DbError::unsupported("query cancellation"))
    }
}

/// Factory: one per engine family.
#[async_trait]
pub trait DatabaseDriver: Send + Sync {
    fn engines(&self) -> &'static [Engine];
    async fn connect(&self, cfg: &ConnectionConfig, secrets: ConnectSecrets) -> DbResult<Box<dyn DatabaseConnection>>;
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PageRequest {
    pub offset: u64,
    pub limit: u64,
    pub order_by: Vec<(String, SortDir)>,
    pub filters: Vec<FilterCondition>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SortDir {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Contains,
    StartsWith,
    EndsWith,
    IsNull,
    IsNotNull,
    In,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FilterCondition {
    pub column: String,
    pub op: FilterOp,
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub values: Vec<Value>,
}

pub const MAX_PAGE_SIZE: u64 = 50_000;

/// Build `SELECT * FROM t WHERE ... ORDER BY ... LIMIT/OFFSET` with parameters.
pub fn build_page_query(d: Dialect, target: &TableTarget, page: &PageRequest) -> DbResult<GeneratedStatement> {
    let table = d.qualified(target)?;
    let (where_sql, params) = build_filter(d, &page.filters, 0)?;
    let mut sql = format!("SELECT * FROM {table}{where_sql}");
    if !page.order_by.is_empty() {
        let parts = page
            .order_by
            .iter()
            .map(|(c, dir)| Ok(format!("{} {}", d.quote_ident(c)?, if *dir == SortDir::Asc { "ASC" } else { "DESC" })))
            .collect::<DbResult<Vec<_>>>()?;
        sql.push_str(&format!(" ORDER BY {}", parts.join(", ")));
    }
    let limit = page.limit.clamp(1, MAX_PAGE_SIZE);
    match d {
        Dialect::SqlServer => {
            if page.order_by.is_empty() {
                sql.push_str(" ORDER BY (SELECT NULL)");
            }
            sql.push_str(&format!(" OFFSET {} ROWS FETCH NEXT {} ROWS ONLY", page.offset, limit));
        }
        _ => sql.push_str(&format!(" LIMIT {} OFFSET {}", limit, page.offset)),
    }
    Ok(GeneratedStatement { sql, params })
}

/// Returns (" WHERE ..." or "", params). `start` is the number of params already used.
pub fn build_filter(d: Dialect, filters: &[FilterCondition], start: usize) -> DbResult<(String, Vec<Value>)> {
    if filters.is_empty() {
        return Ok((String::new(), vec![]));
    }
    let mut params: Vec<Value> = Vec::new();
    let mut parts = Vec::new();
    let like_escape = |s: &str| s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    for f in filters {
        let col = d.quote_ident(&f.column)?;
        let need = || f.value.clone().ok_or_else(|| DbError::invalid("filter value required"));
        let push = |v: Value, params: &mut Vec<Value>| {
            params.push(v);
            d.placeholder(start + params.len())
        };
        let esc = if d == Dialect::MySql { "" } else { " ESCAPE '\\'" };
        let part = match f.op {
            FilterOp::IsNull => format!("{col} IS NULL"),
            FilterOp::IsNotNull => format!("{col} IS NOT NULL"),
            FilterOp::Contains | FilterOp::StartsWith | FilterOp::EndsWith => {
                let raw = need()?.to_plain().unwrap_or_default();
                let e = like_escape(&raw);
                let pat = match f.op {
                    FilterOp::Contains => format!("%{e}%"),
                    FilterOp::StartsWith => format!("{e}%"),
                    _ => format!("%{e}"),
                };
                let p = push(Value::Text(pat), &mut params);
                let lhs = match d {
                    Dialect::Postgres => format!("CAST({col} AS TEXT)"),
                    _ => col.clone(),
                };
                format!("{lhs} LIKE {p}{esc}")
            }
            FilterOp::In => {
                if f.values.is_empty() || f.values.len() > 1000 {
                    return Err(DbError::invalid("IN filter needs 1-1000 values"));
                }
                let ps: Vec<_> = f.values.iter().map(|v| push(v.clone(), &mut params)).collect();
                format!("{col} IN ({})", ps.join(", "))
            }
            op => {
                let p = push(need()?, &mut params);
                let sym = match op {
                    FilterOp::Eq => "=",
                    FilterOp::Ne => "<>",
                    FilterOp::Lt => "<",
                    FilterOp::Le => "<=",
                    FilterOp::Gt => ">",
                    _ => ">=",
                };
                format!("{col} {sym} {p}")
            }
        };
        parts.push(part);
    }
    Ok((format!(" WHERE {}", parts.join(" AND ")), params))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_query_is_parameterised() {
        let t = TableTarget { schema: Some("public".into()), table: "t".into() };
        let page = PageRequest {
            offset: 100,
            limit: 50,
            order_by: vec![("id".into(), SortDir::Desc)],
            filters: vec![
                FilterCondition { column: "name".into(), op: FilterOp::Contains, value: Some(Value::Text("50%' OR 1=1".into())), values: vec![] },
                FilterCondition { column: "x".into(), op: FilterOp::IsNull, value: None, values: vec![] },
            ],
        };
        let s = build_page_query(Dialect::Postgres, &t, &page).unwrap();
        assert_eq!(
            s.sql,
            "SELECT * FROM \"public\".\"t\" WHERE CAST(\"name\" AS TEXT) LIKE $1 ESCAPE '\\' AND \"x\" IS NULL ORDER BY \"id\" DESC LIMIT 50 OFFSET 100"
        );
        assert_eq!(s.params, vec![Value::Text("%50\\%' OR 1=1%".into())]);
    }

    #[test]
    fn page_size_is_clamped() {
        let t = TableTarget { schema: None, table: "t".into() };
        let s = build_page_query(Dialect::MySql, &t, &PageRequest { limit: 10_000_000, ..Default::default() }).unwrap();
        assert!(s.sql.ends_with("LIMIT 50000 OFFSET 0"));
    }

    #[test]
    fn secrets_debug_is_redacted() {
        let s = ConnectSecrets { password: Some("hunter2".into()) };
        assert!(!format!("{s:?}").contains("hunter2"));
    }
}
