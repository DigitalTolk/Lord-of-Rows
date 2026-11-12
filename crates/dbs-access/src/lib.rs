//! Time-boxed database access through an access-management provider.
//!
//! A developer signs in to a provider, requests access to a database resource, a
//! manager approves it, the provider provisions a personal database user, and the
//! app turns the grant into a saved connection whose password lives in the OS
//! keychain until the access ends.
//!
//! * [`AccessProvider`] is the provider-neutral interface; [`providers`] holds the
//!   implementations (the Access API, `docs/access-api.md`) and the registry keyed by provider kind.
//! * [`manage`] is the provider-independent logic: "connect" fetches a credential
//!   at most once and reuses the cached secret, expiry wipes it, and the provider's
//!   view of a request is reconciled with the saved connection.
//! * [`loopback`] is a reusable browser sign-in helper (PKCE + loopback redirect).
//!
//! Session tokens and passwords never appear in `Debug` output or errors.

pub mod loopback;
pub mod manage;
pub mod providers;
pub mod rollout;
#[cfg(any(test, feature = "test-util"))]
pub mod testing;

use std::time::Duration;

use async_trait::async_trait;
use dbs_core::{DbError, Engine, EnvironmentKind, ErrorKind, TlsMode};
use dbs_secrets::Secret;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub use providers::{build_provider, provider_kinds, resolve_kind, ProviderKindInfo};

pub type AccessResult<T> = Result<T, AccessError>;

// ---------------------------------------------------------------- errors

/// Provider-neutral failure. Converted to [`DbError`] (with a stable `code`) at the IPC boundary.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum AccessError {
    /// The session token expired or was revoked: sign in again.
    #[error("Your session with the access provider has ended (it expired or was signed out). Sign in again.")]
    SignedOut,
    /// The provider could not be reached (network, VPN).
    #[error("{0}")]
    Unreachable(String),
    #[error("{0}")]
    Forbidden(String),
    /// E.g. a pending request for the same resource already exists.
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    /// The request is not (or no longer) in a state that grants access.
    #[error("{0}")]
    NotReady(String),
    /// The credential may not be fetched again.
    #[error("{0}")]
    NoRevealsLeft(String),
    #[error("Sign-in was cancelled")]
    Cancelled,
    #[error("{0}")]
    Timeout(String),
    #[error("{0}")]
    Unsupported(String),
    #[error("{0}")]
    Other(String),
}

impl AccessError {
    /// Stable code the UI can branch on (`DbError::code`).
    pub fn code(&self) -> &'static str {
        match self {
            AccessError::SignedOut => "access_signed_out",
            AccessError::Unreachable(_) => "access_unreachable",
            AccessError::Forbidden(_) => "access_forbidden",
            AccessError::Conflict(_) => "access_conflict",
            AccessError::NotFound(_) => "access_not_found",
            AccessError::Invalid(_) => "access_invalid",
            AccessError::NotReady(_) => "access_not_ready",
            AccessError::NoRevealsLeft(_) => "access_no_reveals",
            AccessError::Cancelled => "access_cancelled",
            AccessError::Timeout(_) => "access_timeout",
            AccessError::Unsupported(_) => "access_unsupported",
            AccessError::Other(_) => "access_error",
        }
    }

    fn kind(&self) -> ErrorKind {
        match self {
            AccessError::SignedOut => ErrorKind::Authentication,
            AccessError::Unreachable(_) => ErrorKind::Connection,
            AccessError::Forbidden(_) | AccessError::NoRevealsLeft(_) => ErrorKind::Permission,
            AccessError::NotFound(_) => ErrorKind::NotFound,
            AccessError::Conflict(_) | AccessError::Invalid(_) | AccessError::NotReady(_) => ErrorKind::InvalidInput,
            AccessError::Cancelled => ErrorKind::Cancelled,
            AccessError::Timeout(_) => ErrorKind::Timeout,
            AccessError::Unsupported(_) => ErrorKind::Unsupported,
            AccessError::Other(_) => ErrorKind::Internal,
        }
    }
}

impl From<AccessError> for DbError {
    fn from(e: AccessError) -> Self {
        DbError::new(e.kind(), e.to_string()).with_code(e.code())
    }
}

impl From<DbError> for AccessError {
    fn from(e: DbError) -> Self {
        match e.kind {
            ErrorKind::InvalidInput => AccessError::Invalid(e.message),
            ErrorKind::Unsupported => AccessError::Unsupported(e.message),
            ErrorKind::NotFound => AccessError::NotFound(e.message),
            _ => AccessError::Other(e.message),
        }
    }
}

// ---------------------------------------------------------------- configuration

/// A configured access provider (stored as app metadata; the token is in the keychain).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: Uuid,
    /// Implementation, e.g. `"access-api"` (see [`provider_kinds`]).
    pub kind: String,
    /// Shown in the UI ("Sign in to <name>").
    pub name: String,
    pub base_url: String,
}

impl ProviderConfig {
    /// For configs read back from storage or a managed `providers.json`: a kind this build
    /// doesn't know becomes the only registered kind when there is just one (see
    /// [`resolve_kind`]); otherwise the kind is left as is (and fails validation / use).
    pub fn with_resolved_kind(mut self) -> Self {
        if let Some(k) = resolve_kind(&self.kind) {
            self.kind = k.to_string();
        }
        self
    }

    /// Validates the fields (the kind must be registered) and normalises the URL.
    pub fn validated(mut self) -> AccessResult<Self> {
        if !provider_kinds().iter().any(|k| k.kind == self.kind) {
            return Err(AccessError::Invalid(format!("unknown access provider type \"{}\"", self.kind)));
        }
        self.name = self.name.trim().to_string();
        if self.name.is_empty() || self.name.chars().count() > 60 || self.name.chars().any(char::is_control) {
            return Err(AccessError::Invalid("Give the provider a name (up to 60 characters)".into()));
        }
        self.base_url = normalize_base_url(&self.base_url)?;
        Ok(self)
    }
}

/// Validates and normalises a provider base URL: `https://host[:port][/path]` without
/// credentials, query or fragment, no trailing slash; a pasted `…/api/v1` suffix is
/// dropped. Plain `http://` is accepted only for a server on this machine (a session
/// token must never cross the network in clear text).
pub fn normalize_base_url(raw: &str) -> AccessResult<String> {
    let bad = |m: &str| AccessError::Invalid(m.to_string());
    let s = raw.trim();
    if s.is_empty() || s.len() > 2048 {
        return Err(bad("Enter the provider URL, e.g. https://access.example.com"));
    }
    let url = url::Url::parse(s).map_err(|_| bad("The provider URL is not a valid URL (e.g. https://access.example.com)"))?;
    let host = url.host_str().unwrap_or("").to_string();
    if host.is_empty() {
        return Err(bad("The provider URL needs a host name"));
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err(bad("The provider URL must not contain credentials, a query or a fragment"));
    }
    match url.scheme() {
        "https" => {}
        "http" if matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1") => {}
        "http" => return Err(bad("The provider URL must use https:// (http:// is only allowed for a server on this computer)")),
        _ => return Err(bad("The provider URL must start with https://")),
    }
    let mut out = url.as_str().trim_end_matches('/').to_string();
    for suffix in ["/api/v1", "/api"] {
        if let Some(stripped) = out.strip_suffix(suffix) {
            out = stripped.to_string();
        }
    }
    Ok(out)
}

/// Ids that go into provider URLs; anything unusual is refused rather than escaped.
pub fn check_id(id: &str) -> AccessResult<()> {
    if id.is_empty() || id.len() > 128 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AccessError::Invalid("invalid id".into()));
    }
    Ok(())
}

/// Current unix time in seconds.
pub fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

// ---------------------------------------------------------------- models

/// What a provider supports beyond the basics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
pub struct Capabilities {
    /// Approvers can list, approve and reject requests in the app.
    pub approvals: bool,
    /// A request can ask for a new database to be created.
    pub create_database: bool,
    /// Pending requests can be withdrawn.
    pub cancel: bool,
    /// Requested databases are picked from `resource_targets`.
    pub targets: bool,
    /// Approvers can list the requests they decided (`list_decided`). A provider may
    /// still answer `Unsupported` at runtime (older server); the UI then hides it.
    pub decided_history: bool,
}

/// One page of a cursor-paged list.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    /// Cursor for the next page; `None` = last page.
    pub next: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessLevel {
    ReadOnly,
    ReadWrite,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct AccessUser {
    pub id: String,
    pub email: String,
    pub name: String,
    /// Provider role, shown as-is.
    pub role: String,
    /// May approve other people's requests.
    pub can_approve: bool,
    /// Why this user can't file requests right now (`"no_approver"`), if so.
    pub request_blocked: Option<String>,
}

/// A database the user can request access to.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Resource {
    pub id: String,
    pub name: String,
    pub environment_name: String,
    pub environment: EnvironmentKind,
    pub engine: Engine,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub access_levels: Vec<AccessLevel>,
}

/// Databases (sub-targets) of a resource. `error` = the provider could not list them.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct TargetList {
    pub targets: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AccessRequestInput {
    pub resource_id: String,
    pub access: AccessLevel,
    pub reason: String,
    #[serde(default)]
    pub databases: Vec<String>,
    /// Ask for the single database in `databases` to be created.
    #[serde(default)]
    pub create_database: bool,
    /// Optional ticket reference (e.g. `OPS-123`); how it is stored is up to the provider.
    #[serde(default)]
    pub ticket: Option<String>,
}

/// A ticket reference: 1-40 characters of letters, digits and `-_.#/`.
pub fn valid_ticket(t: &str) -> bool {
    (1..=40).contains(&t.len()) && t.chars().all(|c| c.is_ascii_alphanumeric() || "-_.#/".contains(c))
}

impl AccessRequestInput {
    /// The trimmed ticket, if one was given.
    pub fn ticket(&self) -> Option<&str> {
        self.ticket.as_deref().map(str::trim).filter(|t| !t.is_empty())
    }

    pub fn validate(&self) -> AccessResult<()> {
        check_id(&self.resource_id).map_err(|_| AccessError::Invalid("Choose a database to request".into()))?;
        let reason = self.reason.trim();
        if reason.is_empty() || reason.len() > 2000 {
            return Err(AccessError::Invalid("A reason (up to 2000 characters) is required".into()));
        }
        if self.ticket().is_some_and(|t| !valid_ticket(t)) {
            return Err(AccessError::Invalid("A ticket reference may use letters, digits and - _ . # / (up to 40)".into()));
        }
        if self.databases.is_empty() || self.databases.len() > 100 {
            return Err(AccessError::Invalid("Select at least one database".into()));
        }
        if self.databases.iter().any(|d| d.trim().is_empty() || d.len() > 128 || d.chars().any(char::is_control)) {
            return Err(AccessError::Invalid("Invalid database name".into()));
        }
        if self.create_database {
            let ok = self.databases.len() == 1
                && (1..=64).contains(&self.databases[0].len())
                && self.databases[0].chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            if !ok {
                return Err(AccessError::Invalid("A new database name may use letters, digits and underscores (up to 64)".into()));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RequestStatus {
    #[default]
    Pending,
    /// Approved; the provider is creating the database user.
    Provisioning,
    /// Credentials can be fetched.
    Ready,
    Failed,
    Rejected,
    Expired,
    Revoked,
    Cancelled,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Person {
    pub id: String,
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LogEntry {
    pub ts: String,
    pub level: String,
    pub msg: String,
}

/// An access request in provider-neutral terms.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct AccessRequest {
    pub id: String,
    pub resource_id: String,
    pub resource_name: String,
    pub environment_name: String,
    pub environment: EnvironmentKind,
    pub engine: Option<Engine>,
    pub access: Option<AccessLevel>,
    /// The reason without the ticket reference.
    pub reason: String,
    /// Ticket reference given with the request, if any.
    pub ticket: Option<String>,
    pub databases: Vec<String>,
    pub create_database: bool,
    pub status: RequestStatus,
    /// Failure / rejection reason.
    pub status_detail: Option<String>,
    pub requester: Person,
    /// Who decides (pending) or decided (afterwards), if known.
    pub approver: Option<Person>,
    /// Progress lines while provisioning (may be empty in lists).
    pub log: Vec<LogEntry>,
    /// RFC 3339.
    pub created_at: String,
    /// Unix seconds.
    pub expires_at: Option<i64>,
    /// Approved lifetime, if the provider says.
    pub lifetime_hours: Option<i64>,
    /// When the request was approved or rejected (RFC 3339).
    pub decided_at: Option<String>,
}

impl AccessRequest {
    /// The access is over for good: connections made from it must stop working.
    pub fn is_ended(&self, now: i64) -> bool {
        matches!(self.status, RequestStatus::Expired | RequestStatus::Revoked | RequestStatus::Rejected | RequestStatus::Cancelled)
            || (self.status == RequestStatus::Ready && self.expires_at.is_some_and(|t| t <= now))
    }
}

/// Everything needed to save a connection for a ready request, except the secret.
/// Validated before the secret is fetched, so a bad grant never costs a reveal.
#[derive(Debug, Clone, PartialEq)]
pub struct ConnectionPlan {
    pub request_id: String,
    /// Provider id of the credential to fetch.
    pub credential_ref: Option<String>,
    /// Suggested connection name.
    pub name: String,
    pub engine: Engine,
    pub host: String,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: String,
    pub environment: EnvironmentKind,
    pub read_only: bool,
    pub tls: TlsMode,
    pub expires_at: Option<i64>,
    /// How many more times the secret may be fetched (`None` = unlimited / unknown).
    pub reveals_remaining: Option<i64>,
}

/// A fetched secret (zeroised on drop, redacted in `Debug`).
#[derive(Debug)]
pub struct Credentials {
    pub password: Secret,
    /// After this fetch (`None` = unlimited / unknown).
    pub reveals_remaining: Option<i64>,
}

/// Result of an interactive sign-in. The token goes to the keychain.
pub struct SignedIn {
    pub token: String,
    pub user: AccessUser,
    /// Unix seconds, if the provider says.
    pub expires_at: Option<i64>,
}

impl std::fmt::Debug for SignedIn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignedIn").field("token", &"***").field("user", &self.user).field("expires_at", &self.expires_at).finish()
    }
}

/// Opens a URL in the system browser.
pub type BrowserOpener = dyn Fn(&str) -> AccessResult<()> + Send + Sync;

/// What an interactive sign-in may use.
pub struct SignInContext<'a> {
    /// "Lord of the Rows on <computer>", for the provider's list of sessions.
    pub device_name: &'a str,
    pub open_browser: &'a BrowserOpener,
    pub cancel: CancellationToken,
    pub timeout: Duration,
}

// ---------------------------------------------------------------- the provider interface

/// An access-management provider. Instances are built per call by
/// [`build_provider`] from a [`ProviderConfig`] and the saved session token.
#[async_trait]
pub trait AccessProvider: Send + Sync {
    fn kind(&self) -> &'static str;
    fn capabilities(&self) -> Capabilities;

    /// Interactive sign-in (typically through the browser).
    async fn sign_in(&self, ctx: SignInContext<'_>) -> AccessResult<SignedIn>;
    /// Ends the session at the provider (best effort for the caller).
    async fn sign_out(&self) -> AccessResult<()>;
    async fn current_user(&self) -> AccessResult<AccessUser>;

    /// Databases this app can connect to that the user may request.
    async fn list_resources(&self) -> AccessResult<Vec<Resource>>;
    /// Databases on a resource (when `capabilities().targets`).
    async fn resource_targets(&self, resource_id: &str) -> AccessResult<TargetList>;

    async fn create_request(&self, input: &AccessRequestInput) -> AccessResult<AccessRequest>;
    /// The signed-in user's requests, newest first.
    async fn list_requests(&self) -> AccessResult<Vec<AccessRequest>>;
    /// One request (with its log), for polling.
    async fn get_request(&self, request_id: &str) -> AccessResult<AccessRequest>;
    /// Withdraws a pending request or gives up granted access.
    async fn cancel_request(&self, request_id: &str) -> AccessResult<AccessRequest>;

    /// Requests waiting for the signed-in approver (when `capabilities().approvals`).
    async fn list_approvals(&self) -> AccessResult<Vec<AccessRequest>> {
        Err(AccessError::Unsupported("This provider has no approvals in the app".into()))
    }
    async fn approve(&self, _request_id: &str) -> AccessResult<AccessRequest> {
        Err(AccessError::Unsupported("This provider has no approvals in the app".into()))
    }
    async fn reject(&self, _request_id: &str, _reason: &str) -> AccessResult<AccessRequest> {
        Err(AccessError::Unsupported("This provider has no approvals in the app".into()))
    }
    /// Requests the signed-in approver decided, newest decision first (when
    /// `capabilities().decided_history`). `cursor` comes from the previous page.
    async fn list_decided(&self, _cursor: Option<&str>, _limit: u32) -> AccessResult<Page<AccessRequest>> {
        Err(AccessError::Unsupported("This provider has no decision history".into()))
    }

    /// Connection details for a ready request, without the secret. Fails with
    /// `NotReady` / `NoRevealsLeft` when no credential can be fetched.
    async fn connection_plan(&self, request_id: &str) -> AccessResult<ConnectionPlan>;
    /// Fetches the secret for a plan. May consume the provider's reveal budget:
    /// [`manage::connect`] calls it at most once per saved connection.
    async fn fetch_credentials(&self, plan: &ConnectionPlan) -> AccessResult<Credentials>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_rules() {
        assert_eq!(normalize_base_url(" https://access.example.com/ ").unwrap(), "https://access.example.com");
        assert_eq!(normalize_base_url("https://access.example.com/api/v1/").unwrap(), "https://access.example.com");
        assert_eq!(normalize_base_url("https://example.com/tools/access").unwrap(), "https://example.com/tools/access");
        assert_eq!(normalize_base_url("http://localhost:8510").unwrap(), "http://localhost:8510");
        assert_eq!(normalize_base_url("http://127.0.0.1:8510/").unwrap(), "http://127.0.0.1:8510");
        for bad in ["http://access.example.com", "https://u:p@access.example.com", "https://access.example.com/?x=1", "ftp://access.example.com", "access", ""]
        {
            assert!(normalize_base_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn ids_are_checked() {
        assert!(check_id("3f2a-11_x").is_ok());
        for bad in ["", "../x", "a/b", "a?b", "a b"] {
            assert!(check_id(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn errors_carry_stable_codes() {
        let e: DbError = AccessError::SignedOut.into();
        assert_eq!(e.code.as_deref(), Some("access_signed_out"));
        assert_eq!(e.kind, ErrorKind::Authentication);
        let e: DbError = AccessError::Conflict("a pending request already exists".into()).into();
        assert_eq!(e.code.as_deref(), Some("access_conflict"));
        assert!(e.message.contains("pending request"));
    }

    #[test]
    fn provider_config_validation() {
        let c =
            ProviderConfig { id: Uuid::new_v4(), kind: "access-api".into(), name: "  Company access ".into(), base_url: "https://access.example.com/".into() };
        let v = c.clone().validated().unwrap();
        assert_eq!((v.name.as_str(), v.base_url.as_str()), ("Company access", "https://access.example.com"));
        assert!(ProviderConfig { kind: "nope".into(), ..c.clone() }.validated().is_err());
        // Stored / deployed configs: an unknown kind is read as the only registered kind.
        let resolved = ProviderConfig { kind: "nope".into(), ..c.clone() }.with_resolved_kind();
        assert_eq!(resolved.kind, if provider_kinds().len() == 1 { "access-api" } else { "nope" });
        assert!(ProviderConfig { name: " ".into(), ..c.clone() }.validated().is_err());
        assert!(ProviderConfig { base_url: "http://access.example.com".into(), ..c }.validated().is_err());
    }

    #[test]
    fn request_input_rules() {
        let ok = AccessRequestInput {
            resource_id: "s1".into(),
            access: AccessLevel::ReadOnly,
            reason: "ticket".into(),
            databases: vec!["app".into()],
            create_database: false,
            ticket: None,
        };
        assert!(ok.validate().is_ok());
        assert!(AccessRequestInput { reason: " ".into(), ..ok.clone() }.validate().is_err());
        assert!(AccessRequestInput { databases: vec![], ..ok.clone() }.validate().is_err());
        assert!(AccessRequestInput { create_database: true, databases: vec!["bad name".into()], ..ok.clone() }.validate().is_err());
        assert!(AccessRequestInput { create_database: true, databases: vec!["new_db".into()], ..ok.clone() }.validate().is_ok());
        assert!(AccessRequestInput { ticket: Some(" OPS-123 ".into()), ..ok.clone() }.validate().is_ok());
        assert!(AccessRequestInput { ticket: Some("  ".into()), ..ok.clone() }.validate().is_ok(), "blank = none");
        assert!(AccessRequestInput { ticket: Some("OPS 123".into()), ..ok.clone() }.validate().is_err());
        assert!(AccessRequestInput { ticket: Some("[x]".into()), ..ok }.validate().is_err());
    }
}
