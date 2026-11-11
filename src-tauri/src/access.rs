//! Access providers (see `dbs-access`): sign in, request database access, approve
//! requests, and turn a granted request into a saved connection.
//!
//! Providers are configured by the user (kind + display name + base URL) and stored
//! as app metadata; each provider's session token lives only in the OS keychain
//! (`SecretKind::AccessToken`, owner = provider id) and never reaches the webview.
//! The connect / expiry / reconcile rules are provider-independent (`dbs_access::manage`).

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use dbs_access::manage::{self, ConnectCheck, ConnectOutcome, RequestView, Stores};
use dbs_access::{
    AccessError, AccessProvider, AccessRequest, AccessRequestInput, AccessUser, Capabilities, ProviderConfig, ProviderKindInfo, Resource, TargetList,
};
use dbs_audit::{Category, Outcome};
use dbs_core::*;
use dbs_secrets::SecretKind;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::commands::{audit, check_len};
use crate::state::AppState;

type R<T> = Result<T, DbError>;

/// App-metadata key holding the configured providers (written only by these commands).
pub const KEY_PROVIDERS: &str = "access.providers";

#[derive(Default)]
pub struct AccessState {
    /// Sign-ins waiting for the browser, per provider.
    logins: Mutex<HashMap<Uuid, CancellationToken>>,
    /// Session tokens per provider, read from the keychain at most once per app run (each
    /// keychain read can show an OS prompt, and the UI polls). `None` = known signed out.
    tokens: Mutex<HashMap<Uuid, Option<String>>>,
    /// Managed connections whose password is known to be in the keychain (`Stores::known_passwords`).
    pub(crate) known_passwords: Mutex<HashSet<Uuid>>,
    /// Serialises "Connect" so two clicks can never fetch a secret twice.
    connect_lock: tokio::sync::Mutex<()>,
}

fn stores(st: &AppState) -> Stores<'_> {
    Stores { store: &st.store, secrets: st.secrets.as_ref(), session: &st.session_secrets, known_passwords: Some(&st.access.known_passwords) }
}

fn providers(st: &AppState) -> Vec<ProviderConfig> {
    st.store.get_setting(KEY_PROVIDERS).ok().flatten().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

fn save_providers(st: &AppState, list: &[ProviderConfig]) -> R<()> {
    st.store.set_setting(KEY_PROVIDERS, &serde_json::to_value(list).map_err(|e| DbError::internal(e.to_string()))?)
}

fn provider_config(st: &AppState, id: Uuid) -> R<ProviderConfig> {
    providers(st).into_iter().find(|p| p.id == id).ok_or_else(|| DbError::new(ErrorKind::NotFound, "access provider not found"))
}

/// The provider's session token (cached; the keychain is read once per provider per run).
fn token(st: &AppState, id: Uuid) -> R<Option<String>> {
    if let Some(t) = st.access.tokens.lock().unwrap().get(&id) {
        return Ok(t.clone());
    }
    let t = st.secrets.get(id, SecretKind::AccessToken)?.map(|s| s.into_inner());
    st.access.tokens.lock().unwrap().insert(id, t.clone());
    Ok(t)
}

fn set_token(st: &AppState, id: Uuid, tok: &str) -> R<()> {
    st.secrets.set(id, SecretKind::AccessToken, tok)?;
    st.access.tokens.lock().unwrap().insert(id, Some(tok.to_string()));
    Ok(())
}

/// Forgets the token (cache first, so a failing keychain delete still signs out for this run).
fn forget_token(st: &AppState, id: Uuid) -> R<()> {
    st.access.tokens.lock().unwrap().insert(id, None);
    st.secrets.delete(id, SecretKind::AccessToken)
}

/// A provider client with the saved token, or "signed out".
fn signed_in(st: &AppState, id: Uuid) -> R<(ProviderConfig, Box<dyn AccessProvider>)> {
    let cfg = provider_config(st, id)?;
    let tok = token(st, id)?.ok_or(AccessError::SignedOut)?;
    let p = dbs_access::build_provider(&cfg, Some(tok))?;
    Ok((cfg, p))
}

/// A signed-out answer means the token expired or was revoked: forget it.
fn on_error(st: &AppState, id: Uuid, e: AccessError) -> DbError {
    if e == AccessError::SignedOut {
        let _ = forget_token(st, id);
    }
    e.into()
}

macro_rules! call {
    ($st:expr, $id:expr, |$p:ident| $body:expr) => {{
        let (_cfg, $p) = signed_in(&$st, $id)?;
        let r = $body.await;
        r.map_err(|e| on_error(&$st, $id, e))
    }};
}

// ---------------------------------------------------------------- providers

#[derive(Serialize)]
pub struct ProviderView {
    #[serde(flatten)]
    config: ProviderConfig,
    capabilities: Capabilities,
    /// A session token is saved (it may still turn out to be expired).
    has_session: bool,
}

#[tauri::command]
pub fn access_provider_kinds() -> Vec<ProviderKindInfo> {
    dbs_access::provider_kinds()
}

#[tauri::command]
pub fn access_providers_list(st: State<'_, AppState>) -> R<Vec<ProviderView>> {
    list_views(&st)
}

fn list_views(st: &AppState) -> R<Vec<ProviderView>> {
    providers(st)
        .into_iter()
        .map(|c| {
            let caps = dbs_access::build_provider(&c, None).map(|p| p.capabilities()).unwrap_or_default();
            Ok(ProviderView { has_session: token(st, c.id)?.is_some(), capabilities: caps, config: c })
        })
        .collect()
}

#[derive(Deserialize)]
pub struct NewProvider {
    kind: String,
    name: String,
    base_url: String,
}

#[tauri::command]
pub fn access_providers_add(st: State<'_, AppState>, provider: NewProvider) -> R<ProviderConfig> {
    add_provider(&st, provider)
}

fn add_provider(st: &AppState, p: NewProvider) -> R<ProviderConfig> {
    check_len(&p.base_url, 2048, "URL")?;
    let cfg = ProviderConfig { id: Uuid::new_v4(), kind: p.kind, name: p.name, base_url: p.base_url }.validated()?;
    let mut list = providers(st);
    if list.len() >= 20 {
        return Err(DbError::invalid("too many access providers"));
    }
    list.push(cfg.clone());
    save_providers(st, &list)?;
    audit(st, Category::SettingsChanged, Outcome::Success, None, |e| e.detail = Some(format!("access provider added ({})", cfg.kind)));
    Ok(cfg)
}

/// Renames a provider or changes its URL. A new URL signs out: a token is only ever
/// sent to the server that issued it.
#[tauri::command]
pub fn access_providers_update(st: State<'_, AppState>, id: Uuid, name: String, base_url: String) -> R<ProviderConfig> {
    update_provider(&st, id, name, base_url)
}

fn update_provider(st: &AppState, id: Uuid, name: String, base_url: String) -> R<ProviderConfig> {
    check_len(&base_url, 2048, "URL")?;
    let old = provider_config(st, id)?;
    let new = ProviderConfig { name, base_url, ..old.clone() }.validated()?;
    if new.base_url != old.base_url && token(st, id)?.is_some() {
        forget_token(st, id)?;
        audit(st, Category::CredentialDeleted, Outcome::Success, None, |e| e.detail = Some("access provider token (URL changed)".into()));
    }
    let list: Vec<ProviderConfig> = providers(st).into_iter().map(|p| if p.id == id { new.clone() } else { p }).collect();
    save_providers(st, &list)?;
    audit(st, Category::SettingsChanged, Outcome::Success, None, |e| e.detail = Some("access provider changed".into()));
    Ok(new)
}

/// Removes a provider and its session (revoked at the provider on a best-effort basis).
/// Connections it created keep working until their access ends.
#[tauri::command]
pub async fn access_providers_remove(st: State<'_, AppState>, id: Uuid) -> R<()> {
    if let Ok((_, p)) = signed_in(&st, id) {
        let _ = p.sign_out().await;
    }
    remove_provider(&st, id)
}

fn remove_provider(st: &AppState, id: Uuid) -> R<()> {
    forget_token(st, id)?;
    let list: Vec<ProviderConfig> = providers(st).into_iter().filter(|p| p.id != id).collect();
    save_providers(st, &list)?;
    audit(st, Category::SettingsChanged, Outcome::Success, None, |e| e.detail = Some("access provider removed".into()));
    Ok(())
}

// ---------------------------------------------------------------- session

#[derive(Serialize)]
pub struct AccessStatus {
    signed_in: bool,
    user: Option<AccessUser>,
    signing_in: bool,
    /// Why the status is degraded (session ended, provider unreachable).
    error: Option<DbError>,
}

#[tauri::command]
pub async fn access_status(st: State<'_, AppState>, provider_id: Uuid) -> R<AccessStatus> {
    let cfg = provider_config(&st, provider_id)?;
    let signing_in = st.access.logins.lock().unwrap().contains_key(&provider_id);
    let mut s = AccessStatus { signed_in: false, user: None, signing_in, error: None };
    let Some(tok) = token(&st, provider_id)? else { return Ok(s) };
    match dbs_access::build_provider(&cfg, Some(tok))?.current_user().await {
        Ok(u) => {
            s.signed_in = true;
            s.user = Some(u);
        }
        Err(AccessError::SignedOut) => s.error = Some(on_error(&st, provider_id, AccessError::SignedOut)),
        Err(e) => {
            // Offline / VPN down: still signed in, details unavailable.
            s.signed_in = true;
            s.error = Some(e.into());
        }
    }
    Ok(s)
}

/// "Lord of the Rows on <computer name>", shown in the provider's list of sessions.
fn device_name() -> String {
    let run = |cmd: &str, args: &[&str]| {
        std::process::Command::new(cmd).args(args).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    let host =
        if cfg!(target_os = "macos") { run("/usr/sbin/scutil", &["--get", "ComputerName"]).or_else(|| run("hostname", &[])) } else { run("hostname", &[]) };
    let host: String = host.unwrap_or_default().chars().filter(|c| !c.is_control()).take(64).collect();
    format!("Lord of the Rows on {}", if host.is_empty() { "this computer" } else { &host })
}

/// Opens `url` in the default browser. On Linux a `$BROWSER` command wins (the usual
/// convention; the E2E tests use it to play the browser).
fn open_browser(url: &str) -> Result<(), AccessError> {
    let spawn = |cmd: &str, args: &[&str]| {
        std::process::Command::new(cmd).args(args).spawn().map(|_| ()).map_err(|e| AccessError::Other(format!("could not open the browser: {e}")))
    };
    if cfg!(target_os = "macos") {
        spawn("/usr/bin/open", &[url])
    } else if cfg!(target_os = "windows") {
        spawn("rundll32", &["url.dll,FileProtocolHandler", url])
    } else {
        match std::env::var("BROWSER").ok().filter(|b| !b.trim().is_empty()) {
            Some(b) => spawn(b.trim(), &[url]),
            None => spawn("xdg-open", &[url]),
        }
    }
}

struct LoginGuard<'a>(&'a AccessState, Uuid);
impl Drop for LoginGuard<'_> {
    fn drop(&mut self) {
        self.0.logins.lock().unwrap().remove(&self.1);
    }
}

/// Interactive sign-in (the provider's single sign-on in the browser); the token goes to the keychain.
#[tauri::command]
pub async fn access_sign_in(st: State<'_, AppState>, provider_id: Uuid) -> R<AccessUser> {
    let cfg = provider_config(&st, provider_id)?;
    let provider = dbs_access::build_provider(&cfg, None)?;
    let cancel = CancellationToken::new();
    if let Some(prev) = st.access.logins.lock().unwrap().insert(provider_id, cancel.clone()) {
        prev.cancel();
    }
    let _guard = LoginGuard(&st.access, provider_id);
    let device = device_name();
    let ctx = dbs_access::SignInContext { device_name: &device, open_browser: &open_browser, cancel, timeout: dbs_access::loopback::LOGIN_TIMEOUT };
    let signed = match provider.sign_in(ctx).await {
        Ok(s) => s,
        Err(e) => {
            if e != AccessError::Cancelled {
                audit(&st, Category::CredentialChanged, Outcome::Failure, None, |ev| ev.detail = Some(format!("access sign-in ({})", cfg.kind)));
            }
            return Err(e.into());
        }
    };
    set_token(&st, provider_id, &signed.token)?;
    audit(&st, Category::CredentialChanged, Outcome::Success, None, |e| e.detail = Some(format!("access sign-in ({})", cfg.kind)));
    Ok(signed.user.clone())
}

#[tauri::command]
pub fn access_cancel_sign_in(st: State<'_, AppState>, provider_id: Uuid) {
    if let Some(c) = st.access.logins.lock().unwrap().remove(&provider_id) {
        c.cancel();
    }
}

/// Ends the session at the provider (best effort) and forgets the token. Saved
/// connections keep working until their access ends.
#[tauri::command]
pub async fn access_sign_out(st: State<'_, AppState>, provider_id: Uuid) -> R<()> {
    if let Ok((_, p)) = signed_in(&st, provider_id) {
        if let Err(e) = p.sign_out().await {
            tracing::warn!("access sign-out: {e}");
        }
    }
    forget_token(&st, provider_id)?;
    audit(&st, Category::CredentialDeleted, Outcome::Success, None, |e| e.detail = Some("access sign-out".into()));
    Ok(())
}

// ---------------------------------------------------------------- resources + requests

#[tauri::command]
pub async fn access_list_resources(st: State<'_, AppState>, provider_id: Uuid) -> R<Vec<Resource>> {
    call!(st, provider_id, |p| p.list_resources())
}

#[tauri::command]
pub async fn access_resource_targets(st: State<'_, AppState>, provider_id: Uuid, resource_id: String) -> R<TargetList> {
    call!(st, provider_id, |p| p.resource_targets(&resource_id))
}

#[tauri::command]
pub async fn access_create_request(st: State<'_, AppState>, provider_id: Uuid, input: AccessRequestInput) -> R<AccessRequest> {
    input.validate()?;
    call!(st, provider_id, |p| p.create_request(&input))
}

#[derive(Serialize)]
pub struct RequestList {
    requests: Vec<RequestView>,
    /// Managed connections that were just marked expired (the UI reloads its list).
    expired_connections: Vec<Uuid>,
}

/// The signed-in user's requests. Also ends managed connections whose request ended.
#[tauri::command]
pub async fn access_list_requests(st: State<'_, AppState>, provider_id: Uuid) -> R<RequestList> {
    let reqs = call!(st, provider_id, |p| p.list_requests())?;
    let now = dbs_access::now_unix();
    let mut expired = manage::reconcile(&stores(&st), provider_id, &reqs, now)?;
    expired.extend(manage::sweep(&stores(&st), now)?);
    audit_expired(&st, &expired);
    Ok(RequestList { requests: manage::with_connections(&st.store, provider_id, reqs)?, expired_connections: expired })
}

/// One request with its progress log.
#[tauri::command]
pub async fn access_get_request(st: State<'_, AppState>, provider_id: Uuid, request_id: String) -> R<RequestView> {
    let r = call!(st, provider_id, |p| p.get_request(&request_id))?;
    let expired = manage::reconcile(&stores(&st), provider_id, std::slice::from_ref(&r), dbs_access::now_unix())?;
    audit_expired(&st, &expired);
    Ok(manage::with_connections(&st.store, provider_id, vec![r])?.remove(0))
}

/// Withdraws a pending request (or gives up granted access, which ends its connection).
#[tauri::command]
pub async fn access_cancel_request(st: State<'_, AppState>, provider_id: Uuid, request_id: String) -> R<AccessRequest> {
    let r = call!(st, provider_id, |p| p.cancel_request(&request_id))?;
    let expired = manage::reconcile(&stores(&st), provider_id, std::slice::from_ref(&r), dbs_access::now_unix())?;
    audit_expired(&st, &expired);
    Ok(r)
}

#[tauri::command]
pub async fn access_list_approvals(st: State<'_, AppState>, provider_id: Uuid) -> R<Vec<AccessRequest>> {
    call!(st, provider_id, |p| p.list_approvals())
}

/// Requests the signed-in approver decided, newest first (`Unsupported` when the provider can't say).
#[tauri::command]
pub async fn access_list_decided(st: State<'_, AppState>, provider_id: Uuid, cursor: Option<String>, limit: Option<u32>) -> R<dbs_access::Page<AccessRequest>> {
    call!(st, provider_id, |p| p.list_decided(cursor.as_deref(), limit.unwrap_or(50)))
}

#[tauri::command]
pub async fn access_approve(st: State<'_, AppState>, provider_id: Uuid, request_id: String) -> R<AccessRequest> {
    call!(st, provider_id, |p| p.approve(&request_id))
}

#[tauri::command]
pub async fn access_reject(st: State<'_, AppState>, provider_id: Uuid, request_id: String, reason: String) -> R<AccessRequest> {
    check_len(&reason, 2000, "reason")?;
    if reason.trim().is_empty() {
        return Err(DbError::invalid("A reason is required to reject a request"));
    }
    call!(st, provider_id, |p| p.reject(&request_id, &reason))
}

// ---------------------------------------------------------------- connect

/// What "Connect" would do, so the UI can warn before the last reveals are spent.
#[tauri::command]
pub async fn access_connect_check(st: State<'_, AppState>, provider_id: Uuid, request_id: String) -> R<ConnectCheck> {
    dbs_access::check_id(&request_id)?;
    let now = dbs_access::now_unix();
    if let Some(c) = manage::reusable(&stores(&st), provider_id, &request_id, now)? {
        return Ok(ConnectCheck { reusable: true, connection_id: Some(c.id), reveals_remaining: None });
    }
    let (cfg, p) = signed_in(&st, provider_id)?;
    manage::connect_check(p.as_ref(), &cfg, &stores(&st), &request_id, now).await.map_err(|e| signed_out_cleanup(&st, provider_id, e))
}

fn signed_out_cleanup(st: &AppState, id: Uuid, e: DbError) -> DbError {
    if e.code.as_deref() == Some(AccessError::SignedOut.code()) {
        let _ = forget_token(st, id);
    }
    e
}

/// Creates (or refreshes) the managed connection for a ready request and returns its
/// id; the webview then opens it like any saved connection.
#[tauri::command]
pub async fn access_connect(st: State<'_, AppState>, provider_id: Uuid, request_id: String) -> R<ConnectOutcome> {
    dbs_access::check_id(&request_id)?;
    let _lock = st.access.connect_lock.lock().await;
    let now = dbs_access::now_unix();
    // Reuse never needs the provider (works offline / signed out).
    if let Some(c) = manage::reusable(&stores(&st), provider_id, &request_id, now)? {
        return Ok(ConnectOutcome { connection_id: c.id, reused: true, reveals_remaining: None, password_in_memory: false });
    }
    let (cfg, p) = signed_in(&st, provider_id)?;
    let r = manage::connect(p.as_ref(), &cfg, &stores(&st), &request_id, now).await.map_err(|e| signed_out_cleanup(&st, provider_id, e));
    match &r {
        Ok(o) if !o.reused => {
            let c = st.store.get_connection(o.connection_id).ok();
            audit(&st, Category::ConnectionCreated, Outcome::Success, c.as_ref(), |e| e.detail = Some(format!("access request {request_id} ({})", cfg.kind)));
            audit(&st, Category::CredentialChanged, Outcome::Success, c.as_ref(), |e| e.detail = Some("access credential fetched".into()));
        }
        Ok(_) => {}
        Err(e) => audit(&st, Category::ConnectionFailed, Outcome::Failure, None, |ev| {
            ev.detail = Some(format!("access request {request_id} ({})", cfg.kind));
            ev.error_kind = Some(e.kind);
        }),
    }
    r
}

/// Ends managed connections whose expiry time has passed (no network needed).
#[tauri::command]
pub fn access_sweep(st: State<'_, AppState>) -> R<Vec<Uuid>> {
    let expired = manage::sweep(&stores(&st), dbs_access::now_unix())?;
    audit_expired(&st, &expired);
    Ok(expired)
}

/// Refuses to open a managed connection whose access has ended (and wipes its password).
pub(crate) fn guard(st: &AppState, cfg: &ConnectionConfig) -> R<()> {
    let was_live = cfg.managed_by.as_ref().is_some_and(|m| !m.expired);
    let r = manage::check_open(&stores(st), cfg, dbs_access::now_unix());
    if r.is_err() && was_live {
        audit_expired(st, &[cfg.id]);
    }
    r
}

fn audit_expired(st: &AppState, ids: &[Uuid]) {
    for id in ids {
        let cfg = st.store.get_connection(*id).ok();
        audit(st, Category::CredentialDeleted, Outcome::Success, cfg.as_ref(), |e| e.detail = Some("access ended".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new(kind: &str, url: &str) -> NewProvider {
        NewProvider { kind: kind.into(), name: "Company access".into(), base_url: url.into() }
    }

    #[test]
    fn providers_add_update_remove() {
        let st = crate::commands::tests::test_state();
        assert!(add_provider(&st, new("nope", "https://access.example.com")).is_err());
        assert!(add_provider(&st, new("passhub", "http://access.example.com")).is_err(), "no plaintext to remote hosts");
        let p = add_provider(&st, new("passhub", "https://access.example.com/api/v1")).unwrap();
        assert_eq!(p.base_url, "https://access.example.com");
        let views = list_views(&st).unwrap();
        assert_eq!(views.len(), 1);
        assert!(views[0].capabilities.approvals);
        assert!(!views[0].has_session);

        set_token(&st, p.id, "tok").unwrap();
        update_provider(&st, p.id, "Renamed".into(), "https://access.example.com/".into()).unwrap();
        assert!(token(&st, p.id).unwrap().is_some(), "same URL keeps the session");
        assert_eq!(provider_config(&st, p.id).unwrap().name, "Renamed");
        assert!(update_provider(&st, p.id, "x".into(), "ftp://x".into()).is_err());
        assert!(token(&st, p.id).unwrap().is_some(), "a rejected change changes nothing");
        update_provider(&st, p.id, "Renamed".into(), "https://other.example.com".into()).unwrap();
        assert!(token(&st, p.id).unwrap().is_none(), "the token never goes to another server");

        set_token(&st, p.id, "tok").unwrap();
        remove_provider(&st, p.id).unwrap();
        assert!(providers(&st).is_empty());
        assert!(token(&st, p.id).unwrap().is_none());
        assert_eq!(signed_in(&st, p.id).err().unwrap().kind, ErrorKind::NotFound);
    }

    #[test]
    fn signed_out_without_token_and_token_dropped_on_401() {
        let st = crate::commands::tests::test_state();
        let p = add_provider(&st, new("passhub", "https://access.example.com")).unwrap();
        assert_eq!(signed_in(&st, p.id).err().unwrap().code.as_deref(), Some("access_signed_out"));
        set_token(&st, p.id, "tok").unwrap();
        assert!(signed_in(&st, p.id).is_ok());
        let e = on_error(&st, p.id, AccessError::SignedOut);
        assert_eq!(e.code.as_deref(), Some("access_signed_out"));
        assert!(token(&st, p.id).unwrap().is_none());
        set_token(&st, p.id, "tok").unwrap();
        let _ = on_error(&st, p.id, AccessError::Unreachable("vpn".into()));
        assert!(token(&st, p.id).unwrap().is_some(), "offline keeps the session");
    }

    #[tokio::test]
    async fn open_session_guard_blocks_expired_connections() {
        use dbs_access::testing::FakeProvider;
        use dbs_access::RequestStatus;
        let st = crate::commands::tests::test_state();
        let fake = FakeProvider::new();
        fake.add_request("r1", RequestStatus::Ready, Some(dbs_access::now_unix() + 3600));
        let pcfg = ProviderConfig { id: Uuid::new_v4(), kind: "fake".into(), name: "Company access".into(), base_url: "https://access.example.com".into() };
        let o = manage::connect(&fake, &pcfg, &stores(&st), "r1", dbs_access::now_unix()).await.unwrap();
        let mut cfg = st.store.get_connection(o.connection_id).unwrap();
        assert!(guard(&st, &cfg).is_ok());
        cfg.managed_by.as_mut().unwrap().expires_at = Some(1);
        st.store.save_connection(&cfg).unwrap();
        let e = guard(&st, &cfg).unwrap_err();
        assert_eq!(e.code.as_deref(), Some(manage::EXPIRED_CODE));
        assert!(st.secrets.get(cfg.id, SecretKind::DbPassword).unwrap().is_none());
    }

    #[test]
    fn polling_reads_the_keychain_token_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        struct Counting(dbs_secrets::MemoryStore, Arc<AtomicUsize>);
        impl dbs_secrets::SecretStore for Counting {
            fn set(&self, o: Uuid, k: SecretKind, v: &str) -> DbResult<()> {
                self.0.set(o, k, v)
            }
            fn get(&self, o: Uuid, k: SecretKind) -> DbResult<Option<dbs_secrets::Secret>> {
                self.1.fetch_add(1, Ordering::SeqCst);
                self.0.get(o, k)
            }
            fn delete(&self, o: Uuid, k: SecretKind) -> DbResult<()> {
                self.0.delete(o, k)
            }
            fn backend_name(&self) -> &'static str {
                "counting"
            }
        }
        let reads = Arc::new(AtomicUsize::new(0));
        let mut st = crate::commands::tests::test_state();
        st.secrets = Box::new(Counting(Default::default(), reads.clone()));
        let p = add_provider(&st, new("passhub", "https://access.example.com")).unwrap();
        // A token saved by an earlier run (not in the cache yet).
        st.secrets.set(p.id, SecretKind::AccessToken, "tok").unwrap();
        for _ in 0..20 {
            assert!(signed_in(&st, p.id).is_ok());
            assert!(list_views(&st).unwrap()[0].has_session);
        }
        assert_eq!(reads.load(Ordering::SeqCst), 1, "N polls -> 1 keychain read");
        // A 401 forgets it without reading again; so does a later poll.
        let _ = on_error(&st, p.id, AccessError::SignedOut);
        assert!(signed_in(&st, p.id).is_err());
        assert!(!list_views(&st).unwrap()[0].has_session);
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        // Signing in fills the cache directly.
        set_token(&st, p.id, "tok2").unwrap();
        assert_eq!(token(&st, p.id).unwrap().as_deref(), Some("tok2"));
        assert_eq!(reads.load(Ordering::SeqCst), 1);
    }
}
