//! Importers for connection definitions saved by other database tools.
//!
//! Parsers are pure: they take file contents (and a small [`Ctx`]) and return
//! [`ImportedConnection`]s. Reading files from their default locations lives in
//! [`load`]. Nothing here reads credentials; where a source keeps passwords in
//! the OS keychain, a row carries a [`KeychainItem`] reference that the caller
//! may resolve (with the user's consent).

use dbs_core::{ConnectionConfig, DbError, DbResult, Engine, EnvironmentKind, TlsConfig, TlsMode};
use dbs_secrets::{Secret, SecretKind};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub mod datagrip;
pub mod dbeaver;
pub mod load;
pub mod pgadmin;
pub mod sequel;
pub mod tableplus;
pub mod urls;
mod xml;

/// Where connections come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    TablePlus,
    Dbeaver,
    SequelAce,
    SequelPro,
    PgAdmin,
    DataGrip,
    UrlList,
}

impl SourceKind {
    /// The application's name, as the user knows it.
    pub fn label(self) -> &'static str {
        match self {
            SourceKind::TablePlus => "TablePlus",
            SourceKind::Dbeaver => "DBeaver",
            SourceKind::SequelAce => "Sequel Ace",
            SourceKind::SequelPro => "Sequel Pro",
            SourceKind::PgAdmin => "pgAdmin",
            SourceKind::DataGrip => "DataGrip",
            SourceKind::UrlList => "Connection URLs",
        }
    }

    /// Whether saved passwords can be brought along from this source on this platform.
    pub fn passwords_supported(self) -> bool {
        match self {
            SourceKind::TablePlus => cfg!(target_os = "macos"),
            s => s == SourceKind::UrlList,
        }
    }
}

/// Environment needed to turn relative locations (`~/.ssh/id_rsa`) into absolute paths.
#[derive(Debug, Clone, Default)]
pub struct Ctx {
    pub home: Option<String>,
}

impl Ctx {
    /// Expands a leading `~/` using the home directory (unchanged if unknown).
    pub fn expand(&self, p: &str) -> String {
        match (p.strip_prefix("~/"), &self.home) {
            (Some(rest), Some(h)) => format!("{}/{rest}", h.trim_end_matches('/')),
            _ => p.to_string(),
        }
    }
}

/// A password kept in the OS keychain by the source application.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeychainItem {
    pub kind: SecretKind,
    pub service: String,
    pub account: String,
}

/// One connection found in a source.
#[derive(Debug)]
pub struct ImportedConnection {
    /// Stable within the source (the source's own id when it has one).
    pub key: String,
    /// Engine name as the source spells it (shown for unsupported engines).
    pub source_engine: String,
    /// `None` when the engine is not one we know.
    pub config: Option<ConnectionConfig>,
    /// Why the row can't be imported as-is (parse problem), if any.
    pub error: Option<String>,
    /// Things the user should know (settings that could not be carried over).
    pub notes: Vec<String>,
    /// A password that was part of the source data itself (e.g. in a URL).
    pub password: Option<Secret>,
    /// Passwords the source keeps in the OS keychain.
    pub keychain: Vec<KeychainItem>,
    /// Display name (same as `config.name` when there is a config).
    pub name: String,
}

impl ImportedConnection {
    pub fn new(key: impl Into<String>, name: impl Into<String>, source_engine: impl Into<String>, config: Option<ConnectionConfig>) -> Self {
        ImportedConnection {
            key: key.into(),
            name: name.into(),
            source_engine: source_engine.into(),
            config,
            error: None,
            notes: vec![],
            password: None,
            keychain: vec![],
        }
    }
}

/// A blank config with the app's defaults. `id` is nil: the caller assigns one on save.
pub fn blank(engine: Engine, name: &str) -> ConnectionConfig {
    ConnectionConfig {
        id: Uuid::nil(),
        name: name.to_string(),
        engine,
        host: None,
        port: None,
        database: None,
        username: None,
        socket_path: None,
        tls: TlsConfig::default(),
        ssh: None,
        environment: EnvironmentKind::Development,
        read_only: false,
        color: None,
        group: None,
        tags: vec![],
        notes: None,
        favorite: false,
        connect_timeout_secs: 10,
        query_timeout_secs: None,
        init_sql: None,
        key_separator: None,
        managed_by: None,
        tunnel: None,
    }
}

/// Maps a product / driver name from another tool to an engine.
pub fn engine_from_name(name: &str) -> Option<Engine> {
    let n: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
    let has = |s: &str| n.contains(s);
    Some(match () {
        _ if has("mariadb") => Engine::MariaDb,
        _ if has("percona") => Engine::Percona,
        _ if has("singlestore") || has("memsql") => Engine::SingleStore,
        _ if has("mysql") => Engine::MySql,
        _ if has("cockroach") => Engine::CockroachDb,
        _ if has("redshift") => Engine::Redshift,
        _ if has("greenplum") => Engine::Greenplum,
        _ if has("yugabyte") => Engine::YugabyteDb,
        _ if has("postgres") || n == "pgsql" || n == "pg" => Engine::Postgres,
        _ if has("duckdb") => Engine::DuckDb,
        _ if has("libsql") => Engine::LibSql,
        _ if has("turso") => Engine::Turso,
        _ if has("cloudflare") || n == "d1" => Engine::CloudflareD1,
        _ if has("sqlite") => Engine::Sqlite,
        _ if has("sqlserver") || has("mssql") || has("microsoftsql") || has("azuresql") => Engine::SqlServer,
        _ if has("oracle") => Engine::Oracle,
        _ if has("vertica") => Engine::Vertica,
        _ if has("mongo") => Engine::MongoDb,
        _ if has("redis") => Engine::Redis,
        _ if has("cassandra") => Engine::Cassandra,
        _ if has("dynamo") => Engine::DynamoDb,
        _ if has("elastic") || has("opensearch") => Engine::Elasticsearch,
        _ if has("clickhouse") => Engine::ClickHouse,
        _ if has("bigquery") => Engine::BigQuery,
        _ if has("snowflake") => Engine::Snowflake,
        _ => return None,
    })
}

/// Maps an environment / connection-type label. `None` for an empty label.
pub fn environment_from_name(name: &str) -> Option<EnvironmentKind> {
    let n = name.trim().to_ascii_lowercase();
    Some(match n.as_str() {
        "" => return None,
        "local" | "localhost" => EnvironmentKind::Local,
        "development" | "dev" | "develop" => EnvironmentKind::Development,
        "testing" | "test" | "qa" => EnvironmentKind::Testing,
        "staging" | "stage" | "preprod" | "pre-production" => EnvironmentKind::Staging,
        "production" | "prod" | "live" => EnvironmentKind::Production,
        _ => EnvironmentKind::Custom,
    })
}

/// Default environment when the source doesn't say: local for files and loopback hosts.
pub fn default_environment(cfg: &ConnectionConfig) -> EnvironmentKind {
    let local = cfg.engine.wire_family() == Some(Engine::Sqlite)
        || cfg.socket_path.is_some()
        || cfg.host.as_deref().is_none_or(|h| h.is_empty() || dbs_core::is_loopback(h) || h == "0.0.0.0");
    if local {
        EnvironmentKind::Local
    } else {
        EnvironmentKind::Development
    }
}

/// libpq / MySQL style SSL mode names.
pub fn tls_mode_from_name(name: &str) -> Option<TlsMode> {
    Some(match name.trim().to_ascii_lowercase().replace(['_', ' '], "-").as_str() {
        "disable" | "disabled" | "off" | "false" | "no" => TlsMode::Disabled,
        "allow" | "prefer" | "preferred" => TlsMode::Preferred,
        "require" | "required" | "on" | "true" | "yes" => TlsMode::Required,
        "verify-ca" => TlsMode::VerifyCa,
        "verify-full" | "verify-identity" => TlsMode::VerifyIdentity,
        _ => return None,
    })
}

/// Parses a port given as a number or string; empty / 0 / out of range = none.
pub fn port_from(v: &str) -> Option<u16> {
    v.trim().parse::<u16>().ok().filter(|p| *p > 0)
}

/// `Some(trimmed)` unless blank.
pub fn non_empty(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Normalises `#RGB` / `#RRGGBB` (any case) to lowercase `#rrggbb`.
pub fn hex_color(c: &str) -> Option<String> {
    let h = c.trim().strip_prefix('#')?;
    if !h.chars().all(|x| x.is_ascii_hexdigit()) {
        return None;
    }
    match h.len() {
        6 => Some(format!("#{}", h.to_ascii_lowercase())),
        3 => Some(format!("#{}", h.chars().flat_map(|x| [x, x]).collect::<String>().to_ascii_lowercase())),
        // #RRGGBBAA: drop alpha.
        8 => Some(format!("#{}", h[..6].to_ascii_lowercase())),
        _ => None,
    }
}

/// Fills a default name (`database@host`, or the file name) when the source has none.
pub fn fallback_name(cfg: &ConnectionConfig) -> String {
    if cfg.engine.wire_family() == Some(Engine::Sqlite) {
        if let Some(d) = &cfg.database {
            return d.rsplit(['/', '\\']).next().unwrap_or(d).to_string();
        }
    }
    match (&cfg.database, &cfg.host) {
        (Some(d), Some(h)) => format!("{d}@{h}"),
        (None, Some(h)) => h.clone(),
        (Some(d), None) => d.clone(),
        (None, None) => "Imported connection".into(),
    }
}

/// Size cap for any source file we read.
pub const MAX_FILE_BYTES: usize = 20 * 1024 * 1024;

pub(crate) fn invalid(what: &str, e: impl std::fmt::Display) -> DbError {
    DbError::invalid(format!("{what}: {e}"))
}

/// Joins nested folder names into one group name.
pub fn group_path(parts: &[String]) -> Option<String> {
    let p: Vec<&str> = parts.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if p.is_empty() {
        None
    } else {
        let s = p.join(" / ");
        Some(s.chars().take(100).collect())
    }
}

/// Result type of the parsers.
pub type Parsed = DbResult<Vec<ImportedConnection>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_names() {
        assert_eq!(engine_from_name("MySQL"), Some(Engine::MySql));
        assert_eq!(engine_from_name("MariaDB"), Some(Engine::MariaDb));
        assert_eq!(engine_from_name("PostgreSQL"), Some(Engine::Postgres));
        assert_eq!(engine_from_name("postgres-jdbc"), Some(Engine::Postgres));
        assert_eq!(engine_from_name("Microsoft SQL Server"), Some(Engine::SqlServer));
        assert_eq!(engine_from_name("mysql.8"), Some(Engine::MySql));
        assert_eq!(engine_from_name("sqlite_jdbc"), Some(Engine::Sqlite));
        assert_eq!(engine_from_name("Firebird"), None);
    }

    #[test]
    fn environments_and_colors() {
        assert_eq!(environment_from_name("prod"), Some(EnvironmentKind::Production));
        assert_eq!(environment_from_name(""), None);
        assert_eq!(environment_from_name("Sandbox"), Some(EnvironmentKind::Custom));
        assert_eq!(hex_color("#ABC").as_deref(), Some("#aabbcc"));
        assert_eq!(hex_color("#007F3D").as_deref(), Some("#007f3d"));
        assert_eq!(hex_color("red"), None);
        assert_eq!(group_path(&["A".into(), " ".into(), "B".into()]).as_deref(), Some("A / B"));
    }
}
