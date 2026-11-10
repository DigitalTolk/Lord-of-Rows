use serde::{Deserialize, Serialize};

use crate::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColumnMeta {
    pub name: String,
    /// Native type name as reported by the server (e.g. `int8`, `varchar(255)`).
    pub type_name: String,
    pub nullable: Option<bool>,
    /// Source table, when the engine reports it (needed for safe inline editing).
    pub table: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ResultSet {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Value>>,
    /// True when the engine had more rows than `max_rows` and we stopped reading.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct StatementResult {
    pub statement_index: usize,
    /// Short excerpt of the statement (first 200 chars), for the results tab title.
    pub sql_excerpt: String,
    pub result: Option<ResultSet>,
    pub rows_affected: Option<u64>,
    pub duration_ms: u64,
    pub notices: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObjectKind {
    Database,
    Schema,
    Table,
    View,
    MaterializedView,
    Function,
    Procedure,
    Trigger,
    Sequence,
    Index,
    Type,
    Enum,
    Extension,
    Role,
    Event,
    Collection,
    Key,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectRef {
    pub kind: ObjectKind,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColumnDef {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub is_primary_key: bool,
    pub is_identity: bool,
    pub comment: Option<String>,
    pub ordinal: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IndexDef {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
    /// Full DDL / predicate when the engine exposes it.
    pub definition: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ForeignKeyDef {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_update: Option<String>,
    pub on_delete: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConstraintDef {
    pub name: String,
    /// `CHECK`, `UNIQUE`, ...
    pub kind: String,
    pub definition: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableDescription {
    pub object: ObjectRef,
    pub columns: Vec<ColumnDef>,
    pub primary_key: Vec<String>,
    pub indexes: Vec<IndexDef>,
    pub foreign_keys: Vec<ForeignKeyDef>,
    pub constraints: Vec<ConstraintDef>,
    pub ddl: Option<String>,
    pub estimated_rows: Option<i64>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerInfo {
    pub engine: crate::Engine,
    pub version: String,
    pub current_database: Option<String>,
    pub current_user: Option<String>,
}

/// One row-level change staged in the grid. Applied with parameterised SQL.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum RowChange {
    Insert {
        values: Vec<(String, Value)>,
    },
    Update {
        /// Primary-key (or unique-key) column values identifying the row.
        key: Vec<(String, Value)>,
        /// Original values of the edited columns, for optimistic concurrency.
        original: Vec<(String, Value)>,
        changes: Vec<(String, Value)>,
    },
    Delete {
        key: Vec<(String, Value)>,
        original: Vec<(String, Value)>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableTarget {
    pub schema: Option<String>,
    pub table: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ApplyReport {
    pub applied: usize,
    pub rows_affected: u64,
    /// Changes that hit zero rows (remote modification or deletion).
    pub conflicts: Vec<usize>,
    pub committed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub user: Option<String>,
    pub database: Option<String>,
    pub client: Option<String>,
    pub state: Option<String>,
    pub query: Option<String>,
    pub duration_ms: Option<i64>,
    pub blocked_by: Option<String>,
}
