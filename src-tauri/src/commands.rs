use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dbs_audit::{AuditEntry, AuditFilter, Category, NewEvent, Outcome, VerifyReport};
use dbs_core::*;
use dbs_safety::{Classified, Decision, Evaluation, Risk};
use dbs_secrets::{SecretKind, SecretStore};
use dbs_store::{ConnectionGroup, Document, HistoryEntry, Snippet, StoredConnection};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::state::{AppState, FileGrant, GrantMode, Session, APP_VERSION};

type R<T> = Result<T, DbError>;

fn env_name(c: &ConnectionConfig) -> String {
    serde_json::to_value(c.environment).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

pub(crate) fn engine_name(e: Engine) -> String {
    serde_json::to_value(e).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

pub(crate) fn audit(st: &AppState, cat: Category, outcome: Outcome, cfg: Option<&ConnectionConfig>, f: impl FnOnce(&mut NewEvent)) {
    let mut ev = NewEvent { category: Some(cat), outcome: Some(outcome), ..Default::default() };
    if let Some(c) = cfg {
        ev.connection_id = Some(c.id.to_string());
        ev.engine = Some(engine_name(c.engine));
        ev.environment = Some(env_name(c));
    }
    f(&mut ev);
    if let Err(e) = st.audit.record(ev) {
        tracing::error!("audit write failed: {}", e.message);
    }
}

pub(crate) fn check_len(s: &str, max: usize, what: &str) -> R<()> {
    if s.len() > max {
        return Err(DbError::invalid(format!("{what} is too large")));
    }
    Ok(())
}

// ---------------------------------------------------------------- app

#[derive(Serialize)]
pub struct AppInfo {
    version: &'static str,
    os: &'static str,
    arch: &'static str,
    secret_backend: &'static str,
    supported_engines: Vec<Engine>,
    all_engines: Vec<Engine>,
}

#[tauri::command]
pub fn app_info(st: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: APP_VERSION,
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        secret_backend: st.secrets.backend_name(),
        supported_engines: dbs_drivers::supported_engines(),
        all_engines: Engine::ALL.to_vec(),
    }
}

// ---------------------------------------------------------------- connections

#[derive(Deserialize)]
pub struct SaveConnection {
    config: ConnectionConfig,
    /// `Some("")` clears, `None` leaves unchanged.
    password: Option<String>,
    /// Save password to the OS keychain (true) or keep it only for this app run.
    #[serde(default = "yes")]
    remember_password: bool,
    /// SSH password / private-key passphrase (same semantics as `password`). Stored in the OS keychain.
    #[serde(default)]
    ssh_password: Option<String>,
    #[serde(default)]
    ssh_passphrase: Option<String>,
}
fn yes() -> bool {
    true
}

#[tauri::command]
pub fn list_connections(st: State<'_, AppState>) -> R<Vec<StoredConnection>> {
    st.store.list_connections()
}

#[tauri::command]
pub fn save_connection(st: State<'_, AppState>, req: SaveConnection) -> R<ConnectionConfig> {
    let mut cfg = req.config;
    if cfg.id.is_nil() {
        cfg.id = Uuid::new_v4();
    }
    cfg.validate()?;
    let existed = st.store.get_connection(cfg.id).is_ok();
    st.store.save_connection(&cfg)?;
    if let Some(pw) = req.password {
        check_len(&pw, 4096, "password")?;
        if pw.is_empty() {
            st.secrets.delete(cfg.id, SecretKind::DbPassword)?;
            st.session_secrets.delete(cfg.id, SecretKind::DbPassword)?;
        } else if req.remember_password {
            st.secrets.set(cfg.id, SecretKind::DbPassword, &pw)?;
            st.session_secrets.delete(cfg.id, SecretKind::DbPassword)?;
        } else {
            st.secrets.delete(cfg.id, SecretKind::DbPassword)?;
            st.session_secrets.set(cfg.id, SecretKind::DbPassword, &pw)?;
        }
        audit(&st, Category::CredentialChanged, Outcome::Success, Some(&cfg), |_| {});
    }
    for (val, kind) in [(req.ssh_password, SecretKind::SshPassword), (req.ssh_passphrase, SecretKind::SshKeyPassphrase)] {
        if let Some(v) = val {
            check_len(&v, 4096, "SSH secret")?;
            if v.is_empty() {
                st.secrets.delete(cfg.id, kind)?;
            } else {
                st.secrets.set(cfg.id, kind, &v)?;
            }
            audit(&st, Category::CredentialChanged, Outcome::Success, Some(&cfg), |e| e.detail = Some("ssh".into()));
        }
    }
    audit(&st, if existed { Category::ConnectionModified } else { Category::ConnectionCreated }, Outcome::Success, Some(&cfg), |_| {});
    Ok(cfg)
}

#[tauri::command]
pub fn delete_connection(st: State<'_, AppState>, id: Uuid) -> R<()> {
    let cfg = st.store.get_connection(id).ok();
    st.store.delete_connection(id)?;
    st.secrets.delete_all(id)?;
    st.session_secrets.delete_all(id)?;
    audit(&st, Category::ConnectionDeleted, Outcome::Success, cfg.as_ref(), |e| e.connection_id = Some(id.to_string()));
    audit(&st, Category::CredentialDeleted, Outcome::Success, cfg.as_ref(), |e| e.connection_id = Some(id.to_string()));
    Ok(())
}

#[tauri::command]
pub fn reorder_connections(st: State<'_, AppState>, ids: Vec<Uuid>) -> R<()> {
    st.store.reorder_connections(&ids)
}

// Connection-list groups. Membership is the connection's `group` field; the
// store keeps per-group order, colour and collapsed state.

#[tauri::command]
pub fn list_connection_groups(st: State<'_, AppState>) -> R<Vec<ConnectionGroup>> {
    st.store.list_groups()
}

#[tauri::command]
pub fn save_connection_group(st: State<'_, AppState>, group: ConnectionGroup) -> R<ConnectionGroup> {
    st.store.save_group(&group)
}

#[tauri::command]
pub fn rename_connection_group(st: State<'_, AppState>, from: String, to: String) -> R<()> {
    st.store.rename_group(&from, &to)
}

/// Deletes the group only; its connections become ungrouped. Returns how many moved.
#[tauri::command]
pub fn delete_connection_group(st: State<'_, AppState>, name: String) -> R<usize> {
    st.store.delete_group(&name)
}

#[tauri::command]
pub fn reorder_connection_groups(st: State<'_, AppState>, names: Vec<String>) -> R<()> {
    st.store.reorder_groups(&names)
}

#[tauri::command]
pub fn set_connection_group(st: State<'_, AppState>, id: Uuid, group: Option<String>) -> R<ConnectionConfig> {
    st.store.set_connection_group(id, group.as_deref())
}

fn resolve_secrets(st: &AppState, cfg: &ConnectionConfig, override_pw: Option<String>) -> R<ConnectSecrets> {
    if let Some(p) = override_pw {
        return Ok(ConnectSecrets { password: Some(p) });
    }
    let p = match st.session_secrets.get(cfg.id, SecretKind::DbPassword)? {
        Some(s) => Some(s.into_inner()),
        None => st.secrets.get(cfg.id, SecretKind::DbPassword)?.map(|s| s.into_inner()),
    };
    Ok(ConnectSecrets { password: p })
}

/// SSH secrets: explicit values (from the connection form) win, else the keychain.
fn resolve_ssh_secrets(st: &AppState, cfg: &ConnectionConfig, password: Option<String>, passphrase: Option<String>) -> R<dbs_ssh::SshSecrets> {
    let get = |k| -> R<Option<String>> { Ok(st.secrets.get(cfg.id, k)?.map(|s| s.into_inner())) };
    Ok(dbs_ssh::SshSecrets {
        password: match password {
            Some(p) => Some(p),
            None => get(SecretKind::SshPassword)?,
        },
        key_passphrase: match passphrase {
            Some(p) => Some(p),
            None => get(SecretKind::SshKeyPassphrase)?,
        },
    })
}

/// Connect, through an SSH tunnel when configured. The tunnel (if any) must be
/// kept alive for as long as the connection is used.
async fn connect(
    st: &AppState,
    cfg: &ConnectionConfig,
    secrets: ConnectSecrets,
    ssh_secrets: dbs_ssh::SshSecrets,
    trust_host_key: Option<&str>,
) -> R<(Box<dyn DatabaseConnection>, Option<dbs_ssh::Tunnel>)> {
    let drv = dbs_drivers::driver_for(cfg.engine)
        .ok_or_else(|| DbError::unsupported(&format!("the {} driver (not yet implemented; see FEATURE_MATRIX.md)", engine_name(cfg.engine))))?;
    let Some(ssh) = &cfg.ssh else {
        return Ok((drv.connect(cfg, secrets).await?, None));
    };
    if matches!(cfg.engine.wire_family(), Some(Engine::Sqlite)) {
        return Err(DbError::invalid("SSH tunnels apply to network databases, not local files"));
    }
    let target_host = cfg.host.clone().ok_or_else(|| DbError::invalid("host is required (as seen from the SSH server)"))?;
    let target_port = cfg.effective_port().ok_or_else(|| DbError::invalid("port is required"))?;
    let tunnel = dbs_ssh::open_tunnel(
        ssh,
        ssh_secrets,
        &target_host,
        target_port,
        &st.known_hosts,
        trust_host_key,
        std::time::Duration::from_secs(cfg.connect_timeout_secs as u64),
    )
    .await?;
    let mut eff = cfg.clone();
    eff.ssh = None;
    if cfg.engine.wire_family() == Some(Engine::Postgres) {
        // Dial the tunnel; TLS still verifies against the real hostname.
        eff.tunnel = Some(("127.0.0.1".into(), tunnel.local_port));
    } else {
        // These drivers dial 127.0.0.1 through the tunnel, so the server hostname can't be verified.
        match cfg.tls.mode {
            TlsMode::VerifyIdentity => {
                return Err(DbError::unsupported(
                    "SSL mode VERIFY-IDENTITY through an SSH tunnel for this engine (the hostname can't be verified through the tunnel). Use VERIFY-CA or REQUIRED, or PREFERRED/DISABLED: the SSH tunnel already encrypts the connection",
                ));
            }
            // The tunnel already encrypts; PREFERRED means "no extra TLS" here.
            TlsMode::Preferred => eff.tls.mode = TlsMode::Disabled,
            TlsMode::Disabled | TlsMode::Required | TlsMode::VerifyCa => {}
        }
        eff.host = Some("127.0.0.1".into());
        eff.port = Some(tunnel.local_port);
    }
    let conn = drv.connect(&eff, secrets).await?;
    Ok((conn, Some(tunnel)))
}

#[derive(Serialize)]
pub struct TestResult {
    server: ServerInfo,
    latency_ms: u64,
}

#[tauri::command]
pub async fn test_connection(
    st: State<'_, AppState>,
    config: ConnectionConfig,
    password: Option<String>,
    ssh_password: Option<String>,
    ssh_passphrase: Option<String>,
    trust_host_key: Option<String>,
) -> R<TestResult> {
    config.validate()?;
    let secrets = resolve_secrets(&st, &config, password)?;
    let ssh_secrets = resolve_ssh_secrets(&st, &config, ssh_password, ssh_passphrase)?;
    let t = Instant::now();
    let r = async {
        let (c, _tunnel) = connect(&st, &config, secrets, ssh_secrets, trust_host_key.as_deref()).await?;
        let info = c.server_info().await?;
        let _ = c.close().await;
        Ok::<_, DbError>(info)
    }
    .await;
    match r {
        Ok(server) => Ok(TestResult { server, latency_ms: t.elapsed().as_millis() as u64 }),
        Err(e) => {
            audit(&st, Category::ConnectionFailed, Outcome::Failure, Some(&config), |ev| ev.error_kind = Some(e.kind));
            Err(e)
        }
    }
}

/// Export connection definitions as JSON. Never includes secrets.
#[tauri::command]
pub fn export_connections(st: State<'_, AppState>) -> R<String> {
    let list: Vec<ConnectionConfig> = st.store.list_connections()?.into_iter().map(|c| c.config).collect();
    audit(&st, Category::Export, Outcome::Success, None, |e| e.detail = Some(format!("{} connection definitions (no secrets)", list.len())));
    serde_json::to_string_pretty(&serde_json::json!({ "format": "dbstudio.connections.v1", "connections": list })).map_err(|e| DbError::internal(e.to_string()))
}

#[tauri::command]
pub fn import_connections(st: State<'_, AppState>, json: String) -> R<usize> {
    check_len(&json, 10 * 1024 * 1024, "import")?;
    let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| DbError::invalid(e.to_string()))?;
    if v.get("format").and_then(|f| f.as_str()) != Some("dbstudio.connections.v1") {
        return Err(DbError::invalid("unrecognised connections file"));
    }
    let list: Vec<ConnectionConfig> = serde_json::from_value(v["connections"].clone()).map_err(|e| DbError::invalid(e.to_string()))?;
    let mut n = 0;
    for mut c in list {
        c.id = Uuid::new_v4(); // never collide with / overwrite existing entries
        c.init_sql = None; // imported init SQL could be malicious; user must re-add it
        if c.validate().is_ok() {
            st.store.save_connection(&c)?;
            audit(&st, Category::ConnectionCreated, Outcome::Success, Some(&c), |e| e.detail = Some("imported".into()));
            n += 1;
        }
    }
    Ok(n)
}

/// Parse `postgres://user@host:5432/db?sslmode=...` into a config. Any password in
/// the URL is returned separately so the UI can store it in the keychain.
#[derive(Serialize)]
pub struct ParsedUrl {
    config: ConnectionConfig,
    password: Option<String>,
}

#[tauri::command]
pub fn parse_connection_url(url: String) -> R<ParsedUrl> {
    check_len(&url, 4096, "URL")?;
    let (scheme, rest) = url.split_once("://").ok_or_else(|| DbError::invalid("not a connection URL"))?;
    let engine = match scheme.to_ascii_lowercase().as_str() {
        "postgres" | "postgresql" => Engine::Postgres,
        "mysql" => Engine::MySql,
        "mariadb" => Engine::MariaDb,
        "redis" | "rediss" => Engine::Redis,
        "sqlite" | "file" => Engine::Sqlite,
        "cockroachdb" => Engine::CockroachDb,
        _ => return Err(DbError::unsupported(&format!("URL scheme {scheme}"))),
    };
    let mut cfg = ConnectionConfig {
        id: Uuid::nil(),
        name: String::new(),
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
        tunnel: None,
    };
    if engine == Engine::Sqlite {
        cfg.database = Some(rest.to_string());
        cfg.name = rest.rsplit('/').next().unwrap_or("sqlite").to_string();
        return Ok(ParsedUrl { config: cfg, password: None });
    }
    let (main, query) = rest.split_once('?').unwrap_or((rest, ""));
    let (auth_host, db) = main.split_once('/').unwrap_or((main, ""));
    let (auth, hostport) = match auth_host.rsplit_once('@') {
        Some((a, h)) => (Some(a), h),
        None => (None, auth_host),
    };
    let mut password = None;
    if let Some(a) = auth {
        let (u, p) = a.split_once(':').map(|(u, p)| (u, Some(p))).unwrap_or((a, None));
        cfg.username = Some(pct_decode(u)).filter(|s| !s.is_empty());
        password = p.map(pct_decode);
    }
    let (h, p) = match hostport.rsplit_once(':') {
        Some((h, p)) if !h.ends_with(']') || hostport.starts_with('[') => (h, Some(p)),
        _ => (hostport, None),
    };
    cfg.host = Some(h.to_string()).filter(|s| !s.is_empty());
    if let Some(p) = p {
        cfg.port = Some(p.parse().map_err(|_| DbError::invalid("invalid port"))?);
    }
    cfg.database = Some(pct_decode(db)).filter(|s| !s.is_empty());
    for kv in query.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        match (k, v) {
            ("sslmode" | "ssl-mode" | "ssl_mode", m) => {
                cfg.tls.mode = match m.to_ascii_lowercase().replace('_', "-").as_str() {
                    "disable" | "disabled" => TlsMode::Disabled,
                    "allow" | "prefer" | "preferred" => TlsMode::Preferred,
                    "require" | "required" => TlsMode::Required,
                    "verify-ca" => TlsMode::VerifyCa,
                    // verify-full / verify-identity, and anything unknown: the strictest mode.
                    _ => TlsMode::VerifyIdentity,
                }
            }
            // libpq certificate parameters (paths only; files are read at connect time).
            ("sslrootcert", p) if !p.is_empty() => cfg.tls.ca_cert_path = Some(pct_decode(p)),
            ("sslcert", p) if !p.is_empty() => cfg.tls.client_cert_path = Some(pct_decode(p)),
            ("sslkey", p) if !p.is_empty() => cfg.tls.client_key_path = Some(pct_decode(p)),
            _ => {}
        }
    }
    let has_mode = ["sslmode=", "ssl-mode=", "ssl_mode="].iter().any(|k| query.contains(k));
    if !has_mode {
        cfg.tls.mode = match scheme.to_ascii_lowercase().as_str() {
            "redis" => TlsMode::Disabled,
            "rediss" => TlsMode::VerifyIdentity,
            // libpq / MySQL client default.
            _ => TlsMode::Preferred,
        };
    }
    cfg.name = format!("{}@{}", cfg.database.clone().unwrap_or_default(), cfg.host.clone().unwrap_or_default());
    Ok(ParsedUrl { config: cfg, password })
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Open a fixed OS privacy settings pane (no user-controlled URL).
#[tauri::command]
pub fn open_privacy_settings(pane: String) -> R<()> {
    #[cfg(target_os = "macos")]
    {
        let url = match pane.as_str() {
            "local_network" => "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork",
            _ => return Err(DbError::invalid("unknown settings pane")),
        };
        std::process::Command::new("/usr/bin/open").arg(url).spawn().map_err(|e| DbError::new(ErrorKind::Io, e.to_string()))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pane;
        Err(DbError::unsupported("opening privacy settings on this platform"))
    }
}

// ---------------------------------------------------------------- sessions

#[derive(Serialize)]
pub struct SessionOpened {
    session_id: Uuid,
    server: ServerInfo,
    capabilities: Capabilities,
    policy: dbs_safety::SafetyPolicy,
    config: ConnectionConfig,
}

#[tauri::command]
pub async fn open_session(
    window: tauri::WebviewWindow,
    st: State<'_, AppState>,
    connection_id: Uuid,
    password: Option<String>,
    trust_host_key: Option<String>,
) -> R<SessionOpened> {
    let cfg = st.store.get_connection(connection_id)?;
    let secrets = resolve_secrets(&st, &cfg, password)?;
    let ssh_secrets = resolve_ssh_secrets(&st, &cfg, None, None)?;
    let t = Instant::now();
    let (conn, tunnel) = match connect(&st, &cfg, secrets, ssh_secrets, trust_host_key.as_deref()).await {
        Ok(c) => c,
        Err(e) => {
            audit(&st, Category::ConnectionFailed, Outcome::Failure, Some(&cfg), |ev| ev.error_kind = Some(e.kind));
            return Err(e);
        }
    };
    let server = conn.server_info().await?;
    let capabilities = conn.capabilities();
    let id = Uuid::new_v4();
    if trust_host_key.is_some() {
        audit(&st, Category::SecurityPolicyChanged, Outcome::Success, Some(&cfg), |e| {
            e.detail = Some(format!("trusted SSH host key {}", trust_host_key.clone().unwrap_or_default()))
        });
    }
    st.sessions
        .lock()
        .unwrap()
        .insert(id, Arc::new(Session { id, config: cfg.clone(), conn: Arc::from(conn), _tunnel: tunnel, owner: window.label().to_string() }));
    st.store.touch_connection(cfg.id)?;
    audit(&st, Category::ConnectionOpened, Outcome::Success, Some(&cfg), |e| {
        e.session_id = Some(id.to_string());
        e.duration_ms = Some(t.elapsed().as_millis() as u64);
    });
    Ok(SessionOpened { session_id: id, server, capabilities, policy: st.policy_for(&cfg), config: cfg })
}

#[tauri::command]
pub async fn close_session(window: tauri::WebviewWindow, st: State<'_, AppState>, session_id: String) -> R<()> {
    let s = st.session(&session_id)?;
    // A window may only disconnect the sessions it opened.
    if s.owner != window.label() {
        return Err(DbError::new(ErrorKind::Permission, "session belongs to another window"));
    }
    st.sessions.lock().unwrap().remove(&s.id);
    s.conn.close().await
}

#[tauri::command]
pub async fn ping_session(st: State<'_, AppState>, session_id: String) -> R<u64> {
    let s = st.session(&session_id)?;
    let t = Instant::now();
    s.conn.ping().await?;
    Ok(t.elapsed().as_millis() as u64)
}

// ---------------------------------------------------------------- metadata

#[tauri::command]
pub async fn list_databases(st: State<'_, AppState>, session_id: String) -> R<Vec<String>> {
    st.session(&session_id)?.conn.list_databases().await
}

#[tauri::command]
pub async fn list_schemas(st: State<'_, AppState>, session_id: String) -> R<Vec<String>> {
    st.session(&session_id)?.conn.list_schemas(None).await
}

#[tauri::command]
pub async fn use_schema(st: State<'_, AppState>, session_id: String, schema: String) -> R<()> {
    check_len(&schema, 128, "schema")?;
    st.session(&session_id)?.conn.use_schema(&schema).await
}

#[tauri::command]
pub async fn list_objects(st: State<'_, AppState>, session_id: String, schema: Option<String>) -> R<Vec<ObjectRef>> {
    st.session(&session_id)?.conn.list_objects(schema.as_deref()).await
}

#[tauri::command]
pub async fn describe_table(st: State<'_, AppState>, session_id: String, target: TableTarget) -> R<TableDescription> {
    st.session(&session_id)?.conn.describe_table(&target).await
}

#[tauri::command]
pub async fn object_ddl(st: State<'_, AppState>, session_id: String, object: ObjectRef) -> R<String> {
    st.session(&session_id)?.conn.object_ddl(&object).await
}

// ---------------------------------------------------------------- query

fn redis_risk(class: &str) -> Risk {
    match class {
        "read" => Risk::Read,
        "write" => Risk::Write,
        "destructive" => Risk::Destructive,
        "admin" => Risk::Admin,
        _ => Risk::Unknown,
    }
}

fn evaluate_for(st: &AppState, s: &Session, sql: &str) -> Evaluation {
    let policy = st.policy_for(&s.config);
    let id = s.config.id.to_string();
    if s.config.engine == Engine::Redis {
        let mut pos = 0;
        let statements = sql
            .lines()
            .enumerate()
            .filter_map(|(i, l)| {
                let start = pos;
                pos += l.len() + 1;
                let t = l.trim();
                if t.is_empty() || t.starts_with('#') {
                    return None;
                }
                let cmd = dbs_drivers::redis::tokenize_command(t).ok()?.into_iter().next()?;
                Some(Classified {
                    index: i,
                    verb: cmd.to_ascii_uppercase(),
                    risk: redis_risk(dbs_drivers::redis::classify_redis_command(&cmd)),
                    flags: vec![],
                    start,
                    end: start + l.len(),
                    excerpt: t.chars().take(200).collect(),
                })
            })
            .collect();
        return dbs_safety::evaluate_classified(statements, sql, &policy, &st.guard, &id, &s.config.name);
    }
    dbs_safety::evaluate(sql, s.conn.dialect(), &policy, &st.guard, &id, &s.config.name)
}

#[tauri::command]
pub fn evaluate_sql(st: State<'_, AppState>, session_id: String, sql: String) -> R<Evaluation> {
    check_len(&sql, 50 * 1024 * 1024, "SQL")?;
    let s = st.session(&session_id)?;
    Ok(evaluate_for(&st, &s, &sql))
}

#[tauri::command]
pub fn split_sql(engine: Engine, sql: String) -> R<Vec<(usize, usize)>> {
    check_len(&sql, 50 * 1024 * 1024, "SQL")?;
    Ok(dbs_safety::split_statements(&sql, Dialect::from(engine)).into_iter().map(|s| (s.start, s.end)).collect())
}

#[derive(Deserialize)]
pub struct RunSql {
    session_id: String,
    sql: String,
    /// Client-chosen id used for cancellation.
    query_id: String,
    confirm_token: Option<String>,
    typed_confirmation: Option<String>,
    max_rows: Option<usize>,
}

#[derive(Serialize)]
pub struct RunResult {
    results: Vec<StatementResult>,
    duration_ms: u64,
}

/// A run that passed the safety gate. Built only by [`authorize_run`]; both the
/// materialised (`run_sql`) and streaming (`run_sql_stream`) paths go through it.
struct AuthorizedRun {
    session: Arc<Session>,
    kinds: Vec<String>,
    max_risk: Risk,
    opts: ExecOptions,
}

/// The single SQL execution gate: size limits, classification, policy
/// (read-only / block / confirmation token / typed phrase) and the
/// denied/confirmed audit entries.
fn authorize_run(st: &AppState, req: &RunSql) -> R<AuthorizedRun> {
    check_len(&req.sql, 50 * 1024 * 1024, "SQL")?;
    check_len(&req.query_id, 100, "query id")?;
    let s = st.session(&req.session_id)?;
    let eval = evaluate_for(st, &s, &req.sql);
    let kinds: Vec<String> = eval.statements.iter().map(|c| c.verb.clone()).collect();
    let max_risk = eval.statements.iter().map(|c| c.risk).max().unwrap_or(Risk::Read);
    let cid = s.config.id.to_string();
    if let Err(msg) = dbs_safety::authorize(&eval, &st.guard, &cid, &req.sql, req.confirm_token.as_deref(), req.typed_confirmation.as_deref()) {
        let blocked = matches!(eval.decision, Decision::Block { .. });
        audit(st, Category::SafetyBlocked, Outcome::Denied, Some(&s.config), |e| {
            e.statement_kinds = Some(kinds.clone());
            e.query_text = Some(req.sql.clone());
            e.detail = Some(msg.clone());
        });
        return Err(DbError::new(if blocked { ErrorKind::PolicyBlocked } else { ErrorKind::ConfirmationRequired }, msg));
    }
    if matches!(eval.decision, Decision::Confirm { .. }) {
        audit(st, Category::SafetyConfirmed, Outcome::Success, Some(&s.config), |e| {
            e.statement_kinds = Some(kinds.clone());
            e.query_text = Some(req.sql.clone());
        });
    }
    let opts = ExecOptions {
        max_rows: req.max_rows.unwrap_or_else(|| st.max_rows()).clamp(1, 1_000_000),
        timeout_ms: s.config.query_timeout_secs.map(|t| t as u64 * 1000),
    };
    Ok(AuthorizedRun { session: s, kinds, max_risk, opts })
}

/// Audit + history entry for an executed run (success or failure).
fn record_run(st: &AppState, run: &AuthorizedRun, sql: &str, dur: u64, affected: u64, err: Option<&DbError>) {
    let s = &run.session;
    let kinds = &run.kinds;
    let cat = match run.max_risk {
        Risk::Schema | Risk::Destructive if kinds.iter().any(|k| matches!(k.as_str(), "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "RENAME" | "COMMENT")) => {
            Category::DdlExecuted
        }
        Risk::Admin if kinds.iter().any(|k| matches!(k.as_str(), "GRANT" | "REVOKE")) => Category::PrivilegeChange,
        Risk::Write | Risk::Destructive => Category::DmlExecuted,
        _ => Category::QueryExecuted,
    };
    audit(st, cat, if err.is_none() { Outcome::Success } else { Outcome::Failure }, Some(&s.config), |e| {
        e.session_id = Some(s.id.to_string());
        e.duration_ms = Some(dur);
        e.rows_affected = Some(affected);
        e.statement_kinds = Some(kinds.clone());
        e.query_text = Some(sql.to_string());
        e.error_kind = err.map(|e| e.kind);
    });
    let _ = st.store.add_history(
        &HistoryEntry {
            id: 0,
            connection_id: s.config.id.to_string(),
            ts: String::new(),
            sql: st.store_query_text(&s.config).then(|| sql.chars().take(100_000).collect()),
            duration_ms: Some(dur as i64),
            rows: Some(affected as i64),
            ok: err.is_none(),
            error: err.map(|e| e.message.chars().take(500).collect()),
        },
        2000,
    );
}

#[tauri::command]
pub async fn run_sql(st: State<'_, AppState>, req: RunSql) -> R<RunResult> {
    let run = authorize_run(&st, &req)?;
    let token = CancellationToken::new();
    st.running.lock().unwrap().insert(req.query_id.clone(), token.clone());
    let t = Instant::now();
    let res = run.session.conn.execute(&req.sql, &run.opts, token).await;
    st.running.lock().unwrap().remove(&req.query_id);
    let dur = t.elapsed().as_millis() as u64;
    let affected: u64 = res.as_ref().map(|r| r.iter().filter_map(|s| s.rows_affected).sum()).unwrap_or(0);
    record_run(&st, &run, &req.sql, dur, affected, res.as_ref().err());
    Ok(RunResult { results: res?, duration_ms: dur })
}

/// Messages the streaming run adds around the driver's [`StreamEvent`]s.
#[derive(Serialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEnd {
    /// Execution failed (after any events already delivered).
    Error { error: DbError },
    /// Always the last message.
    Done { duration_ms: u64, cancelled: bool },
}

#[derive(Serialize, Debug)]
#[serde(untagged)]
pub enum StreamMsg {
    Event(StreamEvent),
    End(StreamEnd),
}

/// Row batches the webview may hold unacknowledged before the backend waits.
const STREAM_ACK_WINDOW: u64 = 4;
/// Give up when the webview stops acknowledging (e.g. it was reloaded).
const STREAM_ACK_TIMEOUT: Duration = Duration::from_secs(120);
/// Driver → forwarder channel capacity (events). Together with the ack window
/// this bounds rows held in memory to roughly (capacity + window) × batch size.
const STREAM_CHANNEL_CAP: usize = 2;

/// Acknowledgement state for one streaming run.
#[derive(Default)]
pub struct StreamAcks {
    /// Number of row batches the webview has processed (highest seq + 1).
    acked: AtomicU64,
    notify: tokio::sync::Notify,
}

impl StreamAcks {
    pub fn ack(&self, seq: u64) {
        self.acked.fetch_max(seq.saturating_add(1), Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    /// Wait until batch `seq` may be sent (fewer than `window` batches outstanding).
    async fn wait_for(&self, seq: u64, window: u64, cancel: &CancellationToken, timeout: Duration) -> R<()> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if seq < self.acked.load(Ordering::SeqCst) + window {
                return Ok(());
            }
            tokio::select! {
                _ = &mut notified => {}
                _ = cancel.cancelled() => return Err(DbError::new(ErrorKind::Cancelled, "query cancelled")),
                _ = tokio::time::sleep_until(deadline) => {
                    return Err(DbError::new(ErrorKind::Timeout, "the results view stopped reading; stream aborted"));
                }
            }
        }
    }
}

#[derive(Default, Debug, PartialEq)]
struct ForwardStats {
    affected: u64,
    rows: u64,
    batches: u64,
}

/// Pump driver events to the webview with ack-based flow control. Returns when
/// the driver side closes the channel. On error the receiver is dropped (which
/// unblocks a driver waiting to send) and the caller cancels the query.
async fn forward_stream(
    mut rx: tokio::sync::mpsc::Receiver<StreamEvent>,
    acks: &StreamAcks,
    cancel: &CancellationToken,
    window: u64,
    ack_timeout: Duration,
    mut emit: impl FnMut(StreamMsg) -> R<()>,
) -> R<ForwardStats> {
    let mut stats = ForwardStats::default();
    while let Some(ev) = rx.recv().await {
        match &ev {
            StreamEvent::Rows { seq, rows, .. } => {
                acks.wait_for(*seq, window, cancel, ack_timeout).await?;
                stats.rows += rows.len() as u64;
                stats.batches += 1;
            }
            StreamEvent::StatementDone { rows_affected, .. } => stats.affected += rows_affected.unwrap_or(0),
            StreamEvent::ResultStart { .. } => {}
        }
        emit(StreamMsg::Event(ev))?;
    }
    Ok(stats)
}

/// Run a script through the streaming driver path, forwarding to `emit`.
/// Returns (driver result, forwarder result).
async fn stream_execution(
    conn: &dyn DatabaseConnection,
    sql: &str,
    opts: &ExecOptions,
    token: &CancellationToken,
    acks: &StreamAcks,
    emit: impl FnMut(StreamMsg) -> R<()>,
) -> (R<()>, R<ForwardStats>) {
    let (tx, rx) = tokio::sync::mpsc::channel(STREAM_CHANNEL_CAP);
    let sink = RowSink::new(tx, token.clone(), opts.max_rows);
    let exec = conn.execute_stream(sql, opts, token.clone(), sink);
    let fwd = async {
        let r = forward_stream(rx, acks, token, STREAM_ACK_WINDOW, STREAM_ACK_TIMEOUT, emit).await;
        if r.is_err() {
            // Nobody is reading any more: stop the query server-side too.
            token.cancel();
        }
        r
    };
    tokio::join!(exec, fwd)
}

/// Combine driver and forwarder outcomes into the run's error, if any. A
/// forwarding failure (webview gone / not reading) wins: the driver only saw
/// it as a cancellation.
fn stream_outcome(res: R<()>, fwd: &R<ForwardStats>) -> Option<DbError> {
    match (res, fwd) {
        (_, Err(e)) if e.kind != ErrorKind::Cancelled => Some(e.clone()),
        (Err(e), _) => Some(e),
        (Ok(()), Err(e)) => Some(e.clone()),
        (Ok(()), Ok(_)) => None,
    }
}

#[derive(Serialize)]
pub struct StreamSummary {
    duration_ms: u64,
    ok: bool,
}

/// Streaming `run_sql`: same gate, cancellation and audit, but rows are sent to
/// `on_event` in batches as they are read. Policy/confirmation failures reject
/// the invoke (nothing was executed); execution errors arrive as an `error`
/// message. The last message is always `done`.
#[tauri::command]
pub async fn run_sql_stream(st: State<'_, AppState>, req: RunSql, on_event: tauri::ipc::Channel<StreamMsg>) -> R<StreamSummary> {
    let run = authorize_run(&st, &req)?;
    let token = CancellationToken::new();
    let acks = Arc::new(StreamAcks::default());
    st.running.lock().unwrap().insert(req.query_id.clone(), token.clone());
    st.stream_acks.lock().unwrap().insert(req.query_id.clone(), acks.clone());
    let t = Instant::now();
    let emit = |m: StreamMsg| on_event.send(m).map_err(|e| DbError::internal(format!("results channel closed: {e}")));
    let (res, fwd) = stream_execution(&*run.session.conn, &req.sql, &run.opts, &token, &acks, emit).await;
    st.running.lock().unwrap().remove(&req.query_id);
    st.stream_acks.lock().unwrap().remove(&req.query_id);
    let dur = t.elapsed().as_millis() as u64;
    let affected = fwd.as_ref().map_or(0, |s| s.affected);
    let err = stream_outcome(res, &fwd);
    record_run(&st, &run, &req.sql, dur, affected, err.as_ref());
    let cancelled = err.as_ref().is_some_and(|e| e.kind == ErrorKind::Cancelled);
    if let Some(e) = &err {
        let _ = on_event.send(StreamMsg::End(StreamEnd::Error { error: e.clone() }));
    }
    let _ = on_event.send(StreamMsg::End(StreamEnd::Done { duration_ms: dur, cancelled }));
    Ok(StreamSummary { duration_ms: dur, ok: err.is_none() })
}

/// The webview processed row batch `seq` of a streaming run (flow control).
#[tauri::command]
pub fn ack_query_stream(st: State<'_, AppState>, query_id: String, seq: u64) -> R<()> {
    if let Some(a) = st.stream_acks.lock().unwrap().get(&query_id) {
        a.ack(seq);
    }
    Ok(())
}

#[tauri::command]
pub async fn cancel_query(st: State<'_, AppState>, query_id: String) -> R<bool> {
    let tok = st.running.lock().unwrap().get(&query_id).cloned();
    Ok(match tok {
        Some(t) => {
            t.cancel();
            true
        }
        None => false,
    })
}

#[tauri::command]
pub async fn explain_sql(
    st: State<'_, AppState>,
    session_id: String,
    sql: String,
    analyze: bool,
    confirm_token: Option<String>,
    typed_confirmation: Option<String>,
) -> R<ResultSet> {
    let s = st.session(&session_id)?;
    if analyze {
        // EXPLAIN ANALYZE executes the statement; run it through the policy.
        let full = format!("EXPLAIN ANALYZE {sql}");
        let eval = evaluate_for(&st, &s, &full);
        dbs_safety::authorize(&eval, &st.guard, &s.config.id.to_string(), &full, confirm_token.as_deref(), typed_confirmation.as_deref())
            .map_err(|m| DbError::new(ErrorKind::ConfirmationRequired, m))?;
    }
    s.conn.explain(&sql, analyze).await
}

// ---------------------------------------------------------------- table data

/// Every table read that accepts filters goes through this: "Raw SQL" filter
/// expressions are spliced into the WHERE clause, so they must pass the safety
/// validator (single boolean read expression) first. All other filters are
/// parameterised by `dbs_core::build_filter`.
pub(crate) fn check_filters(d: Dialect, filters: &[FilterCondition]) -> R<()> {
    if filters.len() > 200 {
        return Err(DbError::invalid("too many filters"));
    }
    for f in filters.iter().filter(|f| f.op == FilterOp::Raw) {
        let expr = match &f.value {
            Some(Value::Text(s)) => s.as_str(),
            _ => return Err(DbError::invalid("raw SQL filter needs an expression")),
        };
        dbs_safety::validate_filter_expression(expr, d).map_err(|m| DbError::new(ErrorKind::PolicyBlocked, m))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn fetch_table(st: State<'_, AppState>, session_id: String, target: TableTarget, page: PageRequest) -> R<ResultSet> {
    let s = st.session(&session_id)?;
    check_filters(s.conn.dialect(), &page.filters)?;
    s.conn.fetch_table(&target, &page).await
}

#[tauri::command]
pub async fn count_rows(st: State<'_, AppState>, session_id: String, target: TableTarget, filters: Vec<FilterCondition>) -> R<u64> {
    let s = st.session(&session_id)?;
    check_filters(s.conn.dialect(), &filters)?;
    s.conn.count_rows(&target, &filters).await
}

/// The SELECT the table view runs for this page/filter set, with literals
/// inlined, for display ("SQL" button in the filter bar). Never executed here.
#[tauri::command]
pub fn table_select_sql(st: State<'_, AppState>, session_id: String, target: TableTarget, page: PageRequest) -> R<String> {
    let s = st.session(&session_id)?;
    let d = s.conn.dialect();
    check_filters(d, &page.filters)?;
    page_query_preview(d, &target, &page)
}

/// Validate a raw SQL filter expression without running anything (live feedback in the filter bar).
#[tauri::command]
pub fn validate_filter_sql(st: State<'_, AppState>, session_id: String, expr: String) -> R<()> {
    let s = st.session(&session_id)?;
    dbs_safety::validate_filter_expression(&expr, s.conn.dialect()).map_err(|m| DbError::new(ErrorKind::PolicyBlocked, m))
}

#[derive(Serialize)]
pub struct ChangePreview {
    statements: Vec<String>,
    decision: Decision,
}

fn edit_policy_decision(st: &AppState, s: &Session, text: &str, changes: &[RowChange]) -> Decision {
    let policy = st.policy_for(&s.config);
    if policy.read_only {
        return Decision::Block { findings: vec![dbs_safety::Finding { statement: 0, risk: Risk::Write, reason: "connection is read-only".into() }] };
    }
    let risk = Risk::Write;
    if policy.confirm_at.is_some_and(|c| risk >= c) {
        Decision::Confirm {
            findings: vec![dbs_safety::Finding { statement: 0, risk, reason: format!("{} row change(s) on {} connection", changes.len(), policy.name) }],
            typed_phrase: None,
            token: st.guard.token(&s.config.id.to_string(), text),
        }
    } else {
        Decision::Allow
    }
}

#[tauri::command]
pub fn preview_changes(st: State<'_, AppState>, session_id: String, target: TableTarget, changes: Vec<RowChange>) -> R<ChangePreview> {
    let s = st.session(&session_id)?;
    if changes.len() > 100_000 {
        return Err(DbError::invalid("too many staged changes"));
    }
    let statements = s.conn.preview_changes(&target, &changes)?;
    let decision = edit_policy_decision(&st, &s, &statements.join(";\n"), &changes);
    Ok(ChangePreview { statements, decision })
}

#[tauri::command]
pub async fn apply_changes(
    st: State<'_, AppState>,
    session_id: String,
    target: TableTarget,
    changes: Vec<RowChange>,
    confirm_token: Option<String>,
) -> R<ApplyReport> {
    let s = st.session(&session_id)?;
    let text = s.conn.preview_changes(&target, &changes)?.join(";\n");
    match edit_policy_decision(&st, &s, &text, &changes) {
        Decision::Allow => {}
        Decision::Block { .. } => return Err(DbError::new(ErrorKind::PolicyBlocked, "connection is read-only")),
        Decision::Confirm { .. } => {
            if !confirm_token.is_some_and(|t| st.guard.verify(&s.config.id.to_string(), &text, &t)) {
                return Err(DbError::new(ErrorKind::ConfirmationRequired, "confirmation required for these changes"));
            }
        }
    }
    let t = Instant::now();
    let r = s.conn.apply_changes(&target, &changes).await;
    audit(&st, Category::DataEdited, if r.as_ref().is_ok_and(|r| r.committed) { Outcome::Success } else { Outcome::Failure }, Some(&s.config), |e| {
        e.object = Some(format!("{}.{}", target.schema.clone().unwrap_or_default(), target.table));
        e.duration_ms = Some(t.elapsed().as_millis() as u64);
        e.rows_affected = r.as_ref().ok().map(|r| r.rows_affected);
        e.error_kind = r.as_ref().err().map(|e| e.kind);
        e.detail = r.as_ref().ok().filter(|r| !r.conflicts.is_empty()).map(|r| format!("{} conflict(s); rolled back", r.conflicts.len()));
    });
    r
}

#[tauri::command]
pub fn copy_rows(columns: Vec<ColumnMeta>, rows: Vec<Vec<Value>>, options: dbs_io::ExportOptions) -> R<String> {
    if rows.len() > 1_000_000 {
        return Err(DbError::invalid("too many rows to copy"));
    }
    dbs_io::export_to_string(&columns, &rows, options)
}

// ---------------------------------------------------------------- files

#[derive(Serialize)]
pub struct PickedFile {
    grant: String,
    name: String,
    display_path: String,
}

/// Opens a native dialog in the backend. Returns an opaque grant id, or None if cancelled.
#[tauri::command]
pub async fn pick_file(
    app: tauri::AppHandle,
    st: State<'_, AppState>,
    save: bool,
    default_name: Option<String>,
    extensions: Vec<String>,
) -> R<Option<PickedFile>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut d = app.dialog().file();
    if !extensions.is_empty() {
        let exts: Vec<&str> = extensions.iter().map(String::as_str).filter(|e| e.chars().all(|c| c.is_ascii_alphanumeric())).collect();
        d = d.add_filter("Files", &exts);
    }
    if let Some(n) = default_name.as_deref().filter(|n| !n.contains(['/', '\\'])) {
        d = d.set_file_name(n);
    }
    if save {
        d.save_file(move |p| {
            let _ = tx.send(p);
        });
    } else {
        d.pick_file(move |p| {
            let _ = tx.send(p);
        });
    }
    let Some(fp) = rx.await.map_err(|_| DbError::internal("dialog closed"))? else { return Ok(None) };
    let path = fp.into_path().map_err(|_| DbError::invalid("unsupported file location"))?;
    let grant = Uuid::new_v4().to_string();
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let display_path = path.to_string_lossy().into_owned();
    st.grants.lock().unwrap().insert(grant.clone(), FileGrant { path, mode: if save { GrantMode::Write } else { GrantMode::Read } });
    Ok(Some(PickedFile { grant, name, display_path }))
}

/// Native "choose file" dialog for SSL key / certificate / CA files. Returns only the
/// chosen **path** (stored in the connection config; the driver reads the file at
/// connect time). The webview never receives file contents.
#[tauri::command]
pub async fn pick_cert_path(app: tauri::AppHandle, kind: String) -> R<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let (title, exts): (&str, &[&str]) = match kind.as_str() {
        "key" => ("Choose SSL client key", &["key", "pem", "p12", "pfx"]),
        "cert" => ("Choose SSL client certificate", &["crt", "pem", "cer", "p12", "pfx"]),
        "ca" => ("Choose SSL CA certificate", &["crt", "pem", "cer"]),
        _ => return Err(DbError::invalid("unknown certificate kind")),
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title(title).add_filter("Certificates and keys", exts).add_filter("All files", &["*"]).pick_file(move |p| {
        let _ = tx.send(p);
    });
    let Some(fp) = rx.await.map_err(|_| DbError::internal("dialog closed"))? else { return Ok(None) };
    let path = fp.into_path().map_err(|_| DbError::invalid("unsupported file location"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn open_writer(g: &FileGrant, gzip: bool) -> R<Box<dyn std::io::Write + Send>> {
    // Overwrite confirmation is handled by the native save dialog that issued the grant.
    let f = std::fs::File::create(&g.path).map_err(|e| DbError::new(ErrorKind::Io, e.to_string()))?;
    let w = std::io::BufWriter::new(f);
    Ok(if gzip { Box::new(flate2::write::GzEncoder::new(w, flate2::Compression::default())) } else { Box::new(w) })
}

#[derive(Serialize)]
pub struct ExportReport {
    pub(crate) rows: u64,
    pub(crate) path: String,
}

/// Reorder a page's cells to `header` by column name. Schemaless engines
/// (DynamoDB) can report different attribute sets per page; attributes not in the
/// first page's header are dropped, missing ones become NULL.
fn project_rows(header: &[ColumnMeta], cols: Vec<ColumnMeta>, rows: Vec<Vec<Value>>) -> Vec<Vec<Value>> {
    if cols.len() == header.len() && cols.iter().zip(header).all(|(a, b)| a.name == b.name) {
        return rows;
    }
    let idx: Vec<Option<usize>> = header.iter().map(|h| cols.iter().position(|c| c.name == h.name)).collect();
    rows.into_iter().map(|r| idx.iter().map(|i| i.and_then(|i| r.get(i).cloned()).unwrap_or(Value::Null)).collect()).collect()
}

#[tauri::command]
pub async fn export_table(
    st: State<'_, AppState>,
    session_id: String,
    target: TableTarget,
    filters: Vec<FilterCondition>,
    grant: String,
    options: dbs_io::ExportOptions,
    gzip: bool,
) -> R<ExportReport> {
    let s = st.session(&session_id)?;
    check_filters(s.conn.dialect(), &filters)?;
    let g = st.grant(&grant, GrantMode::Write)?;
    let mut opts = options;
    if opts.table.is_none() {
        opts.table = Some(target.clone());
    }
    if opts.dialect.is_none() {
        opts.dialect = Some(s.conn.dialect());
    }
    let w = open_writer(&g, gzip)?;
    let first = s.conn.fetch_table(&target, &PageRequest { offset: 0, limit: 5000, order_by: vec![], filters: filters.clone() }).await?;
    let mut ex = dbs_io::Exporter::begin(w, &first.columns, opts)?;
    ex.write_rows(&first.rows)?;
    let mut offset = first.rows.len() as u64;
    let mut last = first.rows.len();
    // Stable paging requires an order; use the primary key when available.
    let order: Vec<(String, SortDir)> =
        s.conn.describe_table(&target).await.map(|d| d.primary_key.into_iter().map(|c| (c, SortDir::Asc)).collect()).unwrap_or_default();
    while last == 5000 {
        let page = s.conn.fetch_table(&target, &PageRequest { offset, limit: 5000, order_by: order.clone(), filters: filters.clone() }).await?;
        last = page.rows.len();
        ex.write_rows(&project_rows(&first.columns, page.columns, page.rows))?;
        offset += last as u64;
    }
    let rows = ex.finish()?;
    audit(&st, Category::Export, Outcome::Success, Some(&s.config), |e| {
        e.object = Some(target.table.clone());
        e.rows_affected = Some(rows);
    });
    Ok(ExportReport { rows, path: g.path.to_string_lossy().into_owned() })
}

/// Export rows the UI already holds (the current grid page) to a file chosen in
/// a native save dialog. Same writer and options as `export_table`.
#[tauri::command]
pub fn export_rows(
    st: State<'_, AppState>,
    session_id: String,
    target: TableTarget,
    columns: Vec<ColumnMeta>,
    rows: Vec<Vec<Value>>,
    grant: String,
    options: dbs_io::ExportOptions,
) -> R<ExportReport> {
    if rows.len() > 1_000_000 {
        return Err(DbError::invalid("too many rows to export"));
    }
    let s = st.session(&session_id)?;
    let g = st.grant(&grant, GrantMode::Write)?;
    let mut opts = options;
    if opts.table.is_none() {
        opts.table = Some(target.clone());
    }
    if opts.dialect.is_none() {
        opts.dialect = Some(s.conn.dialect());
    }
    let mut ex = dbs_io::Exporter::begin(open_writer(&g, false)?, &columns, opts)?;
    for chunk in rows.chunks(5000) {
        ex.write_rows(chunk)?;
    }
    let n = ex.finish()?;
    audit(&st, Category::Export, Outcome::Success, Some(&s.config), |e| {
        e.object = Some(target.table.clone());
        e.rows_affected = Some(n);
    });
    Ok(ExportReport { rows: n, path: g.path.to_string_lossy().into_owned() })
}

#[tauri::command]
pub async fn export_query(
    st: State<'_, AppState>,
    session_id: String,
    sql: String,
    grant: String,
    options: dbs_io::ExportOptions,
    gzip: bool,
) -> R<ExportReport> {
    let s = st.session(&session_id)?;
    let g = st.grant(&grant, GrantMode::Write)?;
    let eval = evaluate_for(&st, &s, &sql);
    if eval.statements.iter().any(|c| c.risk > Risk::Read) {
        return Err(DbError::new(ErrorKind::PolicyBlocked, "only read-only queries can be exported"));
    }
    let res = s.conn.execute(&sql, &ExecOptions { max_rows: 5_000_000, timeout_ms: None }, CancellationToken::new()).await?;
    let rs = res.into_iter().rev().find_map(|r| r.result).ok_or_else(|| DbError::invalid("query returned no rows"))?;
    let mut ex = dbs_io::Exporter::begin(open_writer(&g, gzip)?, &rs.columns, options)?;
    for chunk in rs.rows.chunks(5000) {
        ex.write_rows(chunk)?;
    }
    let rows = ex.finish()?;
    audit(&st, Category::Export, Outcome::Success, Some(&s.config), |e| {
        e.rows_affected = Some(rows);
        e.query_text = Some(sql.clone());
    });
    Ok(ExportReport { rows, path: g.path.to_string_lossy().into_owned() })
}

const MAX_IMPORT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[tauri::command]
pub fn import_preview(st: State<'_, AppState>, grant: String, options: dbs_io::ImportOptions) -> R<dbs_io::ImportPreview> {
    let g = st.grant(&grant, GrantMode::Read)?;
    let f = std::fs::File::open(&g.path).map_err(|e| DbError::new(ErrorKind::Io, e.to_string()))?;
    dbs_io::RecordReader::open(f, options, MAX_IMPORT_BYTES)?.preview(100)
}

#[derive(Deserialize)]
pub struct ImportRun {
    session_id: String,
    grant: String,
    options: dbs_io::ImportOptions,
    target: TableTarget,
    mapping: Vec<dbs_io::ColumnMapping>,
    create_table: bool,
    /// Stop on the first error (and roll back everything) vs. skip bad batches.
    #[serde(default = "yes")]
    atomic: bool,
    confirm_token: Option<String>,
}

#[derive(Serialize)]
pub struct ImportReport {
    rows_imported: u64,
    batches_failed: Vec<(u64, String)>,
    committed: bool,
    confirm: Option<Decision>,
}

#[tauri::command]
pub async fn import_run(st: State<'_, AppState>, req: ImportRun) -> R<ImportReport> {
    let s = st.session(&req.session_id)?;
    let g = st.grant(&req.grant, GrantMode::Read)?;
    let d = s.conn.dialect();
    // Policy: importing is a write. Bind the token to target+mapping.
    let token_text = format!("IMPORT INTO {} {}", d.qualified(&req.target)?, serde_json::to_string(&req.mapping).unwrap_or_default());
    let policy = st.policy_for(&s.config);
    if policy.read_only {
        return Err(DbError::new(ErrorKind::PolicyBlocked, "connection is read-only"));
    }
    if policy.confirm_at.is_some_and(|c| Risk::Write >= c)
        && !req.confirm_token.as_deref().is_some_and(|t| st.guard.verify(&s.config.id.to_string(), &token_text, t))
    {
        return Ok(ImportReport {
            rows_imported: 0,
            batches_failed: vec![],
            committed: false,
            confirm: Some(Decision::Confirm {
                findings: vec![dbs_safety::Finding {
                    statement: 0,
                    risk: Risk::Write,
                    reason: format!("import into {} ({} environment)", req.target.table, policy.name),
                }],
                typed_phrase: None,
                token: st.guard.token(&s.config.id.to_string(), &token_text),
            }),
        });
    }
    let f = std::fs::File::open(&g.path).map_err(|e| DbError::new(ErrorKind::Io, e.to_string()))?;
    let batch_size = req.options.batch_size.clamp(1, 5000);
    let mut rdr = dbs_io::RecordReader::open(f, req.options, MAX_IMPORT_BYTES)?;
    if req.create_table {
        s.conn.execute_params(&GeneratedStatement { sql: dbs_io::create_table_sql(d, &req.target, &req.mapping)?, params: vec![] }).await?;
    }
    let caps = s.conn.capabilities();
    let use_tx = caps.transactions && req.atomic;
    if use_tx {
        s.conn.begin().await?;
    }
    let mut rows = 0u64;
    let mut failed = Vec::new();
    let mut batch = Vec::with_capacity(batch_size);
    let mut batch_no = 0u64;
    loop {
        let rec = rdr.next_record();
        let done = rec.is_none();
        if let Some(r) = rec {
            match r {
                Ok(cells) => batch.push(cells),
                Err(e) => {
                    if use_tx {
                        let _ = s.conn.rollback().await;
                        return Err(e);
                    }
                    failed.push((rdr.line, e.message));
                    continue;
                }
            }
        }
        if batch.len() >= batch_size || (done && !batch.is_empty()) {
            batch_no += 1;
            let stmt = dbs_io::build_insert_batch(d, &req.target, &req.mapping, &batch)?;
            match s.conn.execute_params(&stmt).await {
                Ok(n) => rows += n,
                Err(e) => {
                    if use_tx {
                        let _ = s.conn.rollback().await;
                        audit(&st, Category::Import, Outcome::Failure, Some(&s.config), |ev| {
                            ev.object = Some(req.target.table.clone());
                            ev.error_kind = Some(e.kind);
                        });
                        return Err(DbError::new(e.kind, format!("batch {batch_no}: {}", e.message)));
                    }
                    failed.push((batch_no, e.message));
                }
            }
            batch.clear();
        }
        if done {
            break;
        }
    }
    if use_tx {
        s.conn.commit().await?;
    }
    audit(&st, Category::Import, if failed.is_empty() { Outcome::Success } else { Outcome::Failure }, Some(&s.config), |e| {
        e.object = Some(req.target.table.clone());
        e.rows_affected = Some(rows);
    });
    Ok(ImportReport { rows_imported: rows, batches_failed: failed, committed: true, confirm: None })
}

// ---------------------------------------------------------------- schema diff / designer

#[tauri::command]
pub async fn schema_snapshot(st: State<'_, AppState>, session_id: String, schema: Option<String>) -> R<Vec<TableDescription>> {
    let s = st.session(&session_id)?;
    let objs = s.conn.list_objects(schema.as_deref()).await?;
    let mut out = Vec::new();
    for o in objs.into_iter().filter(|o| o.kind == ObjectKind::Table).take(5000) {
        out.push(s.conn.describe_table(&TableTarget { schema: o.schema.clone(), table: o.name.clone() }).await?);
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct DiffResult {
    changes: Vec<dbs_schema::Change>,
    migration: Option<dbs_schema::Migration>,
    plan_error: Option<DbError>,
    forward_sql: Option<String>,
    reverse_sql: Option<String>,
}

#[tauri::command]
pub async fn schema_diff(
    st: State<'_, AppState>,
    source_session: String,
    source_schema: Option<String>,
    target_session: String,
    target_schema: Option<String>,
    include_drops: bool,
) -> R<DiffResult> {
    let src = schema_snapshot(st.clone(), source_session, source_schema).await?;
    let tgt_s = st.session(&target_session)?;
    let tgt = schema_snapshot(st.clone(), target_session, target_schema.clone()).await?;
    let opts = dbs_schema::DiffOptions {
        ignore_schema_names: true,
        target_schema: target_schema.or_else(|| tgt.first().and_then(|t| t.object.schema.clone())),
        include_drops,
    };
    let changes = dbs_schema::diff(&src, &tgt, &opts);
    let (migration, plan_error) = match dbs_schema::plan(tgt_s.conn.dialect(), &changes, &tgt) {
        Ok(m) => (Some(m), None),
        Err(e) => (None, Some(e)),
    };
    Ok(DiffResult {
        forward_sql: migration.as_ref().map(|m| m.forward_script()),
        reverse_sql: migration.as_ref().and_then(|m| m.reverse_script()),
        changes,
        migration,
        plan_error,
    })
}

#[tauri::command]
pub async fn designer_preview(
    st: State<'_, AppState>,
    session_id: String,
    original: Option<TableTarget>,
    edited: TableDescription,
    renames: Vec<(String, String)>,
) -> R<dbs_schema::Migration> {
    let s = st.session(&session_id)?;
    let orig = match original {
        Some(t) => Some(s.conn.describe_table(&t).await?),
        None => None,
    };
    dbs_schema::designer_migration(s.conn.dialect(), orig.as_ref(), &edited, &renames)
}

/// Runs a reviewed migration script. The safety policy is evaluated on the exact
/// script the user saw; the backend then adds a transaction wrapper where the
/// engine supports transactional DDL (not MySQL, whose DDL auto-commits).
#[tauri::command]
pub async fn run_migration(
    st: State<'_, AppState>,
    session_id: String,
    sql: String,
    confirm_token: Option<String>,
    typed_confirmation: Option<String>,
) -> R<RunResult> {
    check_len(&sql, 50 * 1024 * 1024, "SQL")?;
    let s = st.session(&session_id)?;
    let eval = evaluate_for(&st, &s, &sql);
    let cid = s.config.id.to_string();
    if let Err(msg) = dbs_safety::authorize(&eval, &st.guard, &cid, &sql, confirm_token.as_deref(), typed_confirmation.as_deref()) {
        audit(&st, Category::SafetyBlocked, Outcome::Denied, Some(&s.config), |e| e.detail = Some(msg.clone()));
        return Err(DbError::new(
            if matches!(eval.decision, Decision::Block { .. }) { ErrorKind::PolicyBlocked } else { ErrorKind::ConfirmationRequired },
            msg,
        ));
    }
    let script = if s.conn.dialect() == Dialect::MySql || !s.conn.capabilities().transactions { sql.clone() } else { format!("BEGIN;\n{sql}\nCOMMIT;") };
    let t = Instant::now();
    let res = s.conn.execute(&script, &ExecOptions { max_rows: 100, timeout_ms: None }, CancellationToken::new()).await;
    if res.is_err() && script != sql {
        let _ = s.conn.rollback().await;
    }
    let dur = t.elapsed().as_millis() as u64;
    audit(&st, Category::DdlExecuted, if res.is_ok() { Outcome::Success } else { Outcome::Failure }, Some(&s.config), |e| {
        e.duration_ms = Some(dur);
        e.statement_kinds = Some(eval.statements.iter().map(|c| c.verb.clone()).collect());
        e.query_text = Some(sql.clone());
        e.error_kind = res.as_ref().err().map(|e| e.kind);
    });
    Ok(RunResult { results: res?, duration_ms: dur })
}

// ---------------------------------------------------------------- monitoring

#[tauri::command]
pub async fn list_db_sessions(st: State<'_, AppState>, session_id: String) -> R<Vec<SessionInfo>> {
    st.session(&session_id)?.conn.list_sessions().await
}

#[tauri::command]
pub async fn kill_db_session(st: State<'_, AppState>, session_id: String, target_id: String, confirm_token: Option<String>) -> R<serde_json::Value> {
    let s = st.session(&session_id)?;
    if st.policy_for(&s.config).read_only {
        return Err(DbError::new(ErrorKind::PolicyBlocked, "connection is read-only"));
    }
    let text = format!("TERMINATE SESSION {target_id}");
    let cid = s.config.id.to_string();
    if !confirm_token.as_deref().is_some_and(|t| st.guard.verify(&cid, &text, t)) {
        return Ok(serde_json::json!({ "confirm": { "token": st.guard.token(&cid, &text), "message": format!("Terminate session {target_id}?") } }));
    }
    let r = s.conn.kill_session(&target_id).await;
    audit(&st, Category::SessionKilled, if r.is_ok() { Outcome::Success } else { Outcome::Failure }, Some(&s.config), |e| e.object = Some(target_id.clone()));
    r.map(|_| serde_json::json!({ "ok": true }))
}

// ---------------------------------------------------------------- audit

#[tauri::command]
pub fn audit_query(st: State<'_, AppState>, filter: AuditFilter) -> R<Vec<AuditEntry>> {
    st.audit.query(&filter)
}

#[tauri::command]
pub fn audit_verify(st: State<'_, AppState>) -> R<VerifyReport> {
    st.audit.verify()
}

#[tauri::command]
pub fn audit_export(st: State<'_, AppState>, filter: AuditFilter, grant: String) -> R<u64> {
    let g = st.grant(&grant, GrantMode::Write)?;
    let s = st.audit.export_jsonl(&filter)?;
    std::fs::write(&g.path, &s).map_err(|e| DbError::new(ErrorKind::Io, e.to_string()))?;
    audit(&st, Category::AuditExported, Outcome::Success, None, |_| {});
    Ok(s.lines().count() as u64)
}

#[tauri::command]
pub fn audit_purge(st: State<'_, AppState>, before: String) -> R<u64> {
    chrono::DateTime::parse_from_rfc3339(&before).map_err(|_| DbError::invalid("timestamp must be RFC 3339"))?;
    st.audit.purge_before(&before)
}

// ---------------------------------------------------------------- settings / snippets / history / documents

const SETTING_PREFIXES: &[&str] = &[
    "appearance.",
    "editor.",
    "grid.",
    "query.",
    "privacy.",
    "safety.",
    "audit.",
    "keys.",
    "workspace.",
    "ai.",
    "updates.",
    "a11y.",
    "general.",
    "io.",
    "backup.",
];

#[tauri::command]
pub fn get_settings(st: State<'_, AppState>) -> R<serde_json::Map<String, serde_json::Value>> {
    st.store.all_settings()
}

#[tauri::command]
pub fn set_setting(st: State<'_, AppState>, key: String, value: serde_json::Value) -> R<()> {
    if !SETTING_PREFIXES.iter().any(|p| key.starts_with(p)) {
        return Err(DbError::invalid("unknown setting"));
    }
    check_len(&value.to_string(), 1024 * 1024, "setting")?;
    if key.starts_with("updates.") {
        crate::updater::validate_setting(&key, &value)?;
    }
    if key.starts_with("safety.") {
        // Validate shape; refuse to weaken production below "confirm writes".
        if key == "safety.policy.production" {
            let p: dbs_safety::SafetyPolicy = serde_json::from_value(value.clone()).map_err(|e| DbError::invalid(e.to_string()))?;
            if !p.read_only && !p.confirm_at.is_some_and(|c| c <= Risk::Write) {
                return Err(DbError::invalid("production policy must at least confirm writes"));
            }
        }
        audit(&st, Category::SecurityPolicyChanged, Outcome::Success, None, |e| e.detail = Some(key.clone()));
    } else if key.starts_with("ai.") {
        crate::ai::on_setting_change(&st, &key, &value)?;
        // Turning the assistant on/off or changing literal redaction is a privacy decision.
        let cat = if key == dbs_ai::KEY_ENABLED || key == dbs_ai::KEY_REDACT_LITERALS { Category::SecurityPolicyChanged } else { Category::SettingsChanged };
        audit(&st, cat, Outcome::Success, None, |e| e.detail = Some(format!("{key}={value}")));
    } else if key.starts_with("privacy.") || key.starts_with("audit.") || key.starts_with("updates.endpoint.") {
        audit(&st, Category::SecurityPolicyChanged, Outcome::Success, None, |e| e.detail = Some(key.clone()));
    } else {
        audit(&st, Category::SettingsChanged, Outcome::Success, None, |e| e.detail = Some(key.clone()));
    }
    if key == "audit.queryText" {
        let p: dbs_audit::QueryTextPolicy = serde_json::from_value(value.clone()).map_err(|e| DbError::invalid(e.to_string()))?;
        *st.audit.query_policy.lock().unwrap() = p;
    }
    st.store.set_setting(&key, &value)
}

#[tauri::command]
pub fn reset_settings(st: State<'_, AppState>) -> R<()> {
    audit(&st, Category::SettingsChanged, Outcome::Success, None, |e| e.detail = Some("reset all".into()));
    *st.audit.query_policy.lock().unwrap() = Default::default();
    st.store.reset_settings()
}

#[tauri::command]
pub fn list_snippets(st: State<'_, AppState>) -> R<Vec<Snippet>> {
    st.store.list_snippets()
}

#[tauri::command]
pub fn save_snippet(st: State<'_, AppState>, snippet: Snippet) -> R<Snippet> {
    check_len(&snippet.sql, 5 * 1024 * 1024, "snippet")?;
    st.store.save_snippet(snippet)
}

#[tauri::command]
pub fn delete_snippet(st: State<'_, AppState>, id: String) -> R<()> {
    st.store.delete_snippet(&id)
}

#[tauri::command]
pub fn list_history(st: State<'_, AppState>, connection_id: String, limit: u32) -> R<Vec<HistoryEntry>> {
    st.store.list_history(&connection_id, limit.min(5000))
}

#[tauri::command]
pub fn clear_history(st: State<'_, AppState>, connection_id: Option<String>) -> R<()> {
    st.store.clear_history(connection_id.as_deref())
}

#[tauri::command]
pub fn list_documents(st: State<'_, AppState>, kind: String) -> R<Vec<Document>> {
    st.store.list_documents(&kind)
}

#[tauri::command]
pub fn save_document(st: State<'_, AppState>, kind: String, id: String, name: String, body: serde_json::Value) -> R<()> {
    // Dashboards/workspaces must never embed secrets.
    let s = body.to_string().to_ascii_lowercase();
    if s.contains("\"password\"") || s.contains("\"secret\"") {
        return Err(DbError::invalid("documents must not contain credentials"));
    }
    st.store.save_document(&kind, &id, &name, &body)
}

#[tauri::command]
pub fn delete_document(st: State<'_, AppState>, kind: String, id: String) -> R<()> {
    st.store.delete_document(&kind, &id)
}

// ---------------------------------------------------------------- backup

#[tauri::command]
pub fn backup_tools() -> Vec<crate::backup::ToolStatus> {
    crate::backup::tool_status()
}

#[tauri::command]
pub async fn run_backup(st: State<'_, AppState>, session_id: String, grant: String, options: crate::backup::BackupOptions) -> R<crate::backup::BackupReport> {
    let s = st.session(&session_id)?;
    let g = st.grant(&grant, GrantMode::Write)?;
    let secrets = resolve_secrets(&st, &s.config, None)?;
    let t = Instant::now();
    let r = crate::backup::backup(&s.config, secrets, &g.path, &options).await;
    audit(&st, Category::Backup, if r.is_ok() { Outcome::Success } else { Outcome::Failure }, Some(&s.config), |e| {
        e.duration_ms = Some(t.elapsed().as_millis() as u64);
        e.error_kind = r.as_ref().err().map(|e| e.kind);
        e.detail = Some(format!("{:?}", options.scope));
    });
    r
}

#[tauri::command]
pub async fn run_restore(
    st: State<'_, AppState>,
    session_id: String,
    grant: String,
    confirm_token: Option<String>,
    typed_confirmation: Option<String>,
) -> R<crate::backup::BackupReport> {
    let s = st.session(&session_id)?;
    let g = st.grant(&grant, GrantMode::Read)?;
    let policy = st.policy_for(&s.config);
    if policy.read_only {
        return Err(DbError::new(ErrorKind::PolicyBlocked, "connection is read-only"));
    }
    // Restore is always treated as destructive.
    let text = format!("RESTORE {} INTO {}", g.path.display(), s.config.name);
    let cid = s.config.id.to_string();
    let ok_token = confirm_token.as_deref().is_some_and(|t| st.guard.verify(&cid, &text, t));
    let ok_typed = !s.config.is_production() || typed_confirmation.as_deref().map(str::trim) == Some(s.config.name.as_str());
    if !ok_token || !ok_typed {
        return Err(DbError::new(ErrorKind::ConfirmationRequired, "restore requires confirmation").with_hint(st.guard.token(&cid, &text)));
    }
    let secrets = resolve_secrets(&st, &s.config, None)?;
    let t = Instant::now();
    let r = crate::backup::restore(&s.config, secrets, &g.path).await;
    audit(&st, Category::Restore, if r.is_ok() { Outcome::Success } else { Outcome::Failure }, Some(&s.config), |e| {
        e.duration_ms = Some(t.elapsed().as_millis() as u64);
        e.error_kind = r.as_ref().err().map(|e| e.kind);
    });
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_parsing_splits_password_and_forces_verification() {
        let p = parse_connection_url("postgresql://bob:p%40ss@db.example.com:6543/app?sslmode=require".into()).unwrap();
        assert_eq!(p.password.as_deref(), Some("p@ss"));
        assert_eq!(p.config.username.as_deref(), Some("bob"));
        assert_eq!(p.config.host.as_deref(), Some("db.example.com"));
        assert_eq!(p.config.port, Some(6543));
        assert_eq!(p.config.database.as_deref(), Some("app"));
        assert_eq!(p.config.tls.mode, TlsMode::Required);
        let p = parse_connection_url("mysql://root@localhost/x".into()).unwrap();
        assert_eq!(p.config.tls.mode, TlsMode::Preferred);
        assert!(parse_connection_url("javascript://alert(1)".into()).is_err());
    }

    // ---- streaming run: shared gate, audit, flow control

    fn test_state() -> AppState {
        AppState {
            store: dbs_store::AppStore::open_in_memory().unwrap(),
            audit: dbs_audit::AuditLog::open_in_memory("test").unwrap(),
            secrets: Box::new(dbs_secrets::MemoryStore::default()),
            session_secrets: Default::default(),
            guard: dbs_safety::ConfirmationGuard::new([7u8; 32]),
            ai_guard: dbs_ai::PromptGuard::new([8u8; 32]),
            sessions: Default::default(),
            running: Default::default(),
            stream_acks: Default::default(),
            grants: Default::default(),
            known_hosts: std::path::PathBuf::from("/nonexistent/known_hosts"),
            plugins: crate::plugins::PluginHost::new(std::env::temp_dir().join(format!("lotr-plugins-{}", Uuid::new_v4()))).unwrap(),
        }
    }

    async fn sqlite_session(st: &AppState, dir: &std::path::Path, env: EnvironmentKind, read_only: bool) -> String {
        let path = dir.join(format!("s{}.db", Uuid::new_v4()));
        std::fs::write(&path, b"").unwrap(); // an empty file is a valid, empty database
        {
            let tmp = dbs_drivers::sqlite::SqliteConnection::open(path.to_str().unwrap(), false).unwrap();
            tmp.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)", &ExecOptions::default(), CancellationToken::new()).await.unwrap();
        }
        let mut cfg = parse_connection_url(format!("sqlite://{}", path.display())).unwrap().config;
        cfg.id = Uuid::new_v4();
        cfg.environment = env;
        cfg.read_only = read_only;
        let (conn, _) = connect(st, &cfg, ConnectSecrets::default(), dbs_ssh::SshSecrets::default(), None).await.unwrap();
        let id = Uuid::new_v4();
        st.sessions.lock().unwrap().insert(id, Arc::new(Session { id, config: cfg, conn: Arc::from(conn), _tunnel: None, owner: "main".into() }));
        id.to_string()
    }

    fn req(session_id: &str, sql: &str) -> RunSql {
        RunSql {
            session_id: session_id.into(),
            sql: sql.into(),
            query_id: Uuid::new_v4().to_string(),
            confirm_token: None,
            typed_confirmation: None,
            max_rows: None,
        }
    }

    /// The steps of `run_sql_stream`, with an auto-acknowledging "webview".
    async fn run_streamed(st: &AppState, r: &RunSql) -> R<(Vec<serde_json::Value>, Option<DbError>)> {
        let run = authorize_run(st, r)?;
        let token = CancellationToken::new();
        let acks = StreamAcks::default();
        let mut msgs = Vec::new();
        let (res, fwd) = stream_execution(&*run.session.conn, &r.sql, &run.opts, &token, &acks, |m| {
            if let StreamMsg::Event(StreamEvent::Rows { seq, .. }) = &m {
                acks.ack(*seq);
            }
            msgs.push(serde_json::to_value(&m).unwrap());
            Ok(())
        })
        .await;
        let affected = fwd.as_ref().map_or(0, |s| s.affected);
        let err = stream_outcome(res, &fwd);
        record_run(st, &run, &r.sql, 1, affected, err.as_ref());
        Ok((msgs, err))
    }

    fn audit_categories(st: &AppState) -> Vec<(Category, Outcome)> {
        st.audit.query(&AuditFilter::default()).unwrap().into_iter().map(|e| (e.category, e.outcome)).collect()
    }

    #[tokio::test]
    async fn stream_run_goes_through_gate_and_audit() {
        let dir = tempfile::tempdir().unwrap();
        let st = test_state();
        let sid = sqlite_session(&st, dir.path(), EnvironmentKind::Development, false).await;
        let (msgs, err) = run_streamed(
            &st,
            &req(&sid, "INSERT INTO t (v) VALUES ('a'),('b'); WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n < 1500) SELECT n FROM s"),
        )
        .await
        .unwrap();
        assert!(err.is_none(), "{err:?}");
        let types: Vec<&str> = msgs.iter().map(|m| m["type"].as_str().unwrap()).collect();
        assert_eq!(types, vec!["statement_done", "result_start", "rows", "rows", "statement_done"]);
        assert_eq!(msgs[0]["rows_affected"], 2);
        assert_eq!(msgs[2]["rows"].as_array().unwrap().len(), FIRST_BATCH_ROWS);
        assert_eq!(msgs[2]["rows"][0], serde_json::json!([1]), "compact row form");
        assert_eq!(msgs[4]["row_count"], 1500);
        let cats = audit_categories(&st);
        assert!(cats.contains(&(Category::DmlExecuted, Outcome::Success)), "{cats:?}");
        let cid = st.session(&sid).unwrap().config.id.to_string();
        assert_eq!(st.store.list_history(&cid, 10).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn stream_run_applies_max_rows_setting() {
        let dir = tempfile::tempdir().unwrap();
        let st = test_state();
        st.store.set_setting("query.maxRows", &serde_json::json!(700)).unwrap();
        let sid = sqlite_session(&st, dir.path(), EnvironmentKind::Development, false).await;
        let (msgs, err) =
            run_streamed(&st, &req(&sid, "WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n < 5000) SELECT n FROM s")).await.unwrap();
        assert!(err.is_none());
        let last = msgs.last().unwrap();
        assert_eq!(last["row_count"], 700);
        assert_eq!(last["truncated"], true);
    }

    #[tokio::test]
    async fn stream_run_is_blocked_on_read_only_and_needs_confirmation_in_production() {
        let dir = tempfile::tempdir().unwrap();
        let st = test_state();
        let ro = sqlite_session(&st, dir.path(), EnvironmentKind::Development, true).await;
        let e = run_streamed(&st, &req(&ro, "DELETE FROM t")).await.unwrap_err();
        assert_eq!(e.kind, ErrorKind::PolicyBlocked);
        assert!(audit_categories(&st).contains(&(Category::SafetyBlocked, Outcome::Denied)));

        let prod = sqlite_session(&st, dir.path(), EnvironmentKind::Production, false).await;
        let e = run_streamed(&st, &req(&prod, "DELETE FROM t")).await.unwrap_err();
        assert_eq!(e.kind, ErrorKind::ConfirmationRequired);
        // With the token issued by evaluation, it runs.
        let s = st.session(&prod).unwrap();
        let ev = evaluate_for(&st, &s, "DELETE FROM t");
        let Decision::Confirm { token, typed_phrase, .. } = ev.decision else { panic!("expected confirmation") };
        let mut r = req(&prod, "DELETE FROM t");
        r.confirm_token = Some(token);
        r.typed_confirmation = typed_phrase;
        let (_, err) = run_streamed(&st, &r).await.unwrap();
        assert!(err.is_none(), "{err:?}");
        assert!(audit_categories(&st).contains(&(Category::SafetyConfirmed, Outcome::Success)));
    }

    #[tokio::test]
    async fn stream_run_reports_execution_errors_after_partial_results() {
        let dir = tempfile::tempdir().unwrap();
        let st = test_state();
        let sid = sqlite_session(&st, dir.path(), EnvironmentKind::Development, false).await;
        let (msgs, err) = run_streamed(&st, &req(&sid, "SELECT 1 AS a; SELECT * FROM missing_table")).await.unwrap();
        assert_eq!(msgs.len(), 3, "first statement delivered: {msgs:?}");
        let e = err.expect("error");
        assert!(e.message.contains("statement 2"), "{e:?}");
        assert!(audit_categories(&st).contains(&(Category::QueryExecuted, Outcome::Failure)));
    }

    fn rows_ev(seq: u64) -> StreamEvent {
        StreamEvent::Rows { result_index: 0, seq, rows: vec![vec![Value::Int(seq as i64)]] }
    }

    #[tokio::test]
    async fn forwarder_waits_for_acks() {
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        let acks = Arc::new(StreamAcks::default());
        let cancel = CancellationToken::new();
        let sent = Arc::new(std::sync::Mutex::new(Vec::<u64>::new()));
        let producer = tokio::spawn(async move {
            for i in 0..10 {
                if tx.send(rows_ev(i)).await.is_err() {
                    return i;
                }
            }
            10
        });
        let (a2, s2, c2) = (acks.clone(), sent.clone(), cancel.clone());
        let fwd = tokio::spawn(async move {
            forward_stream(rx, &a2, &c2, 3, Duration::from_secs(30), |m| {
                if let StreamMsg::Event(StreamEvent::Rows { seq, .. }) = m {
                    s2.lock().unwrap().push(seq);
                }
                Ok(())
            })
            .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(*sent.lock().unwrap(), vec![0, 1, 2], "only `window` batches without acks");
        acks.ack(1);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(sent.lock().unwrap().len(), 5);
        acks.ack(9);
        let stats = fwd.await.unwrap().unwrap();
        assert_eq!(stats.batches, 10);
        assert_eq!(producer.await.unwrap(), 10);
    }

    #[tokio::test]
    async fn forwarder_stops_on_cancel_or_ack_timeout_and_releases_producer() {
        for cancel_it in [true, false] {
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            let acks = StreamAcks::default();
            let cancel = CancellationToken::new();
            let producer = tokio::spawn(async move {
                for i in 0..100 {
                    if tx.send(rows_ev(i)).await.is_err() {
                        return i;
                    }
                }
                100
            });
            if cancel_it {
                let c = cancel.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    c.cancel();
                });
            }
            let r = forward_stream(rx, &acks, &cancel, 2, Duration::from_millis(100), |_| Ok(())).await;
            let e = r.unwrap_err();
            assert_eq!(e.kind, if cancel_it { ErrorKind::Cancelled } else { ErrorKind::Timeout });
            // Receiver dropped: the producer is not left blocked.
            assert!(producer.await.unwrap() < 100);
        }
    }

    #[test]
    fn url_ssl_modes() {
        let mode = |u: &str| parse_connection_url(u.into()).unwrap().config.tls.mode;
        assert_eq!(mode("postgresql://h/db?sslmode=disable"), TlsMode::Disabled);
        assert_eq!(mode("postgresql://h/db?sslmode=prefer"), TlsMode::Preferred);
        assert_eq!(mode("postgresql://h/db?sslmode=verify-ca"), TlsMode::VerifyCa);
        assert_eq!(mode("postgresql://h/db?sslmode=verify-full"), TlsMode::VerifyIdentity);
        assert_eq!(mode("postgresql://h/db?sslmode=bogus"), TlsMode::VerifyIdentity);
        assert_eq!(mode("mysql://h/db?ssl-mode=DISABLED"), TlsMode::Disabled);
        assert_eq!(mode("mysql://h/db?ssl-mode=REQUIRED"), TlsMode::Required);
        assert_eq!(mode("mysql://h/db?ssl-mode=VERIFY_IDENTITY"), TlsMode::VerifyIdentity);
        assert_eq!(mode("redis://h"), TlsMode::Disabled);
        assert_eq!(mode("rediss://h"), TlsMode::VerifyIdentity);
        let p = parse_connection_url("postgresql://h/db?sslmode=verify-full&sslrootcert=/certs/ca.crt".into()).unwrap();
        assert_eq!(p.config.tls.ca_cert_path.as_deref(), Some("/certs/ca.crt"));
    }

    #[test]
    fn raw_filters_are_validated_before_reaching_a_driver() {
        let raw = |e: &str| FilterCondition { op: FilterOp::Raw, value: Some(Value::Text(e.into())), ..Default::default() };
        assert!(check_filters(Dialect::MySql, &[raw("age > 3")]).is_ok());
        let e = check_filters(Dialect::MySql, &[raw("1=1; DROP TABLE t")]).unwrap_err();
        assert_eq!(e.kind, ErrorKind::PolicyBlocked);
        assert!(check_filters(Dialect::Postgres, &[raw("id IN (DELETE FROM t RETURNING id)")]).is_err());
        assert!(check_filters(Dialect::Postgres, &[FilterCondition { op: FilterOp::Raw, value: None, ..Default::default() }]).is_err());
        // Non-raw filters are parameterised, so any value is fine here.
        let eq = FilterCondition { column: "a".into(), op: FilterOp::Eq, value: Some(Value::Text("1; DROP".into())), ..Default::default() };
        assert!(check_filters(Dialect::Postgres, &[eq]).is_ok());
    }

    #[test]
    fn pct_decode_handles_edge_cases() {
        assert_eq!(pct_decode("a%2"), "a%2");
        assert_eq!(pct_decode("%zz"), "%zz");
        assert_eq!(pct_decode("%41"), "A");
    }
}
