//! Key-value browsing: logical databases, a SCAN-paged key grid, a lazily
//! expanded namespace tree, typed value pages and staged key edits.
//!
//! Engines that support it return `Some` from
//! [`crate::DatabaseConnection::key_value`]. Every read here is bounded (page
//! size, batch size, number of server round trips), so a browse never walks a
//! whole keyspace in one call.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::{ApplyReport, DbResult, Value};

/// Largest key-grid page.
pub const MAX_KEY_PAGE: u64 = 1000;
/// Largest number of keys one namespace expand examines before offering "load more".
pub const MAX_TREE_BATCH: u64 = 5000;
/// Largest number of elements in one value page.
pub const MAX_VALUE_PAGE: u32 = 1000;

/// One logical database (`db0`, `db1`, ...).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyspaceInfo {
    pub name: String,
    pub index: i64,
    pub keys: u64,
    pub expires: u64,
    /// The session's selected database.
    pub current: bool,
}

/// One row of the key grid.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeyRow {
    pub key: String,
    /// Server type name (`string`, `hash`, `list`, `set`, `zset`, `stream`, `json`, ...).
    pub kind: String,
    /// Seconds to live; -1 = no expiry.
    pub ttl: i64,
    /// Approximate memory use in bytes, when the server reports it.
    pub size: Option<u64>,
    /// Element count (fields, items, members, entries) or string length in bytes.
    pub length: Option<u64>,
    /// Strings: the first ~200 characters.
    pub preview: Option<String>,
    /// True when `preview` was cut.
    pub preview_truncated: bool,
}

/// One page of keys. `next` is the scan position to pass as `from` for the next page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeyPage {
    pub keys: Vec<KeyRow>,
    pub next: u64,
    /// The scan reached the end of the keyspace.
    pub done: bool,
    /// Total number of keys in the database (approximate: keys may expire),
    /// only for the match-all pattern.
    pub total: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamespaceNode {
    /// Full prefix including the trailing separator (`app:user:`).
    pub prefix: String,
    /// Last segment (`user`).
    pub label: String,
    /// Keys seen under this prefix in the scanned batches (approximate).
    pub count: u64,
}

/// One bounded batch of a namespace expand.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeBatch {
    pub namespaces: Vec<NamespaceNode>,
    /// Keys directly under the prefix (no further separator).
    pub keys: Vec<String>,
    /// Cursor for "load more" (only meaningful when `done` is false).
    pub cursor: u64,
    pub done: bool,
    /// Keys examined in this batch.
    pub scanned: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ValueRequest {
    /// Continuation from the previous page ("" = start).
    #[serde(default)]
    pub cursor: String,
    #[serde(default)]
    pub count: u32,
}

/// One page of a key's value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ValuePage {
    pub key: String,
    pub kind: String,
    pub ttl: i64,
    pub size: Option<u64>,
    pub length: Option<u64>,
    /// Column names for collection types (`field`/`value`, `index`/`value`, ...).
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    /// Strings and JSON documents: this chunk of text.
    pub text: Option<String>,
    /// Continuation for "load more"; `None` when everything was returned.
    pub next: Option<String>,
}

/// A staged change to a key. Applied as one transaction (`MULTI`/`EXEC`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum KvEdit {
    SetString {
        key: String,
        value: String,
    },
    /// `seconds < 0` removes the expiry.
    Expire {
        key: String,
        seconds: i64,
    },
    /// Fails (conflict) when `to` already exists.
    Rename {
        key: String,
        to: String,
    },
    Delete {
        key: String,
    },
    HashSet {
        key: String,
        field: String,
        value: String,
    },
    HashDelete {
        key: String,
        field: String,
    },
    ListPush {
        key: String,
        value: String,
    },
    ListSet {
        key: String,
        index: i64,
        value: String,
    },
    ListRemove {
        key: String,
        value: String,
    },
    SetAdd {
        key: String,
        member: String,
    },
    SetRemove {
        key: String,
        member: String,
    },
    ZsetAdd {
        key: String,
        member: String,
        score: f64,
    },
    ZsetRemove {
        key: String,
        member: String,
    },
}

impl KvEdit {
    pub fn key(&self) -> &str {
        match self {
            KvEdit::SetString { key, .. }
            | KvEdit::Expire { key, .. }
            | KvEdit::Rename { key, .. }
            | KvEdit::Delete { key }
            | KvEdit::HashSet { key, .. }
            | KvEdit::HashDelete { key, .. }
            | KvEdit::ListPush { key, .. }
            | KvEdit::ListSet { key, .. }
            | KvEdit::ListRemove { key, .. }
            | KvEdit::SetAdd { key, .. }
            | KvEdit::SetRemove { key, .. }
            | KvEdit::ZsetAdd { key, .. }
            | KvEdit::ZsetRemove { key, .. } => key,
        }
    }
}

#[async_trait]
pub trait KeyValueBrowser: Send + Sync {
    /// Databases that hold keys, plus the session's selected one.
    async fn keyspaces(&self) -> DbResult<Vec<KeyspaceInfo>>;
    /// One page of keys matching a glob `pattern`, starting at scan position `from`
    /// (0, or the `next` of a previous page). Bounded in keys and round trips.
    /// `restart` drops the cached scan for this pattern first (new tab, refresh).
    async fn scan_keys(&self, db: &str, pattern: &str, from: u64, limit: u64, restart: bool) -> DbResult<KeyPage>;
    /// Child namespaces and keys of `prefix`, from one bounded batch starting at `cursor`.
    async fn namespace_children(&self, db: &str, prefix: &str, separator: &str, cursor: u64, limit: u64) -> DbResult<TreeBatch>;
    async fn read_value(&self, db: &str, key: &str, req: &ValueRequest) -> DbResult<ValuePage>;
    /// Exact command lines [`Self::apply_edits`] will run (first line selects `db`).
    fn edit_commands(&self, db: &str, edits: &[KvEdit]) -> DbResult<Vec<String>>;
    async fn apply_edits(&self, db: &str, edits: &[KvEdit]) -> DbResult<ApplyReport>;
}
