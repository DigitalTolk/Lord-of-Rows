use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{DbError, DbResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Engine {
    Postgres,
    MySql,
    MariaDb,
    Sqlite,
    SqlServer,
    Oracle,
    CockroachDb,
    Redshift,
    SingleStore,
    Greenplum,
    Vertica,
    DuckDb,
    LibSql,
    Turso,
    YugabyteDb,
    Percona,
    MongoDb,
    Redis,
    Cassandra,
    DynamoDb,
    Elasticsearch,
    ClickHouse,
    BigQuery,
    Snowflake,
    CloudflareD1,
}

impl Engine {
    pub const ALL: [Engine; 25] = [
        Engine::Postgres,
        Engine::MySql,
        Engine::MariaDb,
        Engine::Sqlite,
        Engine::SqlServer,
        Engine::Oracle,
        Engine::CockroachDb,
        Engine::Redshift,
        Engine::SingleStore,
        Engine::Greenplum,
        Engine::Vertica,
        Engine::DuckDb,
        Engine::LibSql,
        Engine::Turso,
        Engine::YugabyteDb,
        Engine::Percona,
        Engine::MongoDb,
        Engine::Redis,
        Engine::Cassandra,
        Engine::DynamoDb,
        Engine::Elasticsearch,
        Engine::ClickHouse,
        Engine::BigQuery,
        Engine::Snowflake,
        Engine::CloudflareD1,
    ];

    pub fn default_port(self) -> Option<u16> {
        Some(match self {
            Engine::Postgres | Engine::Greenplum => 5432,
            Engine::CockroachDb | Engine::YugabyteDb => 26257,
            Engine::Redshift => 5439,
            Engine::MySql | Engine::MariaDb | Engine::Percona | Engine::SingleStore => 3306,
            Engine::SqlServer => 1433,
            Engine::Oracle => 1521,
            Engine::Vertica => 5433,
            Engine::MongoDb => 27017,
            Engine::Redis => 6379,
            Engine::Cassandra => 9042,
            Engine::Elasticsearch => 9200,
            Engine::ClickHouse => 8123,
            _ => return None,
        })
    }

    /// Engines that speak a protocol we already implement.
    pub fn wire_family(self) -> Option<Engine> {
        match self {
            Engine::Postgres | Engine::CockroachDb | Engine::YugabyteDb | Engine::Redshift | Engine::Greenplum => Some(Engine::Postgres),
            Engine::MySql | Engine::MariaDb | Engine::Percona | Engine::SingleStore => Some(Engine::MySql),
            Engine::Sqlite => Some(Engine::Sqlite),
            Engine::Redis => Some(Engine::Redis),
            Engine::DynamoDb => Some(Engine::DynamoDb),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentKind {
    #[default]
    Local,
    Development,
    Testing,
    Staging,
    Production,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TlsMode {
    /// No TLS. Only allowed for loopback/socket hosts unless the user explicitly opts in.
    Disable,
    /// TLS required, certificate + hostname verified (default).
    #[default]
    VerifyFull,
    /// TLS required, CA verified, hostname not verified. Must be chosen explicitly.
    VerifyCa,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct TlsConfig {
    pub mode: TlsMode,
    pub ca_cert_path: Option<String>,
    pub client_cert_path: Option<String>,
    /// Client key is a secret: stored in the OS keychain under `SecretKind::TlsClientKey`
    /// when it is pasted, or referenced by path when it lives on disk.
    pub client_key_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SshAuth {
    Password,
    PrivateKey,
    Agent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
    pub private_key_path: Option<String>,
    /// Ordered jump hosts (`user@host:port`), applied before `host`.
    #[serde(default)]
    pub jump_hosts: Vec<String>,
    #[serde(default = "default_keepalive")]
    pub keepalive_secs: u32,
}

fn default_keepalive() -> u32 {
    30
}

/// Saved connection definition. Contains NO secrets: passwords, key passphrases
/// and tokens live in the OS credential store, keyed by `id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub id: Uuid,
    pub name: String,
    pub engine: Engine,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    /// For SQLite/DuckDB: file path. For others: default database.
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub socket_path: Option<String>,
    #[serde(default)]
    pub tls: TlsConfig,
    #[serde(default)]
    pub ssh: Option<SshConfig>,
    #[serde(default)]
    pub environment: EnvironmentKind,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default = "default_connect_timeout")]
    pub connect_timeout_secs: u32,
    #[serde(default)]
    pub query_timeout_secs: Option<u32>,
    /// Statements run once after connect. Subject to the same safety policy as user SQL.
    #[serde(default)]
    pub init_sql: Option<String>,
    /// Runtime only (never saved): local SSH-tunnel endpoint. Drivers that can
    /// separate "address to dial" from "hostname to verify" (Postgres) dial this
    /// while still verifying TLS against `host`.
    #[serde(skip)]
    pub tunnel: Option<(String, u16)>,
}

fn default_connect_timeout() -> u32 {
    10
}

impl ConnectionConfig {
    pub fn validate(&self) -> DbResult<()> {
        if self.name.trim().is_empty() || self.name.len() > 200 {
            return Err(DbError::invalid("connection name must be 1-200 characters"));
        }
        if self.connect_timeout_secs == 0 || self.connect_timeout_secs > 600 {
            return Err(DbError::invalid("connect timeout must be 1-600 seconds"));
        }
        match self.engine {
            Engine::Sqlite | Engine::DuckDb => {
                if self.database.as_deref().is_none_or(|d| d.trim().is_empty()) {
                    return Err(DbError::invalid("a database file path is required"));
                }
            }
            // DynamoDB: `host` is an optional endpoint URL (empty = AWS endpoint for the region).
            Engine::DynamoDb => return self.validate_dynamodb(),
            _ => {
                if self.socket_path.is_none() && self.host.as_deref().is_none_or(|h| h.trim().is_empty()) {
                    return Err(DbError::invalid("host is required"));
                }
            }
        }
        self.validate_color()?;
        if let Some(h) = &self.host {
            if h.chars().any(|c| c.is_whitespace() || c.is_control() || c == '/' || c == '@') {
                return Err(DbError::invalid("host contains invalid characters"));
            }
        }
        if self.tls.mode == TlsMode::Disable && self.ssh.is_none() && self.tunnel.is_none() {
            if let Some(h) = &self.host {
                if !is_loopback(h) && self.environment == EnvironmentKind::Production {
                    return Err(DbError::invalid("TLS cannot be disabled for a non-local production connection without an SSH tunnel"));
                }
            }
        }
        Ok(())
    }

    fn validate_color(&self) -> DbResult<()> {
        if let Some(c) = &self.color {
            let ok = c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit());
            if !ok {
                return Err(DbError::invalid("color must be #RRGGBB"));
            }
        }
        Ok(())
    }

    /// DynamoDB mapping: `host` = optional endpoint URL (`http(s)://host[:port]`, for
    /// DynamoDB Local / LocalStack), `database` = region, `username` = access key id or
    /// `profile:NAME`, password = secret access key. Port, TLS and SSH settings do not apply.
    fn validate_dynamodb(&self) -> DbResult<()> {
        self.validate_color()?;
        if self.ssh.is_some() {
            return Err(DbError::invalid("SSH tunnels are not supported for DynamoDB (use an endpoint URL)"));
        }
        if let Some(r) = self.database.as_deref().filter(|r| !r.is_empty()) {
            if r.len() > 32 || !r.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
                return Err(DbError::invalid("region must look like us-east-1"));
            }
        }
        if let Some(ep) = self.host.as_deref().map(str::trim).filter(|h| !h.is_empty()) {
            let rest = ep
                .strip_prefix("https://")
                .or_else(|| ep.strip_prefix("http://"))
                .ok_or_else(|| DbError::invalid("endpoint must be an http:// or https:// URL"))?;
            let authority = rest.split('/').next().unwrap_or("");
            if authority.is_empty() || ep.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '@' | '?' | '#')) {
                return Err(DbError::invalid("endpoint URL is invalid (credentials, query or fragment are not allowed)"));
            }
            let host = authority.rsplit_once(':').map(|(h, _)| h).unwrap_or(authority);
            if ep.starts_with("http://") && !is_loopback(host) && self.environment == EnvironmentKind::Production {
                return Err(DbError::invalid("TLS cannot be disabled for a non-local production connection (use an https:// endpoint)"));
            }
        }
        Ok(())
    }

    pub fn effective_port(&self) -> Option<u16> {
        self.port.or_else(|| self.engine.default_port())
    }

    pub fn is_production(&self) -> bool {
        self.environment == EnvironmentKind::Production
    }

    /// Connection URL with secrets omitted, for "Copy URL".
    pub fn redacted_url(&self) -> String {
        let scheme = match self.engine.wire_family() {
            Some(Engine::Postgres) => "postgresql",
            Some(Engine::MySql) => "mysql",
            Some(Engine::Sqlite) => return format!("sqlite://{}", self.database.clone().unwrap_or_default()),
            Some(Engine::Redis) => "redis",
            Some(Engine::DynamoDb) => {
                let region = self.database.clone().filter(|r| !r.is_empty()).unwrap_or_else(|| "us-east-1".into());
                return match self.host.as_deref().filter(|h| !h.is_empty()) {
                    Some(ep) => format!("dynamodb://{region}?endpoint={ep}"),
                    None => format!("dynamodb://{region}"),
                };
            }
            _ => "db",
        };
        let user = self.username.clone().map(|u| format!("{u}@")).unwrap_or_default();
        let host = self.host.clone().unwrap_or_default();
        let port = self.effective_port().map(|p| format!(":{p}")).unwrap_or_default();
        let db = self.database.clone().map(|d| format!("/{d}")).unwrap_or_default();
        format!("{scheme}://{user}{host}{port}{db}")
    }
}

pub fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pg() -> ConnectionConfig {
        ConnectionConfig {
            id: Uuid::new_v4(),
            name: "x".into(),
            engine: Engine::Postgres,
            host: Some("db.example.com".into()),
            port: None,
            database: Some("app".into()),
            username: Some("bob".into()),
            socket_path: None,
            tls: TlsConfig::default(),
            ssh: None,
            environment: EnvironmentKind::Production,
            read_only: false,
            color: None,
            group: None,
            tags: vec![],
            notes: None,
            favorite: false,
            connect_timeout_secs: 10,
            query_timeout_secs: None,
            init_sql: None,
            tunnel: None,
        }
    }

    #[test]
    fn tls_on_by_default() {
        assert_eq!(pg().tls.mode, TlsMode::VerifyFull);
    }

    #[test]
    fn rejects_plaintext_remote_production() {
        let mut c = pg();
        c.tls.mode = TlsMode::Disable;
        assert!(c.validate().is_err());
        c.host = Some("localhost".into());
        assert!(c.validate().is_ok());
        // An active SSH tunnel (runtime endpoint) counts as an encrypted path.
        c.host = Some("db.internal".into());
        c.tunnel = Some(("127.0.0.1".into(), 40000));
        assert!(c.validate().is_ok());
    }

    #[test]
    fn rejects_bad_host() {
        let mut c = pg();
        c.host = Some("evil host".into());
        assert!(c.validate().is_err());
        c.host = Some("user@host".into());
        assert!(c.validate().is_err());
    }

    #[test]
    fn redacted_url_has_no_password_slot() {
        let u = pg().redacted_url();
        assert_eq!(u, "postgresql://bob@db.example.com:5432/app");
    }

    #[test]
    fn dynamodb_endpoint_rules() {
        let mut c = pg();
        c.engine = Engine::DynamoDb;
        c.host = None;
        c.database = Some("eu-central-1".into());
        assert!(c.validate().is_ok(), "AWS endpoint needs no host");
        c.host = Some("http://127.0.0.1:8000".into());
        assert!(c.validate().is_ok());
        c.host = Some("http://dynamodb.internal:8000".into());
        assert!(c.validate().is_err(), "plaintext remote production endpoint");
        c.environment = EnvironmentKind::Local;
        assert!(c.validate().is_ok());
        c.host = Some("https://user:pw@x".into());
        assert!(c.validate().is_err());
        c.host = Some("ftp://x".into());
        assert!(c.validate().is_err());
        c.host = None;
        c.database = Some("us east".into());
        assert!(c.validate().is_err());
        c.database = Some("us-east-1".into());
        assert_eq!(c.redacted_url(), "dynamodb://us-east-1");
    }

    #[test]
    fn sqlite_requires_path() {
        let mut c = pg();
        c.engine = Engine::Sqlite;
        c.database = None;
        assert!(c.validate().is_err());
    }
}
