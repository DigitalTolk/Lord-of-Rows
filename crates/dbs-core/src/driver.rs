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

    /// Like [`Self::execute`], but delivers rows incrementally through `sink`
    /// (batched, capped at the sink's `max_rows` per result set, with
    /// backpressure). The safety policy has already been applied by the caller.
    /// The default materialises via `execute` and replays; engines with a
    /// cursor/stream API override it.
    async fn execute_stream(&self, sql: &str, opts: &ExecOptions, cancel: CancellationToken, mut sink: RowSink) -> DbResult<()> {
        let mut o = opts.clone();
        o.max_rows = sink.max_rows();
        let results = self.execute(sql, &o, cancel).await?;
        sink.replay(results).await
    }

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

    /// Human-readable text of what [`Self::apply_changes`] will run, shown for review
    /// and bound into the confirmation token. SQL engines preview the generated SQL.
    fn preview_changes(&self, target: &TableTarget, changes: &[RowChange]) -> DbResult<Vec<String>> {
        let d = self.dialect();
        changes.iter().map(|c| build_change_sql(d, target, c).map(|g| g.preview(d))).collect()
    }

    async fn explain(&self, sql: &str, analyze: bool) -> DbResult<ResultSet> {
        let _ = (sql, analyze);
        Err(DbError::unsupported("EXPLAIN"))
    }

    /// Make `schema` the default for unqualified names in user SQL
    /// (Postgres `search_path`, MySQL `USE`). No-op where not applicable.
    async fn use_schema(&self, schema: &str) -> DbResult<()> {
        let _ = schema;
        Ok(())
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    #[default]
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    /// `LIKE '%v%'` with the user's wildcards escaped.
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    /// `LIKE v` with the user's own pattern (wildcards are live).
    Like,
    NotLike,
    IsNull,
    IsNotNull,
    In,
    NotIn,
    /// `BETWEEN values[0] AND values[1]`.
    Between,
    /// A user-written boolean SQL expression in `value` (text). It is spliced into
    /// the WHERE clause verbatim, so every entry point MUST validate it first with
    /// `dbs_safety::validate_filter_expression` (the Tauri commands do).
    Raw,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FilterCondition {
    #[serde(default)]
    pub column: String,
    pub op: FilterOp,
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub values: Vec<Value>,
    /// "Any column": when non-empty, `column` is ignored and the condition matches
    /// a row if it holds for at least one of these columns (each cast to text,
    /// combined with OR).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub any_columns: Vec<String>,
}

pub const MAX_PAGE_SIZE: u64 = 50_000;
/// Upper bound on a raw filter expression (bytes).
pub const MAX_RAW_FILTER_LEN: usize = 4000;
/// Upper bound on the number of columns an "Any column" filter may search.
pub const MAX_ANY_COLUMNS: usize = 1000;

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

/// Human-readable form of [`build_page_query`] for display (filter bar "SQL"
/// button): parameters are inlined as literals and raw expressions verbatim.
/// Never executed.
pub fn page_query_preview(d: Dialect, target: &TableTarget, page: &PageRequest) -> DbResult<String> {
    let mut p = page.clone();
    let mut raws = Vec::new();
    for (i, f) in p.filters.iter_mut().enumerate() {
        if f.op == FilterOp::Raw {
            let sentinel = format!("\u{1}RAW{i}\u{1}");
            raws.push((sentinel.clone(), raw_expr(f)?.to_string()));
            f.value = Some(Value::Text(sentinel));
        }
    }
    let mut out = build_page_query(d, target, &p)?.preview(d);
    for (sentinel, expr) in raws {
        out = out.replace(&sentinel, &expr);
    }
    Ok(out)
}

/// Cast an (already quoted) column to text for "Any column" searches.
fn text_cast(d: Dialect, col: &str) -> String {
    match d {
        Dialect::MySql => format!("CAST({col} AS CHAR)"),
        Dialect::SqlServer => format!("CAST({col} AS NVARCHAR(MAX))"),
        _ => format!("CAST({col} AS TEXT)"),
    }
}

fn raw_expr(f: &FilterCondition) -> DbResult<&str> {
    let expr = match &f.value {
        Some(Value::Text(s)) => s.trim(),
        _ => return Err(DbError::invalid("raw SQL filter needs an expression")),
    };
    if expr.is_empty() || expr.len() > MAX_RAW_FILTER_LEN || expr.contains('\0') {
        return Err(DbError::invalid("raw SQL filter must be 1-4000 characters"));
    }
    if !f.any_columns.is_empty() {
        return Err(DbError::invalid("raw SQL filter cannot target columns"));
    }
    Ok(expr)
}

/// Returns (" WHERE ..." or "", params). `start` is the number of params already used.
/// Conditions are combined with AND. Every value is a bound parameter; only
/// identifiers (quoted) and validated raw expressions are spliced into the text.
pub fn build_filter(d: Dialect, filters: &[FilterCondition], start: usize) -> DbResult<(String, Vec<Value>)> {
    if filters.is_empty() {
        return Ok((String::new(), vec![]));
    }
    let mut params: Vec<Value> = Vec::new();
    let mut parts = Vec::new();
    for f in filters {
        let part = if f.op == FilterOp::Raw {
            format!("({})", raw_expr(f)?)
        } else if !f.any_columns.is_empty() {
            if f.any_columns.len() > MAX_ANY_COLUMNS {
                return Err(DbError::invalid("too many columns for an \"any column\" filter"));
            }
            let ors = f
                .any_columns
                .iter()
                .map(|c| {
                    let col = text_cast(d, &d.quote_ident(c)?);
                    predicate(d, &col, f, true, start, &mut params)
                })
                .collect::<DbResult<Vec<_>>>()?;
            format!("({})", ors.join(" OR "))
        } else {
            let col = d.quote_ident(&f.column)?;
            predicate(d, &col, f, false, start, &mut params)?
        };
        parts.push(part);
    }
    Ok((format!(" WHERE {}", parts.join(" AND ")), params))
}

/// One condition on one (quoted, possibly text-cast) column expression.
fn predicate(d: Dialect, col: &str, f: &FilterCondition, as_text: bool, start: usize, params: &mut Vec<Value>) -> DbResult<String> {
    let like_escape = |s: &str| s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let coerce = |v: Value| if as_text { Value::Text(v.to_plain().unwrap_or_default()) } else { v };
    let need = || f.value.clone().map(coerce).ok_or_else(|| DbError::invalid("filter value required"));
    let mut push = |v: Value| {
        params.push(v);
        d.placeholder(start + params.len())
    };
    let esc = if d == Dialect::MySql { "" } else { " ESCAPE '\\'" };
    // LIKE needs a text operand; non-text columns are cast on Postgres (others coerce).
    let like_lhs = match d {
        Dialect::Postgres if !as_text => format!("CAST({col} AS TEXT)"),
        _ => col.to_string(),
    };
    Ok(match f.op {
        FilterOp::IsNull => format!("{col} IS NULL"),
        FilterOp::IsNotNull => format!("{col} IS NOT NULL"),
        FilterOp::Contains | FilterOp::NotContains | FilterOp::StartsWith | FilterOp::EndsWith => {
            let raw = f.value.as_ref().ok_or_else(|| DbError::invalid("filter value required"))?.to_plain().unwrap_or_default();
            let e = like_escape(&raw);
            let pat = match f.op {
                FilterOp::Contains | FilterOp::NotContains => format!("%{e}%"),
                FilterOp::StartsWith => format!("{e}%"),
                _ => format!("%{e}"),
            };
            let p = push(Value::Text(pat));
            let not = if f.op == FilterOp::NotContains { "NOT " } else { "" };
            format!("{like_lhs} {not}LIKE {p}{esc}")
        }
        FilterOp::Like | FilterOp::NotLike => {
            let pat = f.value.as_ref().ok_or_else(|| DbError::invalid("filter value required"))?.to_plain().unwrap_or_default();
            let p = push(Value::Text(pat));
            let not = if f.op == FilterOp::NotLike { "NOT " } else { "" };
            format!("{like_lhs} {not}LIKE {p}")
        }
        FilterOp::In | FilterOp::NotIn => {
            if f.values.is_empty() || f.values.len() > 1000 {
                return Err(DbError::invalid("IN filter needs 1-1000 values"));
            }
            let ps: Vec<_> = f.values.iter().map(|v| push(coerce(v.clone()))).collect();
            let not = if f.op == FilterOp::NotIn { "NOT " } else { "" };
            format!("{col} {not}IN ({})", ps.join(", "))
        }
        FilterOp::Between => {
            let [lo, hi] = f.values.as_slice() else {
                return Err(DbError::invalid("BETWEEN needs exactly two values"));
            };
            let a = push(coerce(lo.clone()));
            let b = push(coerce(hi.clone()));
            format!("{col} BETWEEN {a} AND {b}")
        }
        FilterOp::Raw => return Err(DbError::invalid("raw SQL filter cannot target columns")),
        op => {
            let p = push(need()?);
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
    })
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
                FilterCondition {
                    column: "name".into(),
                    op: FilterOp::Contains,
                    value: Some(Value::Text("50%' OR 1=1".into())),
                    values: vec![],
                    ..Default::default()
                },
                FilterCondition { column: "x".into(), op: FilterOp::IsNull, value: None, values: vec![], ..Default::default() },
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

    fn cond(column: &str, op: FilterOp, value: Option<Value>, values: Vec<Value>) -> FilterCondition {
        FilterCondition { column: column.into(), op, value, values, any_columns: vec![] }
    }

    #[test]
    fn new_operators_per_dialect() {
        let f = vec![
            cond("a", FilterOp::NotIn, None, vec![Value::Int(1), Value::Int(2)]),
            cond("b", FilterOp::Between, None, vec![Value::Int(3), Value::Int(9)]),
            cond("c", FilterOp::NotContains, Some(Value::Text("x_y".into())), vec![]),
            cond("d", FilterOp::Like, Some(Value::Text("ab%".into())), vec![]),
            cond("e", FilterOp::NotLike, Some(Value::Text("%z".into())), vec![]),
        ];
        let (pg, p) = build_filter(Dialect::Postgres, &f, 0).unwrap();
        assert_eq!(
            pg,
            " WHERE \"a\" NOT IN ($1, $2) AND \"b\" BETWEEN $3 AND $4 AND CAST(\"c\" AS TEXT) NOT LIKE $5 ESCAPE '\\' AND CAST(\"d\" AS TEXT) LIKE $6 AND CAST(\"e\" AS TEXT) NOT LIKE $7"
        );
        assert_eq!(p[4], Value::Text("%x\\_y%".into()));
        assert_eq!(p[5], Value::Text("ab%".into()), "LIKE keeps the user's wildcards");
        let (my, p) = build_filter(Dialect::MySql, &f, 0).unwrap();
        assert_eq!(my, " WHERE `a` NOT IN (?, ?) AND `b` BETWEEN ? AND ? AND `c` NOT LIKE ? AND `d` LIKE ? AND `e` NOT LIKE ?");
        assert_eq!(p.len(), 7);
        let (lite, _) = build_filter(Dialect::Sqlite, &f, 2).unwrap();
        assert!(lite.starts_with(" WHERE \"a\" NOT IN (?3, ?4) AND \"b\" BETWEEN ?5 AND ?6"), "{lite}");
        assert!(build_filter(Dialect::Postgres, &[cond("b", FilterOp::Between, None, vec![Value::Int(1)])], 0).is_err());
        assert!(build_filter(Dialect::Postgres, &[cond("b", FilterOp::NotIn, None, vec![])], 0).is_err());
    }

    #[test]
    fn any_column_ors_text_casts_with_parameters() {
        let f = vec![FilterCondition {
            op: FilterOp::Contains,
            value: Some(Value::Text("o'k".into())),
            any_columns: vec!["id".into(), "na`me".into()],
            ..Default::default()
        }];
        let (my, p) = build_filter(Dialect::MySql, &f, 0).unwrap();
        assert_eq!(my, " WHERE (CAST(`id` AS CHAR) LIKE ? OR CAST(`na``me` AS CHAR) LIKE ?)");
        assert_eq!(p, vec![Value::Text("%o'k%".into()), Value::Text("%o'k%".into())]);
        let (pg, _) = build_filter(Dialect::Postgres, &f, 0).unwrap();
        assert_eq!(pg, " WHERE (CAST(\"id\" AS TEXT) LIKE $1 ESCAPE '\\' OR CAST(\"na`me\" AS TEXT) LIKE $2 ESCAPE '\\')");
        let (lite, _) = build_filter(Dialect::Sqlite, &f, 0).unwrap();
        assert_eq!(lite, " WHERE (CAST(\"id\" AS TEXT) LIKE ?1 ESCAPE '\\' OR CAST(\"na`me\" AS TEXT) LIKE ?2 ESCAPE '\\')");
        // Equality compares the text form; numbers are sent as text parameters.
        let eq = vec![FilterCondition { op: FilterOp::Eq, value: Some(Value::Int(4)), any_columns: vec!["a".into()], ..Default::default() }];
        let (sql, p) = build_filter(Dialect::Postgres, &eq, 0).unwrap();
        assert_eq!(sql, " WHERE (CAST(\"a\" AS TEXT) = $1)");
        assert_eq!(p, vec![Value::Text("4".into())]);
        // Combined with a normal filter using AND.
        let both = vec![eq[0].clone(), cond("b", FilterOp::IsNull, None, vec![])];
        assert_eq!(build_filter(Dialect::MySql, &both, 0).unwrap().0, " WHERE (CAST(`a` AS CHAR) = ?) AND `b` IS NULL");
    }

    #[test]
    fn raw_filter_is_wrapped_and_previewed() {
        let t = TableTarget { schema: Some("app".into()), table: "users".into() };
        let page = PageRequest {
            offset: 0,
            limit: 300,
            order_by: vec![("id".into(), SortDir::Asc)],
            filters: vec![
                cond("", FilterOp::Raw, Some(Value::Text("  age > 3 OR name = 'a?b'  ".into())), vec![]),
                cond("name", FilterOp::Eq, Some(Value::Text("x?".into())), vec![]),
                cond("id", FilterOp::Gt, Some(Value::Int(4)), vec![]),
            ],
        };
        let g = build_page_query(Dialect::MySql, &t, &page).unwrap();
        assert_eq!(g.sql, "SELECT * FROM `app`.`users` WHERE (age > 3 OR name = 'a?b') AND `name` = ? AND `id` > ? ORDER BY `id` ASC LIMIT 300 OFFSET 0");
        assert_eq!(g.params.len(), 2);
        let preview = page_query_preview(Dialect::MySql, &t, &page).unwrap();
        assert_eq!(preview, "SELECT * FROM `app`.`users` WHERE (age > 3 OR name = 'a?b') AND `name` = 'x?' AND `id` > 4 ORDER BY `id` ASC LIMIT 300 OFFSET 0");
        let pg = page_query_preview(Dialect::Postgres, &t, &page).unwrap();
        assert!(pg.contains("WHERE (age > 3 OR name = 'a?b') AND \"name\" = 'x?' AND \"id\" > 4"), "{pg}");
        assert!(build_filter(Dialect::MySql, &[cond("", FilterOp::Raw, Some(Value::Text("   ".into())), vec![])], 0).is_err());
        assert!(build_filter(Dialect::MySql, &[cond("", FilterOp::Raw, None, vec![])], 0).is_err());
        let long = "a".repeat(MAX_RAW_FILTER_LEN + 1);
        assert!(build_filter(Dialect::MySql, &[cond("", FilterOp::Raw, Some(Value::Text(long)), vec![])], 0).is_err());
    }

    #[test]
    fn filter_condition_deserializes_without_new_fields() {
        let f: FilterCondition = serde_json::from_str(r#"{"column":"a","op":"not_in","values":[{"t":"int","v":1}]}"#).unwrap();
        assert_eq!(f.op, FilterOp::NotIn);
        assert!(f.any_columns.is_empty());
        let raw: FilterCondition = serde_json::from_str(r#"{"op":"raw","value":{"t":"text","v":"1=1"}}"#).unwrap();
        assert_eq!(raw.op, FilterOp::Raw);
    }

    #[test]
    fn secrets_debug_is_redacted() {
        let s = ConnectSecrets { password: Some("hunter2".into()) };
        assert!(!format!("{s:?}").contains("hunter2"));
    }
}
