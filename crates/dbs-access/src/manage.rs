//! Provider-independent lifecycle of connections created from access requests.
//!
//! * [`connect`]: while the managed connection for a request exists and its password
//!   is in the keychain, reuse it (no provider call). Otherwise plan the connection,
//!   validate it, and only then fetch the secret — once — into the keychain.
//! * [`sweep`]: expiry time passed → wipe the password, keep the record flagged expired.
//! * [`reconcile`]: the provider says a request ended (expired / revoked / …) → same;
//!   an extended expiry is copied.
//! * [`check_open`]: opening an expired managed connection is refused.

use dbs_core::{ConnectionConfig, DbError, DbResult, ErrorKind, ManagedBy, TlsConfig};
use dbs_secrets::{MemoryStore, SecretKind, SecretStore};
use dbs_store::AppStore;
use serde::Serialize;
use uuid::Uuid;

use crate::{AccessProvider, AccessRequest, ConnectionPlan, ProviderConfig};

/// `DbError::code` when a managed connection's access has ended.
pub const EXPIRED_CODE: &str = "access_expired";

/// Where connections and secrets live (the app's store, the OS keychain, and the
/// in-memory store used when the keychain refuses a secret).
pub struct Stores<'a> {
    pub store: &'a AppStore,
    pub secrets: &'a dyn SecretStore,
    pub session: &'a MemoryStore,
}

pub fn managed_connections(store: &AppStore, provider_id: Option<Uuid>) -> DbResult<Vec<ConnectionConfig>> {
    Ok(store
        .list_connections()?
        .into_iter()
        .map(|c| c.config)
        .filter(|c| c.managed_by.as_ref().is_some_and(|m| provider_id.is_none_or(|p| m.provider_id == p)))
        .collect())
}

pub fn find_managed(store: &AppStore, provider_id: Uuid, request_id: &str) -> DbResult<Option<ConnectionConfig>> {
    Ok(managed_connections(store, Some(provider_id))?.into_iter().find(|c| c.managed_by.as_ref().is_some_and(|m| m.request_id == request_id)))
}

fn has_password(s: &Stores, id: Uuid) -> DbResult<bool> {
    Ok(s.session.get(id, SecretKind::DbPassword)?.is_some() || s.secrets.get(id, SecretKind::DbPassword)?.is_some())
}

/// Whether a managed connection's access is over at `now`.
pub fn ended(cfg: &ConnectionConfig, now: i64) -> bool {
    cfg.managed_by.as_ref().is_some_and(|m| m.is_expired_at(now))
}

/// The managed connection for a request if it can be opened without fetching a secret.
pub fn reusable(s: &Stores, provider_id: Uuid, request_id: &str, now: i64) -> DbResult<Option<ConnectionConfig>> {
    let Some(c) = find_managed(s.store, provider_id, request_id)? else { return Ok(None) };
    Ok((!ended(&c, now) && has_password(s, c.id)?).then_some(c))
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ConnectCheck {
    /// A saved connection with its password exists: connecting fetches nothing.
    pub reusable: bool,
    pub connection_id: Option<Uuid>,
    /// Fetches left for the request's secret (`None` = unlimited / unknown).
    pub reveals_remaining: Option<i64>,
}

/// What [`connect`] would do, so the UI can warn before the last reveals are spent.
pub async fn connect_check(p: &dyn AccessProvider, pcfg: &ProviderConfig, s: &Stores<'_>, request_id: &str, now: i64) -> DbResult<ConnectCheck> {
    if let Some(c) = reusable(s, pcfg.id, request_id, now)? {
        return Ok(ConnectCheck { reusable: true, connection_id: Some(c.id), reveals_remaining: None });
    }
    let plan = p.connection_plan(request_id).await?;
    Ok(ConnectCheck { reusable: false, connection_id: find_managed(s.store, pcfg.id, request_id)?.map(|c| c.id), reveals_remaining: plan.reveals_remaining })
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ConnectOutcome {
    pub connection_id: Uuid,
    /// The saved connection and its password were reused (nothing fetched).
    pub reused: bool,
    /// After this fetch (`None` = unlimited / nothing fetched).
    pub reveals_remaining: Option<i64>,
    /// The keychain refused the password; it is kept in memory for this app run only.
    pub password_in_memory: bool,
}

/// The saved connection for a plan. `id` is new, or the existing managed connection's.
pub fn build_config(id: Uuid, pcfg: &ProviderConfig, plan: &ConnectionPlan) -> DbResult<ConnectionConfig> {
    let cfg = ConnectionConfig {
        id,
        name: plan.name.chars().take(200).collect(),
        engine: plan.engine,
        host: Some(plan.host.clone()),
        port: plan.port,
        database: plan.database.clone(),
        username: Some(plan.username.clone()),
        socket_path: None,
        tls: TlsConfig { mode: plan.tls, ..Default::default() },
        ssh: None,
        environment: plan.environment,
        read_only: plan.read_only,
        color: None,
        group: Some(pcfg.name.clone()),
        tags: vec![pcfg.kind.clone()],
        notes: Some(format!(
            "Managed by {} (request {}). Access is time-limited; request it again from the Access tab when it ends.",
            pcfg.name, plan.request_id
        )),
        favorite: false,
        connect_timeout_secs: 10,
        query_timeout_secs: None,
        init_sql: None,
        key_separator: None,
        managed_by: Some(ManagedBy {
            provider_id: pcfg.id,
            provider_kind: pcfg.kind.clone(),
            request_id: plan.request_id.clone(),
            credential_ref: plan.credential_ref.clone(),
            expires_at: plan.expires_at,
            expired: false,
        }),
        tunnel: None,
    };
    cfg.validate()?;
    Ok(cfg)
}

/// Creates (or refreshes) the managed connection for a ready request. The secret is
/// fetched only when no saved connection with a password exists, and only after the
/// connection was built and validated. Callers serialise calls (one at a time).
pub async fn connect(p: &dyn AccessProvider, pcfg: &ProviderConfig, s: &Stores<'_>, request_id: &str, now: i64) -> DbResult<ConnectOutcome> {
    if let Some(c) = reusable(s, pcfg.id, request_id, now)? {
        return Ok(ConnectOutcome { connection_id: c.id, reused: true, reveals_remaining: None, password_in_memory: false });
    }
    let plan = p.connection_plan(request_id).await?;
    if plan.reveals_remaining == Some(0) {
        return Err(crate::AccessError::NoRevealsLeft("No password reveals are left for this request. Request access again.".into()).into());
    }
    let existing = find_managed(s.store, pcfg.id, request_id)?;
    let id = existing.as_ref().map(|c| c.id).unwrap_or_else(Uuid::new_v4);
    let mut cfg = build_config(id, pcfg, &plan)?;
    if let Some(old) = &existing {
        // Keep what the user changed on the saved connection.
        cfg.name = old.name.clone();
        cfg.group = old.group.clone();
        cfg.color = old.color.clone();
        cfg.favorite = old.favorite;
        cfg.notes = old.notes.clone();
        cfg.validate()?;
    }
    let creds = p.fetch_credentials(&plan).await?;
    s.store.save_connection(&cfg)?;
    let mut in_memory = false;
    if let Err(e) = s.secrets.set(id, SecretKind::DbPassword, creds.password.expose()) {
        tracing::warn!("access: the keychain refused the password ({}); keeping it for this run only", e.message);
        s.session.set(id, SecretKind::DbPassword, creds.password.expose())?;
        in_memory = true;
    } else {
        s.session.delete(id, SecretKind::DbPassword)?;
    }
    Ok(ConnectOutcome { connection_id: id, reused: false, reveals_remaining: creds.reveals_remaining, password_in_memory: in_memory })
}

/// Flags a managed connection expired and wipes its password.
pub fn expire(s: &Stores, mut cfg: ConnectionConfig) -> DbResult<()> {
    s.secrets.delete(cfg.id, SecretKind::DbPassword)?;
    s.session.delete(cfg.id, SecretKind::DbPassword)?;
    if let Some(m) = cfg.managed_by.as_mut() {
        m.expired = true;
    }
    s.store.save_connection(&cfg)
}

/// Expires managed connections (of every provider) whose expiry time has passed.
pub fn sweep(s: &Stores, now: i64) -> DbResult<Vec<Uuid>> {
    let mut out = Vec::new();
    for c in managed_connections(s.store, None)? {
        if c.managed_by.as_ref().is_some_and(|m| !m.expired && m.is_expired_at(now)) {
            out.push(c.id);
            expire(s, c)?;
        }
    }
    Ok(out)
}

/// Applies a provider's view of requests to their managed connections: ended
/// requests expire them; a changed expiry time is copied.
pub fn reconcile(s: &Stores, provider_id: Uuid, reqs: &[AccessRequest], now: i64) -> DbResult<Vec<Uuid>> {
    let mut out = Vec::new();
    for mut c in managed_connections(s.store, Some(provider_id))? {
        let Some(m) = c.managed_by.clone().filter(|m| !m.expired) else { continue };
        let Some(r) = reqs.iter().find(|r| r.id == m.request_id) else { continue };
        if r.is_ended(now) {
            out.push(c.id);
            expire(s, c)?;
        } else if r.expires_at.is_some() && m.expires_at != r.expires_at {
            c.managed_by = Some(ManagedBy { expires_at: r.expires_at, ..m });
            s.store.save_connection(&c)?;
        }
    }
    Ok(out)
}

/// Refuses to open a managed connection whose access has ended (wiping its password
/// if that hasn't happened yet). Returns whether it was just expired.
pub fn check_open(s: &Stores, cfg: &ConnectionConfig, now: i64) -> DbResult<()> {
    let Some(m) = &cfg.managed_by else { return Ok(()) };
    if !m.is_expired_at(now) {
        return Ok(());
    }
    if !m.expired {
        if let Ok(stored) = s.store.get_connection(cfg.id) {
            expire(s, stored)?;
        }
    }
    Err(DbError::new(ErrorKind::Permission, "Your access to this database has ended. Request access again from the Access tab.").with_code(EXPIRED_CODE))
}

/// A request plus the managed connection made from it, if any.
#[derive(Serialize, Debug)]
pub struct RequestView {
    #[serde(flatten)]
    pub request: AccessRequest,
    pub connection_id: Option<Uuid>,
    pub connection_expired: bool,
}

pub fn with_connections(store: &AppStore, provider_id: Uuid, reqs: Vec<AccessRequest>) -> DbResult<Vec<RequestView>> {
    let managed = managed_connections(store, Some(provider_id))?;
    Ok(reqs
        .into_iter()
        .map(|r| {
            let c = managed.iter().find(|c| c.managed_by.as_ref().is_some_and(|m| m.request_id == r.id));
            RequestView { connection_id: c.map(|c| c.id), connection_expired: c.is_some_and(|c| ended(c, crate::now_unix())), request: r }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use dbs_core::{Engine, EnvironmentKind};

    use super::*;
    use crate::testing::FakeProvider;
    use crate::{AccessError, RequestStatus};

    const NOW: i64 = 1_800_000_000;

    fn pcfg() -> ProviderConfig {
        ProviderConfig { id: Uuid::new_v4(), kind: "fake".into(), name: "Company access".into(), base_url: "https://access.example.com".into() }
    }

    struct Ctx {
        store: AppStore,
        secrets: MemoryStore,
        session: MemoryStore,
    }
    impl Ctx {
        fn new() -> Self {
            Ctx { store: AppStore::open_in_memory().unwrap(), secrets: MemoryStore::default(), session: MemoryStore::default() }
        }
        fn s(&self) -> Stores<'_> {
            Stores { store: &self.store, secrets: &self.secrets, session: &self.session }
        }
    }

    #[tokio::test]
    async fn connect_fetches_once_then_reuses() {
        let p = FakeProvider::new();
        p.add_request("r1", RequestStatus::Ready, Some(NOW + 3600));
        let (cfg, c) = (pcfg(), Ctx::new());
        let o = connect(&p, &cfg, &c.s(), "r1", NOW).await.unwrap();
        assert!(!o.reused);
        assert_eq!(o.reveals_remaining, Some(4));
        let saved = c.store.get_connection(o.connection_id).unwrap();
        assert_eq!((saved.engine, saved.environment, saved.read_only), (Engine::Postgres, EnvironmentKind::Staging, false));
        assert_eq!(saved.group.as_deref(), Some("Company access"));
        assert_eq!(saved.tags, vec!["fake"]);
        let m = saved.managed_by.clone().unwrap();
        assert_eq!((m.provider_id, m.request_id.as_str(), m.expires_at), (cfg.id, "r1", Some(NOW + 3600)));
        assert_eq!(c.secrets.get(o.connection_id, SecretKind::DbPassword).unwrap().unwrap().expose(), "pw-r1");

        // Second click: same connection, nothing fetched (no provider call at all).
        let calls = p.calls();
        let o2 = connect(&p, &cfg, &c.s(), "r1", NOW).await.unwrap();
        assert!(o2.reused);
        assert_eq!(o2.connection_id, o.connection_id);
        assert_eq!(p.calls(), calls);
        assert_eq!(p.fetches(), 1);
        assert!(connect_check(&p, &cfg, &c.s(), "r1", NOW).await.unwrap().reusable);

        // Password lost: fetch again into the SAME connection, keeping the user's renaming.
        let mut renamed = saved;
        renamed.name = "My orders".into();
        c.store.save_connection(&renamed).unwrap();
        c.secrets.delete(o.connection_id, SecretKind::DbPassword).unwrap();
        let o3 = connect(&p, &cfg, &c.s(), "r1", NOW).await.unwrap();
        assert_eq!((o3.reused, o3.connection_id), (false, o.connection_id));
        assert_eq!(c.store.get_connection(o.connection_id).unwrap().name, "My orders");
        assert_eq!(p.fetches(), 2);
        assert_eq!(c.store.list_connections().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn not_ready_or_exhausted_never_fetches() {
        let p = FakeProvider::new();
        p.add_request("pending", RequestStatus::Pending, None);
        p.add_request("spent", RequestStatus::Ready, Some(NOW + 60));
        p.set_budget(Some(0));
        let (cfg, c) = (pcfg(), Ctx::new());
        let e = connect(&p, &cfg, &c.s(), "pending", NOW).await.unwrap_err();
        assert_eq!(e.code.as_deref(), Some("access_not_ready"));
        let e = connect(&p, &cfg, &c.s(), "spent", NOW).await.unwrap_err();
        assert_eq!(e.code.as_deref(), Some("access_no_reveals"));
        assert_eq!(p.fetches(), 0);
        assert!(c.store.list_connections().unwrap().is_empty());
    }

    #[tokio::test]
    async fn invalid_plan_costs_no_fetch() {
        let p = FakeProvider::new();
        p.add_request("r1", RequestStatus::Ready, None);
        p.with_plan(|pl| pl.host = "bad host".into());
        let (cfg, c) = (pcfg(), Ctx::new());
        assert!(connect(&p, &cfg, &c.s(), "r1", NOW).await.is_err());
        assert_eq!(p.fetches(), 0);
    }

    #[tokio::test]
    async fn keychain_failure_keeps_password_in_memory() {
        struct Refusing;
        impl SecretStore for Refusing {
            fn set(&self, _: Uuid, _: SecretKind, _: &str) -> DbResult<()> {
                Err(DbError::internal("locked"))
            }
            fn get(&self, _: Uuid, _: SecretKind) -> DbResult<Option<dbs_secrets::Secret>> {
                Ok(None)
            }
            fn delete(&self, _: Uuid, _: SecretKind) -> DbResult<()> {
                Ok(())
            }
            fn backend_name(&self) -> &'static str {
                "refusing"
            }
        }
        let p = FakeProvider::new();
        p.add_request("r1", RequestStatus::Ready, None);
        let (store, session) = (AppStore::open_in_memory().unwrap(), MemoryStore::default());
        let s = Stores { store: &store, secrets: &Refusing, session: &session };
        let o = connect(&p, &pcfg(), &s, "r1", NOW).await.unwrap();
        assert!(o.password_in_memory);
        assert!(session.get(o.connection_id, SecretKind::DbPassword).unwrap().is_some());
    }

    #[tokio::test]
    async fn expiry_wipes_password_and_keeps_the_record() {
        let p = FakeProvider::new();
        p.add_request("r1", RequestStatus::Ready, Some(NOW + 3600));
        let (cfg, c) = (pcfg(), Ctx::new());
        let id = connect(&p, &cfg, &c.s(), "r1", NOW).await.unwrap().connection_id;
        assert!(sweep(&c.s(), NOW + 10).unwrap().is_empty(), "not yet");
        assert_eq!(sweep(&c.s(), NOW + 3600).unwrap(), vec![id]);
        let saved = c.store.get_connection(id).unwrap();
        assert!(saved.managed_by.as_ref().unwrap().expired);
        assert!(c.secrets.get(id, SecretKind::DbPassword).unwrap().is_none());
        assert!(sweep(&c.s(), NOW + 7200).unwrap().is_empty(), "only once");
        assert!(reusable(&c.s(), cfg.id, "r1", NOW).unwrap().is_none());
        assert_eq!(check_open(&c.s(), &saved, NOW).unwrap_err().code.as_deref(), Some(EXPIRED_CODE));
    }

    #[tokio::test]
    async fn check_open_expires_on_the_spot() {
        let p = FakeProvider::new();
        p.add_request("r1", RequestStatus::Ready, Some(NOW + 60));
        let (cfg, c) = (pcfg(), Ctx::new());
        let id = connect(&p, &cfg, &c.s(), "r1", NOW).await.unwrap().connection_id;
        let saved = c.store.get_connection(id).unwrap();
        assert!(check_open(&c.s(), &saved, NOW).is_ok());
        assert!(check_open(&c.s(), &saved, NOW + 61).is_err());
        assert!(c.secrets.get(id, SecretKind::DbPassword).unwrap().is_none());
        assert!(c.store.get_connection(id).unwrap().managed_by.unwrap().expired);
        let mut plain = saved;
        plain.managed_by = None;
        assert!(check_open(&c.s(), &plain, NOW + 61).is_ok(), "unmanaged connections are not affected");
    }

    #[tokio::test]
    async fn reconcile_follows_the_provider() {
        let p = FakeProvider::new();
        p.add_request("r1", RequestStatus::Ready, Some(NOW + 3600));
        let (cfg, c) = (pcfg(), Ctx::new());
        let id = connect(&p, &cfg, &c.s(), "r1", NOW).await.unwrap().connection_id;
        let mut r = p.request("r1");
        r.expires_at = Some(NOW + 7200);
        assert!(reconcile(&c.s(), cfg.id, std::slice::from_ref(&r), NOW).unwrap().is_empty());
        assert_eq!(c.store.get_connection(id).unwrap().managed_by.unwrap().expires_at, Some(NOW + 7200), "extended expiry copied");
        assert!(
            reconcile(&c.s(), Uuid::new_v4(), &[AccessRequest { status: RequestStatus::Revoked, ..r.clone() }], NOW).unwrap().is_empty(),
            "other providers don't matter"
        );
        r.status = RequestStatus::Revoked;
        assert_eq!(reconcile(&c.s(), cfg.id, std::slice::from_ref(&r), NOW).unwrap(), vec![id]);
        assert!(c.secrets.get(id, SecretKind::DbPassword).unwrap().is_none());
        let views = with_connections(&c.store, cfg.id, vec![r]).unwrap();
        assert_eq!((views[0].connection_id, views[0].connection_expired), (Some(id), true));
    }

    #[test]
    fn error_codes_reach_the_ui() {
        let e: DbError = AccessError::NotReady("x".into()).into();
        assert_eq!(e.code.as_deref(), Some("access_not_ready"));
    }
}
