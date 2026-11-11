//! "Import connections" from other database tools (parsers live in `dbs-import`).
//!
//! The webview picks a source (detected on this machine, a file granted through the
//! native dialog, or pasted URLs), gets a preview without any secrets, and applies a
//! selection of row keys. Secrets found while parsing (passwords in URLs) and keychain
//! references stay in `AppState::import_preview`.

use std::collections::HashSet;

use dbs_audit::{Category, Outcome};
use dbs_core::*;
use dbs_import::load::{self, Env};
use dbs_import::{ImportedConnection, SourceKind};
use dbs_secrets::SecretKind;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use uuid::Uuid;

use crate::commands::{audit, check_len};
use crate::state::{AppState, GrantMode};

type R<T> = Result<T, DbError>;

/// Rows of the last preview, kept backend-side.
pub struct Preview {
    id: String,
    source: SourceKind,
    rows: Vec<ImportedConnection>,
}

#[derive(Serialize)]
pub struct DetectedSource {
    source: SourceKind,
    label: &'static str,
    count: usize,
    /// Why the source's files could not be read, if they couldn't.
    error: Option<String>,
}

fn detect(env: &Env) -> Vec<DetectedSource> {
    load::candidates(env)
        .into_iter()
        .map(|c| match load::load_candidate(&c, env) {
            Ok(rows) => DetectedSource { source: c.kind, label: c.kind.label(), count: rows.len(), error: None },
            Err(e) => DetectedSource { source: c.kind, label: c.kind.label(), count: 0, error: Some(e.message) },
        })
        .collect()
}

/// Sources with connection files in their default location on this machine.
#[tauri::command]
pub async fn import_connections_detect() -> R<Vec<DetectedSource>> {
    let env = Env::from_process();
    tauri::async_runtime::spawn_blocking(move || detect(&env)).await.map_err(|e| DbError::internal(e.to_string()))
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PreviewRequest {
    /// A detected source (read from its default location; the webview never names a path).
    Detected { source: SourceKind },
    /// A file the user picked with the native dialog (`pick_file` grant).
    File { grant: String },
    /// Pasted connection URLs, one per line.
    Urls { text: String },
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RowStatus {
    Ready,
    Exists,
    Unsupported,
    Invalid,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PasswordInfo {
    None,
    /// Part of the source data (e.g. a URL).
    Included,
    /// In the OS keychain, readable with the user's permission.
    Keychain,
}

/// What the preview table shows. Never contains a secret.
#[derive(Serialize, Debug)]
pub struct RowView {
    key: String,
    name: String,
    source_engine: String,
    engine: Option<Engine>,
    host: Option<String>,
    port: Option<u16>,
    database: Option<String>,
    username: Option<String>,
    environment: Option<EnvironmentKind>,
    group: Option<String>,
    ssh: bool,
    color: Option<String>,
    status: RowStatus,
    reason: Option<String>,
    notes: Vec<String>,
    password: PasswordInfo,
}

#[derive(Serialize)]
pub struct PreviewResult {
    preview_id: String,
    source: SourceKind,
    label: &'static str,
    passwords_supported: bool,
    rows: Vec<RowView>,
}

/// Identity used to spot connections that already exist.
type ConnKey = (Engine, String, Option<u16>, String, String);

fn conn_key(c: &ConnectionConfig) -> ConnKey {
    let norm = |s: &Option<String>| s.as_deref().unwrap_or("").trim().to_ascii_lowercase();
    (
        c.engine,
        norm(&c.host),
        c.effective_port(),
        c.database.as_deref().unwrap_or("").trim().to_string(),
        c.username.as_deref().unwrap_or("").trim().to_string(),
    )
}

fn row_status(r: &ImportedConnection, supported: &[Engine], existing: &HashSet<ConnKey>) -> (RowStatus, Option<String>) {
    let Some(cfg) = &r.config else {
        return match &r.error {
            Some(e) => (RowStatus::Invalid, Some(e.clone())),
            None => (RowStatus::Unsupported, None),
        };
    };
    if !supported.contains(&cfg.engine) {
        return (RowStatus::Unsupported, None);
    }
    if let Err(e) = cfg.validate() {
        return (RowStatus::Invalid, Some(e.message));
    }
    if existing.contains(&conn_key(cfg)) {
        return (RowStatus::Exists, None);
    }
    (RowStatus::Ready, None)
}

fn view(r: &ImportedConnection, supported: &[Engine], existing: &HashSet<ConnKey>, source: SourceKind) -> RowView {
    let (status, reason) = row_status(r, supported, existing);
    let c = r.config.as_ref();
    let password = if r.password.is_some() {
        PasswordInfo::Included
    } else if !r.keychain.is_empty() && source.passwords_supported() {
        PasswordInfo::Keychain
    } else {
        PasswordInfo::None
    };
    RowView {
        key: r.key.clone(),
        name: r.name.clone(),
        source_engine: r.source_engine.clone(),
        engine: c.map(|c| c.engine),
        host: c.and_then(|c| c.host.clone()),
        port: c.and_then(|c| c.port),
        database: c.and_then(|c| c.database.clone()),
        username: c.and_then(|c| c.username.clone()),
        environment: c.map(|c| c.environment),
        group: c.and_then(|c| c.group.clone()),
        ssh: c.is_some_and(|c| c.ssh.is_some()),
        color: c.and_then(|c| c.color.clone()),
        status,
        reason,
        notes: r.notes.clone(),
        password,
    }
}

fn existing_keys(st: &AppState) -> R<HashSet<ConnKey>> {
    Ok(st.store.list_connections()?.iter().map(|c| conn_key(&c.config)).collect())
}

fn read_source(st: &AppState, req: PreviewRequest, env: &Env) -> R<(SourceKind, Vec<ImportedConnection>)> {
    match req {
        PreviewRequest::Detected { source } => {
            let c = load::candidates(env)
                .into_iter()
                .find(|c| c.kind == source)
                .ok_or_else(|| DbError::new(ErrorKind::NotFound, format!("no {} connections found on this computer", source.label())))?;
            Ok((source, load::load_candidate(&c, env)?))
        }
        PreviewRequest::File { grant } => {
            let g = st.grant(&grant, GrantMode::Read)?;
            let data = load::read_capped(&g.path)?;
            let name = g.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let full = g.path.to_string_lossy().into_owned();
            let Some(kind) = load::sniff(&data, &full) else {
                if name.to_ascii_lowercase().ends_with(".tableplusconnection") {
                    return Err(DbError::unsupported("TablePlus export files (they are encrypted). Import from TablePlus on this computer instead"));
                }
                return Err(DbError::invalid("this file is not a connection list this app can read"));
            };
            Ok((kind, load::load_file(kind, &g.path, env)?))
        }
        PreviewRequest::Urls { text } => {
            check_len(&text, 1024 * 1024, "URL list")?;
            Ok((SourceKind::UrlList, dbs_import::urls::parse_list(&text)?))
        }
    }
}

/// Parses a source and returns rows for the preview table (no secrets).
#[tauri::command]
pub async fn import_connections_preview(app: tauri::AppHandle, request: PreviewRequest) -> R<PreviewResult> {
    tauri::async_runtime::spawn_blocking(move || preview(&app.state::<AppState>(), request, &Env::from_process()))
        .await
        .map_err(|e| DbError::internal(e.to_string()))?
}

pub(crate) fn preview(st: &AppState, request: PreviewRequest, env: &Env) -> R<PreviewResult> {
    let (source, rows) = read_source(st, request, env)?;
    let supported = dbs_drivers::supported_engines();
    let existing = existing_keys(st)?;
    let views = rows.iter().map(|r| view(r, &supported, &existing, source)).collect();
    let id = Uuid::new_v4().to_string();
    *st.import_preview.lock().unwrap() = Some(Preview { id: id.clone(), source, rows });
    Ok(PreviewResult { preview_id: id, source, label: source.label(), passwords_supported: source.passwords_supported(), rows: views })
}

#[derive(Deserialize, Debug, Clone, Copy)]
pub struct ApplyOptions {
    #[serde(default = "yes")]
    keep_groups: bool,
    #[serde(default = "yes")]
    keep_environment: bool,
    /// Bring passwords along (from the source data or, after the OS asks, its keychain items).
    #[serde(default)]
    import_passwords: bool,
}
fn yes() -> bool {
    true
}

#[derive(Deserialize)]
pub struct ApplyRequest {
    preview_id: String,
    keys: Vec<String>,
    options: ApplyOptions,
}

#[derive(Serialize, Debug)]
pub struct RowError {
    key: String,
    name: String,
    error: String,
}

#[derive(Serialize, Debug)]
pub struct ImportedRow {
    key: String,
    id: Uuid,
}

#[derive(Serialize, Debug, Default)]
pub struct ApplyResult {
    imported: Vec<ImportedRow>,
    failed: Vec<RowError>,
    passwords_imported: usize,
    password_errors: Vec<RowError>,
    groups_created: usize,
}

/// Saves the selected rows of the last preview as new connections.
#[tauri::command]
pub async fn import_connections_apply(app: tauri::AppHandle, request: ApplyRequest) -> R<ApplyResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        apply(&st, request, &|service, account| dbs_secrets::read_external_password(service, account))
    })
    .await
    .map_err(|e| DbError::internal(e.to_string()))?
}

type KeychainReader<'a> = &'a dyn Fn(&str, &str) -> DbResult<Option<dbs_secrets::Secret>>;

fn save_one(st: &AppState, row: &ImportedConnection, opts: ApplyOptions, supported: &[Engine]) -> R<ConnectionConfig> {
    let mut cfg = row.config.clone().ok_or_else(|| DbError::unsupported(&format!("the {} engine", row.source_engine)))?;
    if !supported.contains(&cfg.engine) {
        return Err(DbError::unsupported(&format!("the {} engine", row.source_engine)));
    }
    cfg.id = Uuid::new_v4();
    cfg.init_sql = None;
    if !opts.keep_groups {
        cfg.group = None;
    }
    if !opts.keep_environment {
        cfg.environment = dbs_import::default_environment(&cfg);
    }
    cfg.validate()?;
    st.store.save_connection(&cfg)?;
    Ok(cfg)
}

/// Copies the row's passwords into our keychain. Returns how many were stored;
/// `stop` is set after a keychain failure so the user isn't prompted again and again.
fn import_passwords(
    st: &AppState,
    row: &ImportedConnection,
    cfg: &ConnectionConfig,
    read: KeychainReader<'_>,
    stop: &mut bool,
    errors: &mut Vec<RowError>,
) -> usize {
    let mut n = 0;
    let err = |e: String| RowError { key: row.key.clone(), name: row.name.clone(), error: e };
    if let Some(p) = &row.password {
        match st.secrets.set(cfg.id, SecretKind::DbPassword, p.expose()) {
            Ok(()) => n += 1,
            Err(e) => errors.push(err(e.message)),
        }
    }
    for item in &row.keychain {
        if *stop {
            errors.push(err("not attempted after an earlier keychain error".into()));
            break;
        }
        match read(&item.service, &item.account) {
            Ok(Some(secret)) => match st.secrets.set(cfg.id, item.kind, secret.expose()) {
                Ok(()) => n += 1,
                Err(e) => errors.push(err(e.message)),
            },
            // Nothing saved in the source for this connection.
            Ok(None) => {}
            Err(e) => {
                *stop = true;
                errors.push(err(e.message));
            }
        }
    }
    if n > 0 {
        audit(st, Category::CredentialChanged, Outcome::Success, Some(cfg), |e| e.detail = Some("imported".into()));
    }
    n
}

pub(crate) fn apply(st: &AppState, req: ApplyRequest, read: KeychainReader<'_>) -> R<ApplyResult> {
    let guard = st.import_preview.lock().unwrap();
    let preview =
        guard.as_ref().filter(|p| p.id == req.preview_id).ok_or_else(|| DbError::invalid("the import preview is out of date; load the source again"))?;
    let supported = dbs_drivers::supported_engines();
    let groups_before: HashSet<String> = st.store.list_groups()?.into_iter().map(|g| g.name).collect();
    let wanted: HashSet<&str> = req.keys.iter().map(String::as_str).collect();
    let mut out = ApplyResult::default();
    let mut stop = false;
    for row in preview.rows.iter().filter(|r| wanted.contains(r.key.as_str())) {
        match save_one(st, row, req.options, &supported) {
            Ok(cfg) => {
                audit(st, Category::ConnectionCreated, Outcome::Success, Some(&cfg), |e| e.detail = Some("imported".into()));
                if req.options.import_passwords {
                    out.passwords_imported += import_passwords(st, row, &cfg, read, &mut stop, &mut out.password_errors);
                }
                out.imported.push(ImportedRow { key: row.key.clone(), id: cfg.id });
            }
            Err(e) => out.failed.push(RowError { key: row.key.clone(), name: row.name.clone(), error: e.message }),
        }
    }
    out.groups_created = st.store.list_groups()?.iter().filter(|g| !groups_before.contains(&g.name)).count();
    let source = serde_json::to_value(preview.source).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    drop(guard);
    let outcome = if out.imported.is_empty() && !out.failed.is_empty() { Outcome::Failure } else { Outcome::Success };
    audit(st, Category::ConnectionsImported, outcome, None, |e| {
        e.object = Some(source);
        e.rows_affected = Some(out.imported.len() as u64);
        e.detail = Some(format!(
            "imported={} failed={} passwords={} password_errors={} groups_created={}",
            out.imported.len(),
            out.failed.len(),
            out.passwords_imported,
            out.password_errors.len(),
            out.groups_created
        ));
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbs_audit::AuditFilter;

    const DBEAVER: &str = r#"{"connections":{
        "a":{"provider":"postgresql","driver":"postgres-jdbc","name":"Billing prod","folder":"Team","configuration":{"host":"billing.example.com","port":"5432","database":"billing","user":"bill","type":"prod","handlers":{"ssl":{"enabled":true,"properties":{"sslMode":"verify-full"}}}}},
        "b":{"provider":"postgresql","driver":"postgres-jdbc","name":"Plain prod","configuration":{"host":"plain.example.com","database":"x","type":"prod"}},
        "c":{"provider":"oracle","driver":"oracle_thin","name":"ERP","configuration":{"host":"erp.example.com"}},
        "d":{"provider":"mysql","driver":"mysql8","name":"Dup","configuration":{"host":"dup.example.com","port":"3306","database":"d","user":"u","type":"dev"}}
    }}"#;

    fn file_grant(st: &AppState, dir: &std::path::Path, name: &str, body: &str) -> String {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        let g = Uuid::new_v4().to_string();
        st.grants.lock().unwrap().insert(g.clone(), crate::state::FileGrant { path: p, mode: GrantMode::Read });
        g
    }

    #[test]
    fn preview_marks_statuses_and_apply_saves_selection() {
        let st = crate::commands::tests::test_state();
        // An existing connection matching row "d".
        let (mut dup, _) = dbs_import::urls::parse_url("mysql://u@dup.example.com:3306/d").unwrap();
        dup.id = Uuid::new_v4();
        dup.name = "Dup".into();
        st.store.save_connection(&dup).unwrap();

        let dir = std::env::temp_dir().join(format!("lotr-import-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let grant = file_grant(&st, &dir, "data-sources.json", DBEAVER);
        let env = Env::default();
        let p = preview(&st, PreviewRequest::File { grant }, &env).unwrap();
        assert_eq!(p.source, SourceKind::Dbeaver);
        let status = |name: &str| p.rows.iter().find(|r| r.name == name).unwrap().status;
        assert_eq!(status("Billing prod"), RowStatus::Ready);
        assert_eq!(status("Plain prod"), RowStatus::Invalid, "PREFERRED SSL for remote production fails validation");
        assert!(p.rows.iter().find(|r| r.name == "Plain prod").unwrap().reason.as_deref().unwrap().contains("SSL mode"));
        assert_eq!(status("ERP"), RowStatus::Unsupported);
        assert_eq!(status("Dup"), RowStatus::Exists);

        let keys: Vec<String> = p.rows.iter().map(|r| r.key.clone()).collect();
        let never = |_: &str, _: &str| -> DbResult<Option<dbs_secrets::Secret>> { panic!("no keychain reads for this source") };
        let res = apply(
            &st,
            ApplyRequest {
                preview_id: p.preview_id.clone(),
                keys,
                options: ApplyOptions { keep_groups: true, keep_environment: true, import_passwords: true },
            },
            &never,
        )
        .unwrap();
        assert_eq!(res.imported.len(), 2, "{res:?}"); // Billing prod + Dup (explicitly selected)
        assert_eq!(res.failed.len(), 2);
        assert_eq!(res.groups_created, 1);
        let saved = st.store.get_connection(res.imported.iter().find(|r| r.key == "a").unwrap().id).unwrap();
        assert_eq!((saved.environment, saved.group.as_deref()), (EnvironmentKind::Production, Some("Team")));

        let ev = st.audit.query(&AuditFilter { category: Some(Category::ConnectionsImported), ..Default::default() }).unwrap();
        assert_eq!(ev.len(), 1);
        assert!(ev[0].detail.as_deref().unwrap().starts_with("imported=2 failed=2"));

        // A stale preview id is refused.
        assert!(apply(
            &st,
            ApplyRequest {
                preview_id: "nope".into(),
                keys: vec![],
                options: ApplyOptions { keep_groups: true, keep_environment: true, import_passwords: false }
            },
            &never
        )
        .is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn url_passwords_and_keychain_items_go_to_our_store() {
        let st = crate::commands::tests::test_state();
        let p =
            preview(&st, PreviewRequest::Urls { text: "postgres://app:pw1@db.example.com/app\nmysql://root@localhost/dev\n".into() }, &Env::default()).unwrap();
        assert_eq!(p.rows[0].password, PasswordInfo::Included);
        assert!(!serde_json::to_string(&p.rows).unwrap().contains("pw1"), "secrets never reach the webview");
        let keys = p.rows.iter().map(|r| r.key.clone()).collect();
        let never = |_: &str, _: &str| -> DbResult<Option<dbs_secrets::Secret>> { Ok(None) };
        let res = apply(
            &st,
            ApplyRequest { preview_id: p.preview_id, keys, options: ApplyOptions { keep_groups: true, keep_environment: false, import_passwords: true } },
            &never,
        )
        .unwrap();
        assert_eq!((res.imported.len(), res.passwords_imported), (2, 1));
        let id = res.imported[0].id;
        assert_eq!(st.secrets.get(id, SecretKind::DbPassword).unwrap().unwrap().expose(), "pw1");

        // Keychain-backed rows: the reader is called with the source's service/account; a failure stops further reads.
        let row = |key: &str| {
            let (cfg, _) = dbs_import::urls::parse_url("postgres://u@h.example.com/d").unwrap();
            let mut r = ImportedConnection::new(key, key, "PostgreSQL", Some(cfg));
            r.keychain.push(dbs_import::KeychainItem { kind: SecretKind::DbPassword, service: "svc".into(), account: format!("{key}_database") });
            r
        };
        *st.import_preview.lock().unwrap() = Some(Preview { id: "p2".into(), source: SourceKind::TablePlus, rows: vec![row("k1"), row("k2"), row("k3")] });
        let calls = std::cell::RefCell::new(vec![]);
        let reader = |s: &str, a: &str| -> DbResult<Option<dbs_secrets::Secret>> {
            calls.borrow_mut().push(format!("{s}/{a}"));
            if a.starts_with("k1") {
                Ok(Some(dbs_secrets::Secret::new("from-keychain".into())))
            } else {
                Err(DbError::internal("user canceled"))
            }
        };
        let res = apply(
            &st,
            ApplyRequest {
                preview_id: "p2".into(),
                keys: vec!["k1".into(), "k2".into(), "k3".into()],
                options: ApplyOptions { keep_groups: true, keep_environment: true, import_passwords: true },
            },
            &reader,
        )
        .unwrap();
        assert_eq!(res.imported.len(), 3);
        assert_eq!(res.passwords_imported, 1);
        assert_eq!(calls.borrow().as_slice(), ["svc/k1_database", "svc/k2_database"]);
        assert_eq!(res.password_errors.len(), 2);
        assert_eq!(st.secrets.get(res.imported[0].id, SecretKind::DbPassword).unwrap().unwrap().expose(), "from-keychain");
    }
}
