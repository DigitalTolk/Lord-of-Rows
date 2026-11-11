//! Amazon DynamoDB driver (official AWS SDK).
//!
//! Connection mapping (see `ConnectionConfig::validate`):
//! * `host`     optional endpoint URL (`http://127.0.0.1:8000` for DynamoDB Local /
//!   LocalStack); empty = the AWS endpoint for the region.
//! * `database` region (default `us-east-1`).
//! * `username` access key id, or `profile:NAME` for a named AWS profile; empty = the
//!   standard AWS credential chain (env, `~/.aws`, SSO, ...).
//! * password   secret access key (OS keychain).
//!
//! "SQL" is PartiQL via `ExecuteStatement`. Browsing is a `Scan`; DynamoDB pages by
//! `LastEvaluatedKey`, not offset, so the connection caches continuation keys per
//! (table, filters) at the positions it has already reached: sequential paging costs
//! one Scan per page, a jump forward scans from the nearest cached position.
//! Grid edits are applied atomically with `TransactWriteItems`; updates/deletes carry
//! a `ConditionExpression` on the originally loaded values (optimistic concurrency).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use aws_config::BehaviorVersion;
use aws_sdk_dynamodb::config::timeout::TimeoutConfig;
use aws_sdk_dynamodb::config::{Credentials, Region};
use aws_sdk_dynamodb::error::{DisplayErrorContext, ProvideErrorMetadata, SdkError};
use aws_sdk_dynamodb::operation::transact_write_items::TransactWriteItemsError;
use aws_sdk_dynamodb::primitives::Blob;
use aws_sdk_dynamodb::types::{AttributeValue, Delete, KeyType, Put, Select, TransactWriteItem, Update};
use aws_sdk_dynamodb::Client;
use dbs_core::*;
use dbs_safety::Risk;
use tokio_util::sync::CancellationToken;

use crate::util::{elapsed_ms, excerpt, guarded_abort};

type Item = HashMap<String, AttributeValue>;

pub struct DynamoDriver;

pub struct DynamoConnection {
    client: Client,
    region: String,
    endpoint: Option<String>,
    read_only: bool,
    /// table -> key attributes `(name, S|N|B)`, hash key first.
    keys: Mutex<HashMap<String, Vec<(String, String)>>>,
    /// (table, filters) -> item position -> ExclusiveStartKey resuming after that many items.
    cursors: Mutex<HashMap<String, BTreeMap<u64, Item>>>,
    /// table -> attribute names seen since the first page was loaded (stable column order).
    seen_columns: Mutex<HashMap<String, Vec<String>>>,
}

const MAX_CURSOR_KEYS: usize = 64;
const MAX_CURSORS_PER_KEY: usize = 1024;
const MAX_TRANSACTION_ITEMS: usize = 100;

// ---------------------------------------------------------------- errors

fn map_sdk<E, R>(e: SdkError<E, R>) -> DbError
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
    R: std::fmt::Debug + Send + Sync + 'static,
{
    let auth_hint = "Check the access key ID and secret access key (or the AWS profile). Leave the key empty to use the default AWS credential chain.";
    match &e {
        SdkError::TimeoutError(_) => DbError::new(ErrorKind::Timeout, "request to DynamoDB timed out"),
        SdkError::ServiceError(_) => {
            let code = e.code().unwrap_or("").to_string();
            let msg = e.message().map(String::from).unwrap_or_else(|| code.clone());
            let (kind, hint) = match code.as_str() {
                "ResourceNotFoundException" => (ErrorKind::NotFound, None),
                "ConditionalCheckFailedException" | "TransactionCanceledException" | "TransactionConflictException" => {
                    (ErrorKind::TransactionConflict, Some("The item was changed or deleted by someone else, or the condition did not match."))
                }
                "DuplicateItemException" => (ErrorKind::Constraint, None),
                "AccessDeniedException" => (ErrorKind::Permission, Some("The IAM identity lacks permission for this DynamoDB action.")),
                "UnrecognizedClientException"
                | "InvalidSignatureException"
                | "ExpiredTokenException"
                | "MissingAuthenticationTokenException"
                | "IncompleteSignatureException"
                | "InvalidClientTokenId"
                | "SignatureDoesNotMatch" => (ErrorKind::Authentication, Some(auth_hint)),
                "ProvisionedThroughputExceededException" | "ThrottlingException" | "RequestLimitExceeded" | "LimitExceededException" => {
                    (ErrorKind::Timeout, Some("DynamoDB throttled the request. Retry later, use smaller pages, or raise the table's capacity."))
                }
                "ValidationException" if msg.contains("well formed") || msg.to_ascii_lowercase().contains("syntax") => (ErrorKind::Syntax, None),
                "ValidationException" | "SerializationException" => (ErrorKind::InvalidInput, None),
                "ResourceInUseException" => (ErrorKind::Constraint, None),
                _ => (ErrorKind::Internal, None),
            };
            let mut err = DbError::new(kind, format!("{code}: {msg}"));
            if !code.is_empty() {
                err = err.with_code(code);
            }
            match hint {
                Some(h) => err.with_hint(h),
                None => err,
            }
        }
        other => {
            let text = DisplayErrorContext(&e).to_string();
            let lower = text.to_ascii_lowercase();
            if lower.contains("credential") || lower.contains("identity") {
                return DbError::new(ErrorKind::Authentication, "no usable AWS credentials found").with_hint(auth_hint);
            }
            let kind = match other {
                SdkError::DispatchFailure(d) if d.is_timeout() => ErrorKind::Timeout,
                SdkError::DispatchFailure(_) | SdkError::ResponseError(_) => ErrorKind::Connection,
                _ => ErrorKind::Internal,
            };
            DbError::new(kind, text).with_hint("Check the endpoint URL and region, and that DynamoDB is reachable.")
        }
    }
}

fn build_err(e: impl std::fmt::Display) -> DbError {
    DbError::internal(e.to_string())
}

// ---------------------------------------------------------------- values

/// DynamoDB type tag of an attribute value (`S`, `N`, `BOOL`, ...). Used as the column type name.
pub fn type_tag(av: &AttributeValue) -> &'static str {
    match av {
        AttributeValue::S(_) => "S",
        AttributeValue::N(_) => "N",
        AttributeValue::Bool(_) => "BOOL",
        AttributeValue::Null(_) => "NULL",
        AttributeValue::B(_) => "B",
        AttributeValue::L(_) => "L",
        AttributeValue::M(_) => "M",
        AttributeValue::Ss(_) => "SS",
        AttributeValue::Ns(_) => "NS",
        AttributeValue::Bs(_) => "BS",
        _ => "?",
    }
}

/// `N` is exact: integers inside the JS-safe range become `Int`, everything else stays decimal text.
fn number_value(n: &str) -> Value {
    if !n.contains(['.', 'e', 'E']) {
        if let Ok(i) = n.parse::<i64>() {
            if (-JS_MAX_SAFE_INT..=JS_MAX_SAFE_INT).contains(&i) {
                return Value::Int(i);
            }
        }
    }
    Value::Decimal(n.to_string())
}

/// JSON number only when it round-trips exactly; otherwise the decimal text.
fn number_json(n: &str) -> serde_json::Value {
    if !n.contains(['.', 'e', 'E']) {
        if let Ok(i) = n.parse::<i64>() {
            return i.into();
        }
        if let Ok(u) = n.parse::<u64>() {
            return u.into();
        }
    } else if let Ok(f) = n.parse::<f64>() {
        if f.is_finite() && f.to_string() == n {
            if let Some(num) = serde_json::Number::from_f64(f) {
                return serde_json::Value::Number(num);
            }
        }
    }
    serde_json::Value::String(n.to_string())
}

fn to_json(av: &AttributeValue) -> serde_json::Value {
    use serde_json::Value as J;
    match av {
        AttributeValue::S(s) => J::String(s.clone()),
        AttributeValue::N(n) => number_json(n),
        AttributeValue::Bool(b) => J::Bool(*b),
        AttributeValue::Null(_) => J::Null,
        AttributeValue::B(b) => J::String(format!("\\x{}", hex_encode(b.as_ref()))),
        AttributeValue::L(l) => J::Array(l.iter().map(to_json).collect()),
        AttributeValue::M(m) => J::Object(m.iter().map(|(k, v)| (k.clone(), to_json(v))).collect::<BTreeMap<_, _>>().into_iter().collect()),
        AttributeValue::Ss(v) => J::Array(v.iter().cloned().map(J::String).collect()),
        AttributeValue::Ns(v) => J::Array(v.iter().map(|n| number_json(n)).collect()),
        AttributeValue::Bs(v) => J::Array(v.iter().map(|b| J::String(format!("\\x{}", hex_encode(b.as_ref())))).collect()),
        _ => J::Null,
    }
}

pub fn to_value(av: &AttributeValue) -> Value {
    match av {
        AttributeValue::S(s) => Value::Text(s.clone()),
        AttributeValue::N(n) => number_value(n),
        AttributeValue::Bool(b) => Value::Bool(*b),
        AttributeValue::Null(_) => Value::Null,
        AttributeValue::B(b) => Value::from_bytes(b.as_ref()),
        AttributeValue::L(_) | AttributeValue::M(_) => Value::Json(to_json(av)),
        AttributeValue::Ss(v) => Value::Array(v.iter().cloned().map(Value::Text).collect()),
        AttributeValue::Ns(v) => Value::Array(v.iter().map(|n| number_value(n)).collect()),
        AttributeValue::Bs(v) => Value::Array(v.iter().map(|b| Value::from_bytes(b.as_ref())).collect()),
        other => Value::Other { type_name: "unknown".into(), text: format!("{other:?}") },
    }
}

fn checked_number(s: &str) -> DbResult<AttributeValue> {
    let t = s.trim();
    let ok = !t.is_empty() && t.chars().any(|c| c.is_ascii_digit()) && t.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | '+' | '.' | 'e' | 'E'));
    if !ok {
        return Err(DbError::invalid(format!("'{t}' is not a number")));
    }
    Ok(AttributeValue::N(t.to_string()))
}

fn from_json(j: &serde_json::Value) -> AttributeValue {
    use serde_json::Value as J;
    match j {
        J::Null => AttributeValue::Null(true),
        J::Bool(b) => AttributeValue::Bool(*b),
        J::Number(n) => AttributeValue::N(n.to_string()),
        J::String(s) => AttributeValue::S(s.clone()),
        J::Array(a) => AttributeValue::L(a.iter().map(from_json).collect()),
        J::Object(o) => AttributeValue::M(o.iter().map(|(k, v)| (k.clone(), from_json(v))).collect()),
    }
}

fn bytes_of(v: &Value) -> DbResult<Blob> {
    match v {
        Value::Bytes { truncated: true, .. } => Err(DbError::invalid("binary value was truncated for display and cannot be written back")),
        Value::Bytes { hex, .. } => hex_decode(hex).map(Blob::new).ok_or_else(|| DbError::invalid("invalid hex")),
        _ => Err(DbError::invalid("expected binary")),
    }
}

/// Grid value -> attribute value. Strings -> `S`, Int/Decimal -> `N` (exact text),
/// JSON objects/arrays -> `M`/`L`, arrays -> string/number/binary sets.
pub fn from_value(v: &Value) -> DbResult<AttributeValue> {
    Ok(match v {
        Value::Null => AttributeValue::Null(true),
        Value::Bool(b) => AttributeValue::Bool(*b),
        Value::Int(i) => AttributeValue::N(i.to_string()),
        Value::BigInt(s) | Value::Decimal(s) => checked_number(s)?,
        Value::Float(f) if f.is_finite() => AttributeValue::N(f.to_string()),
        Value::Float(_) => return Err(DbError::invalid("DynamoDB numbers cannot be NaN or infinite")),
        Value::Text(s) | Value::Uuid(s) | Value::Date(s) | Value::Time(s) => AttributeValue::S(s.clone()),
        Value::Timestamp { iso, .. } => AttributeValue::S(iso.clone()),
        Value::Bytes { .. } => AttributeValue::B(bytes_of(v)?),
        Value::Json(j) => from_json(j),
        Value::Other { type_name, text } if type_name == "N" => checked_number(text)?,
        Value::Other { text, .. } => AttributeValue::S(text.clone()),
        Value::Array(items) => {
            if items.is_empty() {
                return Err(DbError::invalid("DynamoDB sets cannot be empty"));
            }
            let numeric = |x: &Value| {
                matches!(x, Value::Int(_) | Value::BigInt(_) | Value::Decimal(_) | Value::Float(_))
                    || matches!(x, Value::Other { type_name, .. } if type_name == "N")
            };
            if items.iter().all(|x| matches!(x, Value::Text(_))) {
                AttributeValue::Ss(items.iter().filter_map(|x| x.to_plain()).collect())
            } else if items.iter().all(numeric) {
                let ns = items.iter().map(from_value).collect::<DbResult<Vec<_>>>()?;
                AttributeValue::Ns(ns.into_iter().filter_map(|a| if let AttributeValue::N(n) = a { Some(n) } else { None }).collect())
            } else if items.iter().all(|x| matches!(x, Value::Bytes { .. })) {
                AttributeValue::Bs(items.iter().map(bytes_of).collect::<DbResult<Vec<_>>>()?)
            } else {
                return Err(DbError::invalid("a set must contain only strings, only numbers or only binary values"));
            }
        }
    })
}

/// Items -> result set. Column order: `first` (key attributes, then previously seen
/// names), then any new attribute names sorted. Type name = the DynamoDB type tag when
/// every present value agrees, else `mixed`; decimals in mixed columns travel as
/// `Other { type_name: "N" }` so the client keeps them numeric and exact.
fn items_to_result(items: &[Item], first: &[String], table: Option<&str>, key_names: &[String]) -> ResultSet {
    let mut names: Vec<String> = Vec::new();
    for n in first {
        if !names.contains(n) {
            names.push(n.clone());
        }
    }
    let extra: BTreeSet<&String> = items.iter().flat_map(|i| i.keys()).filter(|k| !names.contains(k)).collect();
    names.extend(extra.into_iter().cloned());
    let columns: Vec<ColumnMeta> = names
        .iter()
        .map(|n| {
            let tags: BTreeSet<&str> = items.iter().filter_map(|i| i.get(n)).map(type_tag).filter(|t| *t != "NULL").collect();
            let type_name = match tags.len() {
                0 if items.iter().any(|i| i.contains_key(n)) => "NULL".to_string(),
                0 => "S".to_string(),
                1 => tags.into_iter().next().unwrap_or("S").to_string(),
                _ => "mixed".to_string(),
            };
            ColumnMeta { name: n.clone(), type_name, nullable: Some(!key_names.contains(n)), table: table.map(String::from) }
        })
        .collect();
    let rows = items
        .iter()
        .map(|item| {
            names
                .iter()
                .zip(&columns)
                .map(|(n, c)| match item.get(n).map(to_value) {
                    Some(Value::Decimal(d)) if c.type_name == "mixed" => Value::Other { type_name: "N".into(), text: d },
                    Some(v) => v,
                    None => Value::Null,
                })
                .collect()
        })
        .collect();
    ResultSet { columns, rows, truncated: false }
}

// ---------------------------------------------------------------- expressions

/// Placeholder-based expression builder: attribute names go through
/// `ExpressionAttributeNames`, values through `ExpressionAttributeValues`; nothing
/// user-supplied is ever spliced into the expression text.
#[derive(Default, Clone)]
struct Expr {
    names: HashMap<String, String>,
    values: HashMap<String, AttributeValue>,
}

impl Expr {
    fn name(&mut self, n: &str) -> String {
        if let Some((k, _)) = self.names.iter().find(|(_, v)| v.as_str() == n) {
            return k.clone();
        }
        let k = format!("#n{}", self.names.len());
        self.names.insert(k.clone(), n.to_string());
        k
    }
    fn value(&mut self, v: AttributeValue) -> String {
        let k = format!(":v{}", self.values.len());
        self.values.insert(k.clone(), v);
        k
    }
    fn names_opt(&self) -> Option<HashMap<String, String>> {
        (!self.names.is_empty()).then(|| self.names.clone())
    }
    fn values_opt(&self) -> Option<HashMap<String, AttributeValue>> {
        (!self.values.is_empty()).then(|| self.values.clone())
    }
    /// `#a = :v`, or "missing or NULL" for a NULL original.
    fn equals(&mut self, col: &str, v: &Value) -> DbResult<String> {
        let n = self.name(col);
        if v.is_null() {
            let t = self.value(AttributeValue::S("NULL".into()));
            return Ok(format!("(attribute_not_exists({n}) OR attribute_type({n}, {t}))"));
        }
        let p = self.value(from_value(v)?);
        Ok(format!("{n} = {p}"))
    }
}

/// Grid filters -> `FilterExpression`.
fn filter_expression(filters: &[FilterCondition], e: &mut Expr) -> DbResult<Option<String>> {
    let mut parts = Vec::new();
    for f in filters {
        if !f.any_columns.is_empty() {
            return Err(DbError::unsupported("\"any column\" filters on DynamoDB"));
        }
        let need = || f.value.as_ref().ok_or_else(|| DbError::invalid("filter value required"));
        let part = match f.op {
            FilterOp::IsNull => {
                let n = e.name(&f.column);
                let t = e.value(AttributeValue::S("NULL".into()));
                format!("(attribute_not_exists({n}) OR attribute_type({n}, {t}))")
            }
            FilterOp::IsNotNull => {
                let n = e.name(&f.column);
                let t = e.value(AttributeValue::S("NULL".into()));
                format!("(attribute_exists({n}) AND NOT attribute_type({n}, {t}))")
            }
            FilterOp::StartsWith => {
                let v = from_value(need()?)?;
                let n = e.name(&f.column);
                format!("begins_with({n}, {})", e.value(v))
            }
            FilterOp::Contains | FilterOp::NotContains => {
                let v = from_value(need()?)?;
                let n = e.name(&f.column);
                let not = if f.op == FilterOp::NotContains { "NOT " } else { "" };
                format!("{not}contains({n}, {})", e.value(v))
            }
            FilterOp::Like | FilterOp::NotLike => return Err(DbError::unsupported("LIKE filters on DynamoDB (use contains or begins with)")),
            FilterOp::Raw => return Err(DbError::unsupported("raw SQL filters on DynamoDB")),
            FilterOp::Between => {
                let [lo, hi] = f.values.as_slice() else {
                    return Err(DbError::invalid("BETWEEN needs exactly two values"));
                };
                let n = e.name(&f.column);
                let a = e.value(from_value(lo)?);
                let b = e.value(from_value(hi)?);
                format!("{n} BETWEEN {a} AND {b}")
            }
            FilterOp::EndsWith => return Err(DbError::unsupported("'ends with' filters on DynamoDB (use contains or begins with)")),
            FilterOp::In | FilterOp::NotIn => {
                if f.values.is_empty() || f.values.len() > 100 {
                    return Err(DbError::invalid("IN filter needs 1-100 values on DynamoDB"));
                }
                let n = e.name(&f.column);
                let ps = f.values.iter().map(|v| Ok(e.value(from_value(v)?))).collect::<DbResult<Vec<_>>>()?;
                if f.op == FilterOp::NotIn {
                    format!("NOT ({n} IN ({}))", ps.join(", "))
                } else {
                    format!("{n} IN ({})", ps.join(", "))
                }
            }
            op @ (FilterOp::Eq | FilterOp::Ne | FilterOp::Lt | FilterOp::Le | FilterOp::Gt | FilterOp::Ge) => {
                let v = from_value(need()?)?;
                let n = e.name(&f.column);
                let p = e.value(v);
                let sym = match op {
                    FilterOp::Eq => "=",
                    FilterOp::Ne => "<>",
                    FilterOp::Lt => "<",
                    FilterOp::Le => "<=",
                    FilterOp::Gt => ">",
                    _ => ">=",
                };
                format!("{n} {sym} {p}")
            }
        };
        parts.push(part);
    }
    Ok((!parts.is_empty()).then(|| parts.join(" AND ")))
}

// ---------------------------------------------------------------- connect

#[async_trait]
impl DatabaseDriver for DynamoDriver {
    fn engines(&self) -> &'static [Engine] {
        &[Engine::DynamoDb]
    }

    async fn connect(&self, cfg: &ConnectionConfig, secrets: ConnectSecrets) -> DbResult<Box<dyn DatabaseConnection>> {
        cfg.validate()?;
        let region = cfg.database.clone().filter(|r| !r.trim().is_empty()).unwrap_or_else(|| "us-east-1".into());
        let endpoint = cfg.host.as_deref().map(str::trim).filter(|h| !h.is_empty()).map(|h| h.trim_end_matches('/').to_string());
        let connect_timeout = Duration::from_secs(cfg.connect_timeout_secs as u64);
        let mut loader = aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new(region.clone()))
            .timeout_config(TimeoutConfig::builder().connect_timeout(connect_timeout).build());
        match cfg.username.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
            Some(u) if u.starts_with("profile:") => {
                let name = u["profile:".len()..].trim();
                if name.is_empty() {
                    return Err(DbError::invalid("profile name is empty (use profile:NAME)"));
                }
                loader = loader.profile_name(name);
            }
            Some(key_id) => {
                let secret = secrets.password.clone().filter(|s| !s.is_empty()).ok_or_else(|| {
                    DbError::new(ErrorKind::Authentication, "a secret access key is required when an access key ID is set")
                        .with_hint("Enter the secret access key, or clear the access key ID to use the default AWS credential chain.")
                })?;
                loader = loader.credentials_provider(Credentials::new(key_id, secret, None, None, "dbstudio"));
            }
            None => {} // default chain: env, shared config/credentials, SSO, web identity, IMDS
        }
        if let Some(ep) = &endpoint {
            loader = loader.endpoint_url(ep);
        }
        drop(secrets);
        let client = Client::new(&loader.load().await);
        // Verify endpoint + credentials (bounded: the default chain may probe IMDS).
        tokio::time::timeout(connect_timeout * 2, client.list_tables().limit(1).send())
            .await
            .map_err(|_| DbError::new(ErrorKind::Timeout, "connection timed out"))?
            .map_err(map_sdk)?;
        Ok(Box::new(DynamoConnection {
            client,
            region,
            endpoint,
            read_only: cfg.read_only,
            keys: Mutex::new(HashMap::new()),
            cursors: Mutex::new(HashMap::new()),
            seen_columns: Mutex::new(HashMap::new()),
        }))
    }
}

// ---------------------------------------------------------------- connection helpers

impl DynamoConnection {
    async fn key_schema(&self, table: &str) -> DbResult<Vec<(String, String)>> {
        if let Some(k) = self.keys.lock().unwrap().get(table) {
            return Ok(k.clone());
        }
        let out = self.client.describe_table().table_name(table).send().await.map_err(map_sdk)?;
        let td = out.table().ok_or_else(|| DbError::new(ErrorKind::NotFound, "table not found"))?;
        let keys = Self::keys_of(td);
        self.keys.lock().unwrap().insert(table.to_string(), keys.clone());
        Ok(keys)
    }

    fn keys_of(td: &aws_sdk_dynamodb::types::TableDescription) -> Vec<(String, String)> {
        let ty = |n: &str| {
            td.attribute_definitions().iter().find(|a| a.attribute_name() == n).map(|a| a.attribute_type().as_str().to_string()).unwrap_or_else(|| "S".into())
        };
        let mut ks: Vec<_> = td.key_schema().to_vec();
        ks.sort_by_key(|k| k.key_type() != &KeyType::Hash);
        ks.iter().map(|k| (k.attribute_name().to_string(), ty(k.attribute_name()))).collect()
    }

    fn cursor_key(table: &str, filters: &[FilterCondition]) -> String {
        format!("{table}\u{0}{}", serde_json::to_string(filters).unwrap_or_default())
    }

    fn cursor_before(&self, ck: &str, offset: u64) -> (u64, Option<Item>) {
        let c = self.cursors.lock().unwrap();
        c.get(ck).and_then(|m| m.range(..=offset).next_back()).map(|(p, k)| (*p, Some(k.clone()))).unwrap_or((0, None))
    }

    fn remember(&self, ck: &str, pos: u64, key: Item) {
        let mut c = self.cursors.lock().unwrap();
        if !c.contains_key(ck) && c.len() >= MAX_CURSOR_KEYS {
            c.clear();
        }
        let m = c.entry(ck.to_string()).or_default();
        if m.len() >= MAX_CURSORS_PER_KEY {
            m.clear();
        }
        m.insert(pos, key);
    }

    fn forget_table(&self, table: Option<&str>) {
        let mut c = self.cursors.lock().unwrap();
        match table {
            Some(t) => {
                let prefix = format!("{t}\u{0}");
                c.retain(|k, _| !k.starts_with(&prefix));
            }
            None => c.clear(),
        }
    }

    fn key_map(change_key: &[(String, Value)], schema: &[(String, String)]) -> DbResult<Item> {
        let mut out = HashMap::new();
        for (name, _) in schema {
            let v = change_key.iter().find(|(c, _)| c == name).map(|(_, v)| v).ok_or_else(|| DbError::invalid(format!("missing key attribute {name}")))?;
            if v.is_null() {
                return Err(DbError::invalid(format!("key attribute {name} is empty")));
            }
            out.insert(name.clone(), from_value(v)?);
        }
        Ok(out)
    }

    /// Condition: the item still exists and every originally loaded (non-key) value is unchanged.
    fn guard_condition(e: &mut Expr, schema: &[(String, String)], original: &[(String, Value)]) -> DbResult<String> {
        let hash = e.name(&schema[0].0);
        let mut conds = vec![format!("attribute_exists({hash})")];
        for (c, v) in original.iter().filter(|(c, _)| !schema.iter().any(|(k, _)| k == c)) {
            conds.push(e.equals(c, v)?);
        }
        Ok(conds.join(" AND "))
    }

    fn transact_item(table: &str, schema: &[(String, String)], change: &RowChange) -> DbResult<TransactWriteItem> {
        let mut e = Expr::default();
        Ok(match change {
            RowChange::Insert { values } => {
                let mut item = HashMap::new();
                for (c, v) in values.iter().filter(|(_, v)| !v.is_null()) {
                    item.insert(c.clone(), from_value(v)?);
                }
                for (k, _) in schema {
                    if !item.contains_key(k) {
                        return Err(DbError::invalid(format!("key attribute {k} is required for a new item")));
                    }
                }
                let cond = format!("attribute_not_exists({})", e.name(&schema[0].0));
                let put = Put::builder()
                    .table_name(table)
                    .set_item(Some(item))
                    .condition_expression(cond)
                    .set_expression_attribute_names(e.names_opt())
                    .build()
                    .map_err(build_err)?;
                TransactWriteItem::builder().put(put).build()
            }
            RowChange::Update { key, original, changes } => {
                if changes.is_empty() {
                    return Err(DbError::invalid("no changes"));
                }
                let key_item = Self::key_map(key, schema)?;
                let mut sets = Vec::new();
                let mut removes = Vec::new();
                for (c, v) in changes {
                    if schema.iter().any(|(k, _)| k == c) {
                        return Err(DbError::invalid(format!("key attribute {c} cannot be changed; delete the item and insert a new one")));
                    }
                    let n = e.name(c);
                    if v.is_null() {
                        removes.push(n);
                    } else {
                        let p = e.value(from_value(v)?);
                        sets.push(format!("{n} = {p}"));
                    }
                }
                let mut update = String::new();
                if !sets.is_empty() {
                    update.push_str(&format!("SET {}", sets.join(", ")));
                }
                if !removes.is_empty() {
                    update.push_str(&format!("{}REMOVE {}", if update.is_empty() { "" } else { " " }, removes.join(", ")));
                }
                let cond = Self::guard_condition(&mut e, schema, original)?;
                let upd = Update::builder()
                    .table_name(table)
                    .set_key(Some(key_item))
                    .update_expression(update)
                    .condition_expression(cond)
                    .set_expression_attribute_names(e.names_opt())
                    .set_expression_attribute_values(e.values_opt())
                    .build()
                    .map_err(build_err)?;
                TransactWriteItem::builder().update(upd).build()
            }
            RowChange::Delete { key, original } => {
                let key_item = Self::key_map(key, schema)?;
                let cond = Self::guard_condition(&mut e, schema, original)?;
                let del = Delete::builder()
                    .table_name(table)
                    .set_key(Some(key_item))
                    .condition_expression(cond)
                    .set_expression_attribute_names(e.names_opt())
                    .set_expression_attribute_values(e.values_opt())
                    .build()
                    .map_err(build_err)?;
                TransactWriteItem::builder().delete(del).build()
            }
        })
    }

    async fn run_statement(&self, text: &str, max_rows: usize) -> DbResult<(Vec<Item>, bool)> {
        let mut items = Vec::new();
        let mut next: Option<String> = None;
        loop {
            let out = self.client.execute_statement().statement(text).set_next_token(next.take()).send().await.map_err(map_sdk)?;
            for it in out.items() {
                if items.len() >= max_rows {
                    return Ok((items, true));
                }
                items.push(it.clone());
            }
            match out.next_token() {
                Some(t) if items.len() < max_rows => next = Some(t.to_string()),
                Some(_) => return Ok((items, true)),
                None => return Ok((items, false)),
            }
        }
    }
}

fn lit(v: &Value) -> String {
    Dialect::Generic.literal(v)
}

fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

fn describe_pairs(pairs: &[(String, Value)]) -> String {
    pairs.iter().map(|(c, v)| format!("{}: {}", quoted(c), lit(v))).collect::<Vec<_>>().join(", ")
}

// ---------------------------------------------------------------- trait impl

#[async_trait]
impl DatabaseConnection for DynamoConnection {
    fn engine(&self) -> Engine {
        Engine::DynamoDb
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            sql: true, // PartiQL
            transactions: false,
            schemas: false,
            multiple_databases: false,
            explain: false,
            explain_analyze: false,
            cancel: true,
            inline_edit: true,
            ddl_editing: false,
            read_only_session: false,
            sessions_monitor: false,
            kill_session: false,
            native_backup: false,
            object_kinds: vec![ObjectKind::Table],
        }
    }

    async fn server_info(&self) -> DbResult<ServerInfo> {
        let version = match &self.endpoint {
            Some(ep) => format!("DynamoDB {} via {ep}", self.region),
            None => format!("DynamoDB {}", self.region),
        };
        Ok(ServerInfo { engine: Engine::DynamoDb, version, current_database: Some(self.region.clone()), current_user: None, tls_version: None })
    }

    async fn ping(&self) -> DbResult<()> {
        self.client.list_tables().limit(1).send().await.map_err(map_sdk)?;
        Ok(())
    }

    async fn close(&self) -> DbResult<()> {
        Ok(())
    }

    async fn list_databases(&self) -> DbResult<Vec<String>> {
        Ok(vec![])
    }

    async fn list_schemas(&self, _db: Option<&str>) -> DbResult<Vec<String>> {
        Ok(vec![])
    }

    async fn list_objects(&self, _schema: Option<&str>) -> DbResult<Vec<ObjectRef>> {
        let mut out = Vec::new();
        let mut start: Option<String> = None;
        loop {
            let r = self.client.list_tables().set_exclusive_start_table_name(start.take()).send().await.map_err(map_sdk)?;
            out.extend(r.table_names().iter().map(|n| ObjectRef { kind: ObjectKind::Table, database: None, schema: None, name: n.clone() }));
            match r.last_evaluated_table_name() {
                Some(n) if out.len() < 10_000 => start = Some(n.to_string()),
                _ => break,
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    async fn describe_table(&self, target: &TableTarget) -> DbResult<TableDescription> {
        let out = self.client.describe_table().table_name(&target.table).send().await.map_err(map_sdk)?;
        let td = out.table().ok_or_else(|| DbError::new(ErrorKind::NotFound, "table not found"))?;
        let keys = Self::keys_of(td);
        self.keys.lock().unwrap().insert(target.table.clone(), keys.clone());
        let key_names: Vec<String> = keys.iter().map(|(n, _)| n.clone()).collect();

        // Columns: key attributes, other declared (index) attributes, then attributes seen in a small sample.
        let mut columns: Vec<ColumnDef> = Vec::new();
        let push = |name: &str, ty: String, pk: bool, comment: Option<String>, columns: &mut Vec<ColumnDef>| {
            if !columns.iter().any(|c| c.name == name) {
                let ordinal = columns.len() as u32 + 1;
                columns.push(ColumnDef {
                    name: name.into(),
                    data_type: ty,
                    nullable: !pk,
                    default: None,
                    is_primary_key: pk,
                    is_identity: false,
                    comment,
                    ordinal,
                });
            }
        };
        for (i, (n, t)) in keys.iter().enumerate() {
            push(n, t.clone(), true, Some(if i == 0 { "partition key (HASH)" } else { "sort key (RANGE)" }.into()), &mut columns);
        }
        for a in td.attribute_definitions() {
            push(a.attribute_name(), a.attribute_type().as_str().to_string(), false, Some("index key".into()), &mut columns);
        }
        if let Ok(sample) = self.client.scan().table_name(&target.table).limit(50).send().await {
            let rs = items_to_result(sample.items(), &key_names, None, &key_names);
            for c in rs.columns {
                push(&c.name, c.type_name, false, None, &mut columns);
            }
        }

        let names = |ks: &[aws_sdk_dynamodb::types::KeySchemaElement]| {
            let mut v: Vec<_> = ks.to_vec();
            v.sort_by_key(|k| k.key_type() != &KeyType::Hash);
            v.iter().map(|k| k.attribute_name().to_string()).collect::<Vec<_>>()
        };
        let mut indexes =
            vec![IndexDef { name: "PRIMARY".into(), columns: key_names.clone(), unique: true, primary: true, definition: Some("table key".into()) }];
        for g in td.global_secondary_indexes() {
            let proj = g.projection().and_then(|p| p.projection_type()).map(|p| p.as_str().to_string()).unwrap_or_default();
            let status = g.index_status().map(|s| s.as_str().to_string()).unwrap_or_default();
            indexes.push(IndexDef {
                name: g.index_name().unwrap_or_default().into(),
                columns: names(g.key_schema()),
                unique: false,
                primary: false,
                definition: Some(format!("GLOBAL SECONDARY INDEX, projection {proj}, {status}")),
            });
        }
        for l in td.local_secondary_indexes() {
            let proj = l.projection().and_then(|p| p.projection_type()).map(|p| p.as_str().to_string()).unwrap_or_default();
            indexes.push(IndexDef {
                name: l.index_name().unwrap_or_default().into(),
                columns: names(l.key_schema()),
                unique: false,
                primary: false,
                definition: Some(format!("LOCAL SECONDARY INDEX, projection {proj}")),
            });
        }
        let item_count = td.item_count();
        let ddl = serde_json::json!({
            "TableName": target.table,
            "KeySchema": td.key_schema().iter().map(|k| serde_json::json!({"AttributeName": k.attribute_name(), "KeyType": k.key_type().as_str()})).collect::<Vec<_>>(),
            "AttributeDefinitions": td.attribute_definitions().iter().map(|a| serde_json::json!({"AttributeName": a.attribute_name(), "AttributeType": a.attribute_type().as_str()})).collect::<Vec<_>>(),
            "GlobalSecondaryIndexes": td.global_secondary_indexes().iter().map(|g| serde_json::json!({"IndexName": g.index_name(), "KeySchema": names(g.key_schema())})).collect::<Vec<_>>(),
            "LocalSecondaryIndexes": td.local_secondary_indexes().iter().map(|l| serde_json::json!({"IndexName": l.index_name(), "KeySchema": names(l.key_schema())})).collect::<Vec<_>>(),
            "BillingMode": td.billing_mode_summary().and_then(|b| b.billing_mode()).map(|b| b.as_str()).unwrap_or("PROVISIONED"),
            "TableStatus": td.table_status().map(|s| s.as_str()),
        });
        Ok(TableDescription {
            object: ObjectRef { kind: ObjectKind::Table, database: None, schema: None, name: target.table.clone() },
            columns,
            primary_key: key_names,
            indexes,
            foreign_keys: vec![],
            constraints: vec![],
            ddl: serde_json::to_string_pretty(&ddl).ok(),
            estimated_rows: item_count,
            comment: Some(format!(
                "~{} items, {} bytes (DynamoDB updates these estimates about every 6 hours). Columns beyond the keys are sampled; items are schemaless.",
                item_count.unwrap_or(0),
                td.table_size_bytes().unwrap_or(0)
            )),
        })
    }

    async fn object_ddl(&self, object: &ObjectRef) -> DbResult<String> {
        self.describe_table(&TableTarget { schema: None, table: object.name.clone() }).await?.ddl.ok_or_else(|| DbError::unsupported("DDL"))
    }

    async fn execute(&self, script: &str, opts: &ExecOptions, cancel: CancellationToken) -> DbResult<Vec<StatementResult>> {
        let fut = async {
            let mut out = Vec::new();
            let mut wrote = false;
            for (idx, st) in dbs_safety::split_statements(script, Dialect::Generic).into_iter().enumerate() {
                let text = st.text.trim().trim_end_matches(';').trim().to_string();
                if text.is_empty() {
                    continue;
                }
                let class = dbs_safety::classify_statement(idx, &st, Dialect::Generic);
                if self.read_only && class.risk > Risk::Read {
                    return Err(DbError::new(ErrorKind::PolicyBlocked, format!("{} is not allowed on a read-only connection", class.verb)));
                }
                let t = Instant::now();
                let is_write = matches!(class.verb.as_str(), "INSERT" | "UPDATE" | "DELETE" | "UPSERT" | "REPLACE");
                wrote |= class.risk > Risk::Read;
                let (items, truncated) = self.run_statement(&text, opts.max_rows).await?;
                let (result, rows_affected) = if is_write && items.is_empty() {
                    (None, Some(1))
                } else {
                    let mut rs = items_to_result(&items, &[], None, &[]);
                    rs.truncated = truncated;
                    (Some(rs), None)
                };
                out.push(StatementResult {
                    statement_index: idx,
                    sql_excerpt: excerpt(&text),
                    result,
                    rows_affected,
                    duration_ms: elapsed_ms(t),
                    notices: vec![],
                });
            }
            if wrote {
                self.forget_table(None);
            }
            Ok(out)
        };
        guarded_abort(fut, cancel, opts.timeout_ms).await
    }

    async fn execute_params(&self, _s: &GeneratedStatement) -> DbResult<u64> {
        Err(DbError::unsupported("parameterised SQL"))
    }

    /// Scan page. Sorting is not available on a Scan (`order_by` is ignored; the UI
    /// disables it). Offset paging uses the cached continuation keys.
    async fn fetch_table(&self, target: &TableTarget, page: &PageRequest) -> DbResult<ResultSet> {
        let keys = self.key_schema(&target.table).await?;
        let key_names: Vec<String> = keys.iter().map(|(n, _)| n.clone()).collect();
        let limit = page.limit.clamp(1, MAX_PAGE_SIZE);
        let want_end = page.offset + limit;
        let mut expr = Expr::default();
        let filter = filter_expression(&page.filters, &mut expr)?;
        let ck = Self::cursor_key(&target.table, &page.filters);
        let (mut pos, mut start) = self.cursor_before(&ck, page.offset);
        let mut items: Vec<Item> = Vec::new();
        for _ in 0..1000 {
            let need = want_end - pos;
            let scan_limit = if filter.is_some() { need.clamp(100, 1000) } else { need.min(10_000) };
            let out = self
                .client
                .scan()
                .table_name(&target.table)
                .limit(scan_limit as i32)
                .set_exclusive_start_key(start.take())
                .set_filter_expression(filter.clone())
                .set_expression_attribute_names(expr.names_opt())
                .set_expression_attribute_values(expr.values_opt())
                .send()
                .await
                .map_err(map_sdk)?;
            let got = out.items();
            let mut consumed = 0;
            for it in got {
                if pos >= want_end {
                    break;
                }
                if pos >= page.offset {
                    items.push(it.clone());
                }
                pos += 1;
                consumed += 1;
            }
            if consumed < got.len() {
                // Stopped inside this response: resume after the last consumed item.
                let last = &got[consumed - 1];
                self.remember(&ck, pos, key_names.iter().filter_map(|k| last.get(k).map(|v| (k.clone(), v.clone()))).collect());
                break;
            }
            match out.last_evaluated_key() {
                Some(k) => {
                    self.remember(&ck, pos, k.clone());
                    if pos >= want_end {
                        break;
                    }
                    start = Some(k.clone());
                }
                None => break,
            }
        }
        let first = {
            let mut seen = self.seen_columns.lock().unwrap();
            let e = seen.entry(target.table.clone()).or_default();
            if page.offset == 0 {
                e.clear();
            }
            let mut first = key_names.clone();
            first.extend(e.iter().filter(|c| !key_names.contains(c)).cloned());
            first
        };
        let rs = items_to_result(&items, &first, Some(&target.table), &key_names);
        if let Some(e) = self.seen_columns.lock().unwrap().get_mut(&target.table) {
            for c in &rs.columns {
                if !e.contains(&c.name) {
                    e.push(c.name.clone());
                }
            }
        }
        Ok(rs)
    }

    /// Exact count via `Scan` with `Select=COUNT`, bounded in time and pages. Larger
    /// tables return an error so the UI falls back to the (estimated) item count.
    async fn count_rows(&self, target: &TableTarget, filters: &[FilterCondition]) -> DbResult<u64> {
        let mut expr = Expr::default();
        let filter = filter_expression(filters, &mut expr)?;
        let t = Instant::now();
        let mut total: u64 = 0;
        let mut start: Option<Item> = None;
        for _ in 0..200 {
            let out = self
                .client
                .scan()
                .table_name(&target.table)
                .select(Select::Count)
                .set_exclusive_start_key(start.take())
                .set_filter_expression(filter.clone())
                .set_expression_attribute_names(expr.names_opt())
                .set_expression_attribute_values(expr.values_opt())
                .send()
                .await
                .map_err(map_sdk)?;
            total += out.count().max(0) as u64;
            match out.last_evaluated_key() {
                None => return Ok(total),
                Some(k) => start = Some(k.clone()),
            }
            if t.elapsed() > Duration::from_secs(15) {
                break;
            }
        }
        Err(DbError::new(ErrorKind::Unsupported, format!("table too large to count exactly (counted {total}+ items)"))
            .with_hint("Showing DynamoDB's estimated item count instead."))
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

    fn preview_changes(&self, target: &TableTarget, changes: &[RowChange]) -> DbResult<Vec<String>> {
        let t = quoted(&target.table);
        Ok(changes
            .iter()
            .map(|c| match c {
                RowChange::Insert { values } => {
                    let vals: Vec<_> = values.iter().filter(|(_, v)| !v.is_null()).cloned().collect();
                    format!("PutItem {t} {{{}}} IF item does not exist", describe_pairs(&vals))
                }
                RowChange::Update { key, original, changes } => {
                    let sets: Vec<_> = changes.iter().filter(|(_, v)| !v.is_null()).cloned().collect();
                    let removes: Vec<_> = changes.iter().filter(|(_, v)| v.is_null()).map(|(c, _)| quoted(c)).collect();
                    let mut s = format!("UpdateItem {t} KEY {{{}}}", describe_pairs(key));
                    if !sets.is_empty() {
                        s.push_str(&format!(" SET {}", sets.iter().map(|(c, v)| format!("{} = {}", quoted(c), lit(v))).collect::<Vec<_>>().join(", ")));
                    }
                    if !removes.is_empty() {
                        s.push_str(&format!(" REMOVE {}", removes.join(", ")));
                    }
                    let guard: Vec<_> =
                        original.iter().filter(|(c, _)| !key.iter().any(|(k, _)| k == c)).map(|(c, v)| format!("{} = {}", quoted(c), lit(v))).collect();
                    s.push_str(" IF item exists");
                    if !guard.is_empty() {
                        s.push_str(&format!(" AND {}", guard.join(" AND ")));
                    }
                    s
                }
                RowChange::Delete { key, original } => {
                    let guard: Vec<_> =
                        original.iter().filter(|(c, _)| !key.iter().any(|(k, _)| k == c)).map(|(c, v)| format!("{} = {}", quoted(c), lit(v))).collect();
                    let mut s = format!("DeleteItem {t} KEY {{{}}} IF item exists", describe_pairs(key));
                    if !guard.is_empty() {
                        s.push_str(&format!(" AND {}", guard.join(" AND ")));
                    }
                    s
                }
            })
            .collect())
    }

    /// All staged changes in one `TransactWriteItems` (all-or-nothing, max 100 items).
    /// A failed condition on any item cancels the transaction and is reported as a conflict.
    async fn apply_changes(&self, target: &TableTarget, changes: &[RowChange]) -> DbResult<ApplyReport> {
        if self.read_only {
            return Err(DbError::new(ErrorKind::PolicyBlocked, "connection is read-only"));
        }
        if changes.is_empty() {
            return Ok(ApplyReport { committed: true, ..Default::default() });
        }
        if changes.len() > MAX_TRANSACTION_ITEMS {
            return Err(DbError::invalid(format!(
                "DynamoDB transactions are limited to {MAX_TRANSACTION_ITEMS} items; commit at most {MAX_TRANSACTION_ITEMS} changes at a time"
            )));
        }
        let schema = self.key_schema(&target.table).await?;
        if schema.is_empty() {
            return Err(DbError::internal("table has no key schema"));
        }
        let items = changes.iter().map(|c| Self::transact_item(&target.table, &schema, c)).collect::<DbResult<Vec<_>>>()?;
        let res = self.client.transact_write_items().set_transact_items(Some(items)).send().await;
        self.forget_table(Some(&target.table));
        match res {
            Ok(_) => Ok(ApplyReport { applied: changes.len(), rows_affected: changes.len() as u64, conflicts: vec![], committed: true }),
            Err(e) => {
                if let Some(TransactWriteItemsError::TransactionCanceledException(tce)) = e.as_service_error() {
                    let conflicts: Vec<usize> =
                        tce.cancellation_reasons().iter().enumerate().filter(|(_, r)| r.code() == Some("ConditionalCheckFailed")).map(|(i, _)| i).collect();
                    if !conflicts.is_empty() {
                        return Ok(ApplyReport { applied: 0, rows_affected: 0, conflicts, committed: false });
                    }
                }
                Err(map_sdk(e))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_stay_exact() {
        assert_eq!(number_value("42"), Value::Int(42));
        assert_eq!(number_value("-7"), Value::Int(-7));
        assert_eq!(number_value("9007199254740993"), Value::Decimal("9007199254740993".into()));
        assert_eq!(number_value("12345678901234567890.123456789"), Value::Decimal("12345678901234567890.123456789".into()));
        assert_eq!(number_value("1.5"), Value::Decimal("1.5".into()));
        assert_eq!(number_json("0.10"), serde_json::json!("0.10"));
        assert_eq!(number_json("1.5"), serde_json::json!(1.5));
        assert_eq!(number_json("12345678901234567890.123456789"), serde_json::json!("12345678901234567890.123456789"));
        match from_value(&Value::Decimal("12345678901234567890.123456789".into())).unwrap() {
            AttributeValue::N(n) => assert_eq!(n, "12345678901234567890.123456789"),
            other => panic!("{other:?}"),
        }
        assert!(from_value(&Value::Decimal("1; DROP".into())).is_err());
    }

    #[test]
    fn value_roundtrip() {
        let m = AttributeValue::M(HashMap::from([
            ("a".to_string(), AttributeValue::N("1".into())),
            ("b".to_string(), AttributeValue::L(vec![AttributeValue::S("x".into())])),
        ]));
        assert_eq!(to_value(&m), Value::Json(serde_json::json!({"a": 1, "b": ["x"]})));
        assert_eq!(from_value(&to_value(&m)).unwrap(), m);
        let ss = AttributeValue::Ss(vec!["a".into(), "b".into()]);
        assert_eq!(from_value(&to_value(&ss)).unwrap(), ss);
        let ns = AttributeValue::Ns(vec!["1".into(), "2.5".into()]);
        assert_eq!(from_value(&to_value(&ns)).unwrap(), ns);
        let b = AttributeValue::B(Blob::new(vec![0xde, 0xad]));
        assert_eq!(from_value(&to_value(&b)).unwrap(), b);
        assert!(from_value(&Value::Array(vec![])).is_err());
        assert_eq!(from_value(&Value::Text("x".into())).unwrap(), AttributeValue::S("x".into()));
    }

    #[test]
    fn filters_use_placeholders() {
        let mut e = Expr::default();
        let f = vec![
            FilterCondition { column: "na\"me".into(), op: FilterOp::Eq, value: Some(Value::Text("x) OR (1=1".into())), values: vec![], ..Default::default() },
            FilterCondition { column: "n".into(), op: FilterOp::In, value: None, values: vec![Value::Int(1), Value::Int(2)], ..Default::default() },
            FilterCondition { column: "s".into(), op: FilterOp::StartsWith, value: Some(Value::Text("ab".into())), values: vec![], ..Default::default() },
            FilterCondition { column: "z".into(), op: FilterOp::IsNull, value: None, values: vec![], ..Default::default() },
        ];
        let s = filter_expression(&f, &mut e).unwrap().unwrap();
        assert_eq!(s, "#n0 = :v0 AND #n1 IN (:v1, :v2) AND begins_with(#n2, :v3) AND (attribute_not_exists(#n3) OR attribute_type(#n3, :v4))");
        assert_eq!(e.names["#n0"], "na\"me");
        assert_eq!(e.values[":v0"], AttributeValue::S("x) OR (1=1".into()));
        assert!(filter_expression(
            &[FilterCondition { column: "a".into(), op: FilterOp::EndsWith, value: Some(Value::Text("x".into())), values: vec![], ..Default::default() }],
            &mut e
        )
        .is_err());
        // New operators map to DynamoDB expressions; SQL-only ones are refused, never misread.
        let mut e2 = Expr::default();
        let more = vec![
            FilterCondition { column: "a".into(), op: FilterOp::NotIn, values: vec![Value::Int(1)], ..Default::default() },
            FilterCondition { column: "b".into(), op: FilterOp::Between, values: vec![Value::Int(1), Value::Int(5)], ..Default::default() },
            FilterCondition { column: "c".into(), op: FilterOp::NotContains, value: Some(Value::Text("q".into())), ..Default::default() },
        ];
        assert_eq!(filter_expression(&more, &mut e2).unwrap().unwrap(), "NOT (#n0 IN (:v0)) AND #n1 BETWEEN :v1 AND :v2 AND NOT contains(#n2, :v3)");
        for bad in [
            FilterCondition { column: "a".into(), op: FilterOp::Like, value: Some(Value::Text("x%".into())), ..Default::default() },
            FilterCondition { op: FilterOp::Raw, value: Some(Value::Text("1=1".into())), ..Default::default() },
            FilterCondition { op: FilterOp::Contains, value: Some(Value::Text("x".into())), any_columns: vec!["a".into()], ..Default::default() },
        ] {
            assert!(filter_expression(&[bad], &mut Expr::default()).is_err());
        }
    }

    #[test]
    fn result_columns_keys_first_and_typed() {
        let items = vec![
            HashMap::from([
                ("pk".to_string(), AttributeValue::S("a".into())),
                ("z".to_string(), AttributeValue::N("1.5".into())),
                ("m".to_string(), AttributeValue::N("2".into())),
            ]),
            HashMap::from([("pk".to_string(), AttributeValue::S("b".into())), ("z".to_string(), AttributeValue::S("text".into()))]),
        ];
        let rs = items_to_result(&items, &["pk".into()], Some("t"), &["pk".into()]);
        let names: Vec<_> = rs.columns.iter().map(|c| (c.name.as_str(), c.type_name.as_str())).collect();
        assert_eq!(names, vec![("pk", "S"), ("m", "N"), ("z", "mixed")]);
        assert_eq!(rs.rows[0][2], Value::Other { type_name: "N".into(), text: "1.5".into() });
        assert_eq!(rs.rows[1][1], Value::Null);
    }

    #[test]
    fn update_condition_guards_originals() {
        let schema = vec![("pk".to_string(), "S".to_string()), ("sk".to_string(), "N".to_string())];
        let ch = RowChange::Update {
            key: vec![("pk".into(), Value::Text("a".into())), ("sk".into(), Value::Int(1))],
            original: vec![("name".into(), Value::Text("old".into())), ("gone".into(), Value::Null)],
            changes: vec![("name".into(), Value::Text("new".into())), ("gone".into(), Value::Null)],
        };
        let item = DynamoConnection::transact_item("t", &schema, &ch).unwrap();
        let u = item.update().unwrap();
        assert_eq!(u.update_expression(), "SET #n0 = :v0 REMOVE #n1");
        assert_eq!(u.condition_expression(), Some("attribute_exists(#n2) AND #n0 = :v1 AND (attribute_not_exists(#n1) OR attribute_type(#n1, :v2))"));
        let bad = RowChange::Update { key: ch_key(), original: vec![], changes: vec![("pk".into(), Value::Text("z".into()))] };
        assert!(DynamoConnection::transact_item("t", &schema, &bad).is_err());
    }

    fn ch_key() -> Vec<(String, Value)> {
        vec![("pk".into(), Value::Text("a".into())), ("sk".into(), Value::Int(1))]
    }
}
