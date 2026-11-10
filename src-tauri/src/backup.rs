//! Backup/restore using vendor tools or APIs:
//! * SQLite: online backup API (consistent snapshot) + integrity check.
//! * PostgreSQL: `pg_dump` (custom format) / `pg_restore`.
//! * MySQL/MariaDB: `mysqldump --single-transaction` / `mysql`.
//!
//! External tools are run directly (no shell), with arguments passed as a vector.
//! Passwords are passed via a 0600 temp file (`PGPASSFILE`, `--defaults-extra-file`),
//! never on the command line where other users could see them in `ps`.

use std::io::Write;
use std::path::Path;
use std::process::Stdio;

use dbs_core::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupScope {
    Full,
    SchemaOnly,
    DataOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupOptions {
    pub scope: BackupScope,
    #[serde(default)]
    pub tables: Vec<String>,
    #[serde(default)]
    pub compress: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupReport {
    pub tool: String,
    pub bytes: u64,
    pub verified: bool,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolStatus {
    pub tool: &'static str,
    pub path: Option<String>,
    pub version: Option<String>,
}

pub fn tool_status() -> Vec<ToolStatus> {
    ["pg_dump", "pg_restore", "psql", "mysqldump", "mysql"]
        .into_iter()
        .map(|t| {
            let path = which::which(t).ok();
            let version = path
                .as_ref()
                .and_then(|p| std::process::Command::new(p).arg("--version").output().ok())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
            ToolStatus { tool: t, path: path.map(|p| p.to_string_lossy().into_owned()), version }
        })
        .collect()
}

fn tool(name: &str) -> DbResult<std::path::PathBuf> {
    which::which(name).map_err(|_| DbError::new(ErrorKind::NotFound, format!("{name} was not found on PATH; install the database client tools")))
}

fn secret_file(contents: &str) -> DbResult<tempfile::NamedTempFile> {
    let mut f = tempfile::Builder::new().prefix("dbs-").tempfile().map_err(|e| DbError::new(ErrorKind::Io, e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(f.path(), std::fs::Permissions::from_mode(0o600)).map_err(|e| DbError::new(ErrorKind::Io, e.to_string()))?;
    }
    f.write_all(contents.as_bytes()).map_err(|e| DbError::new(ErrorKind::Io, e.to_string()))?;
    f.flush().map_err(|e| DbError::new(ErrorKind::Io, e.to_string()))?;
    Ok(f)
}

fn pgpass_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace(':', "\\:")
}

fn validate_table_names(tables: &[String]) -> DbResult<()> {
    for t in tables {
        if t.is_empty() || t.len() > 256 || t.starts_with('-') || t.contains('\0') {
            return Err(DbError::invalid("invalid table name"));
        }
    }
    Ok(())
}

async fn run(mut cmd: tokio::process::Command) -> DbResult<String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let out = cmd.output().await.map_err(|e| DbError::new(ErrorKind::Io, e.to_string()))?;
    let stderr = redact_secrets(&String::from_utf8_lossy(&out.stderr));
    if !out.status.success() {
        return Err(DbError::new(ErrorKind::Internal, format!("tool failed ({}): {}", out.status, stderr.chars().take(4000).collect::<String>())));
    }
    Ok(stderr)
}

pub async fn backup(cfg: &ConnectionConfig, secrets: ConnectSecrets, dest: &Path, o: &BackupOptions) -> DbResult<BackupReport> {
    validate_table_names(&o.tables)?;
    match cfg.engine.wire_family() {
        Some(Engine::Sqlite) => {
            if !matches!(o.scope, BackupScope::Full) || !o.tables.is_empty() {
                return Err(DbError::unsupported("partial SQLite backups (use Export → SQL for schema/data subsets)"));
            }
            let src = cfg.database.clone().unwrap_or_default();
            dbs_drivers::sqlite::backup_to(&src, &dest.to_string_lossy()).await?;
            let bytes = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
            Ok(BackupReport { tool: "sqlite backup API".into(), bytes, verified: true, notes: vec!["integrity_check passed".into()] })
        }
        Some(Engine::Postgres) if cfg.engine == Engine::Postgres => {
            let mut cmd = tokio::process::Command::new(tool("pg_dump")?);
            let pass = secret_file(&format!(
                "{}:{}:{}:{}:{}\n",
                pgpass_escape(cfg.host.as_deref().unwrap_or("localhost")),
                cfg.effective_port().unwrap_or(5432),
                "*",
                pgpass_escape(cfg.username.as_deref().unwrap_or("")),
                pgpass_escape(secrets.password.as_deref().unwrap_or(""))
            ))?;
            drop(secrets);
            cmd.env("PGPASSFILE", pass.path()).env("PGSSLMODE", if cfg.tls.mode == TlsMode::Disable { "disable" } else { "verify-full" });
            if let Some(ca) = &cfg.tls.ca_cert_path {
                cmd.env("PGSSLROOTCERT", ca);
            }
            cmd.arg("--format=custom").arg("--no-password").arg(format!("--file={}", dest.display()));
            cmd.arg(format!("--host={}", cfg.host.as_deref().or(cfg.socket_path.as_deref()).unwrap_or("localhost")));
            cmd.arg(format!("--port={}", cfg.effective_port().unwrap_or(5432)));
            if let Some(u) = &cfg.username {
                cmd.arg(format!("--username={u}"));
            }
            match o.scope {
                BackupScope::SchemaOnly => {
                    cmd.arg("--schema-only");
                }
                BackupScope::DataOnly => {
                    cmd.arg("--data-only");
                }
                BackupScope::Full => {}
            }
            if !o.compress {
                cmd.arg("--compress=0");
            }
            for t in &o.tables {
                cmd.arg(format!("--table={t}"));
            }
            cmd.arg(format!("--dbname={}", cfg.database.as_deref().unwrap_or("postgres")));
            let log = run(cmd).await?;
            // Verify: pg_restore can read the archive's table of contents.
            let mut v = tokio::process::Command::new(tool("pg_restore")?);
            v.arg("--list").arg(dest);
            let verified = run(v).await.is_ok();
            let bytes = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
            Ok(BackupReport { tool: "pg_dump (custom format)".into(), bytes, verified, notes: log.lines().map(String::from).take(50).collect() })
        }
        Some(Engine::MySql) if matches!(cfg.engine, Engine::MySql | Engine::MariaDb | Engine::Percona) => {
            let defaults = secret_file(&format!(
                "[client]\nuser=\"{}\"\npassword=\"{}\"\n",
                cfg.username.as_deref().unwrap_or("").replace('\\', "\\\\").replace('"', "\\\""),
                secrets.password.as_deref().unwrap_or("").replace('\\', "\\\\").replace('"', "\\\"")
            ))?;
            drop(secrets);
            let mut cmd = tokio::process::Command::new(tool("mysqldump")?);
            cmd.arg(format!("--defaults-extra-file={}", defaults.path().display()));
            cmd.arg(format!("--host={}", cfg.host.as_deref().unwrap_or("localhost"))).arg(format!("--port={}", cfg.effective_port().unwrap_or(3306)));
            cmd.arg("--single-transaction").arg("--routines").arg("--triggers").arg("--events").arg("--hex-blob");
            cmd.arg(if cfg.tls.mode == TlsMode::Disable { "--ssl-mode=DISABLED" } else { "--ssl-mode=VERIFY_IDENTITY" });
            match o.scope {
                BackupScope::SchemaOnly => {
                    cmd.arg("--no-data");
                }
                BackupScope::DataOnly => {
                    cmd.arg("--no-create-info");
                }
                BackupScope::Full => {}
            }
            cmd.arg(format!("--result-file={}", dest.display()));
            cmd.arg("--").arg(cfg.database.as_deref().ok_or_else(|| DbError::invalid("select a database to back up"))?);
            for t in &o.tables {
                cmd.arg(t);
            }
            let log = run(cmd).await?;
            let tail = std::fs::read(dest).map(|b| String::from_utf8_lossy(&b[b.len().saturating_sub(200)..]).into_owned()).unwrap_or_default();
            let verified = tail.contains("Dump completed");
            let bytes = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
            Ok(BackupReport { tool: "mysqldump".into(), bytes, verified, notes: log.lines().map(String::from).take(50).collect() })
        }
        _ => Err(DbError::unsupported(
            "native backup for this engine (use Export → SQL dump instead; note this is a logical export, not a guaranteed complete backup)",
        )),
    }
}

pub async fn restore(cfg: &ConnectionConfig, secrets: ConnectSecrets, src: &Path) -> DbResult<BackupReport> {
    match cfg.engine {
        Engine::Postgres => {
            let pass = secret_file(&format!(
                "{}:{}:*:{}:{}\n",
                pgpass_escape(cfg.host.as_deref().unwrap_or("localhost")),
                cfg.effective_port().unwrap_or(5432),
                pgpass_escape(cfg.username.as_deref().unwrap_or("")),
                pgpass_escape(secrets.password.as_deref().unwrap_or(""))
            ))?;
            drop(secrets);
            let mut cmd = tokio::process::Command::new(tool("pg_restore")?);
            cmd.env("PGPASSFILE", pass.path()).env("PGSSLMODE", if cfg.tls.mode == TlsMode::Disable { "disable" } else { "verify-full" });
            cmd.arg("--no-password").arg("--single-transaction").arg("--exit-on-error");
            cmd.arg(format!("--host={}", cfg.host.as_deref().unwrap_or("localhost"))).arg(format!("--port={}", cfg.effective_port().unwrap_or(5432)));
            if let Some(u) = &cfg.username {
                cmd.arg(format!("--username={u}"));
            }
            cmd.arg(format!("--dbname={}", cfg.database.as_deref().unwrap_or("postgres"))).arg(src);
            let log = run(cmd).await?;
            Ok(BackupReport { tool: "pg_restore".into(), bytes: 0, verified: true, notes: log.lines().map(String::from).take(50).collect() })
        }
        Engine::MySql | Engine::MariaDb | Engine::Percona => {
            let defaults = secret_file(&format!(
                "[client]\nuser=\"{}\"\npassword=\"{}\"\n",
                cfg.username.as_deref().unwrap_or("").replace('"', "\\\""),
                secrets.password.as_deref().unwrap_or("").replace('"', "\\\"")
            ))?;
            drop(secrets);
            let mut cmd = tokio::process::Command::new(tool("mysql")?);
            cmd.arg(format!("--defaults-extra-file={}", defaults.path().display()));
            cmd.arg(format!("--host={}", cfg.host.as_deref().unwrap_or("localhost"))).arg(format!("--port={}", cfg.effective_port().unwrap_or(3306)));
            cmd.arg(if cfg.tls.mode == TlsMode::Disable { "--ssl-mode=DISABLED" } else { "--ssl-mode=VERIFY_IDENTITY" });
            cmd.arg("--").arg(cfg.database.as_deref().ok_or_else(|| DbError::invalid("select a target database"))?);
            let file = std::fs::File::open(src).map_err(|e| DbError::new(ErrorKind::Io, e.to_string()))?;
            cmd.stdin(Stdio::from(file)).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
            let out = cmd.output().await.map_err(|e| DbError::new(ErrorKind::Io, e.to_string()))?;
            if !out.status.success() {
                return Err(DbError::new(ErrorKind::Internal, redact_secrets(&String::from_utf8_lossy(&out.stderr))));
            }
            Ok(BackupReport { tool: "mysql".into(), bytes: 0, verified: true, notes: vec![] })
        }
        Engine::Sqlite => Err(DbError::unsupported("in-place SQLite restore (open the backup file as a new connection instead)")),
        _ => Err(DbError::unsupported("restore for this engine")),
    }
}
