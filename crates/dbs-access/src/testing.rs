//! Test helpers: a tiny HTTP/1.1 mock server (no extra dependencies) and an
//! in-memory [`FakeProvider`]. Each mock-server
//! connection carries one request; replies close the connection.

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone)]
pub struct Req {
    pub method: String,
    /// Path including the query string.
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Req {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

pub struct Reply {
    pub status: u16,
    pub body: String,
    pub headers: Vec<(String, String)>,
}

impl Reply {
    pub fn json(status: u16, body: &str) -> Self {
        Reply { status, body: body.to_string(), headers: vec![("content-type".into(), "application/json".into())] }
    }
    pub fn redirect(location: &str) -> Self {
        Reply { status: 302, body: String::new(), headers: vec![("location".into(), location.to_string())] }
    }
}

type Handler = Arc<dyn Fn(&Req) -> Reply + Send + Sync>;

pub struct MockServer {
    port: u16,
    log: Arc<Mutex<Vec<Req>>>,
    task: tokio::task::JoinHandle<()>,
}

impl MockServer {
    pub async fn start(handler: impl Fn(&Req) -> Reply + Send + Sync + 'static) -> Self {
        let l = TcpListener::bind("127.0.0.1:0").await.expect("bind mock server");
        let port = l.local_addr().unwrap().port();
        let log: Arc<Mutex<Vec<Req>>> = Arc::default();
        let handler: Handler = Arc::new(handler);
        let log2 = log.clone();
        let task = tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                let handler = handler.clone();
                let log = log2.clone();
                tokio::spawn(async move {
                    let Some(req) = read_request(&mut s).await else { return };
                    log.lock().unwrap().push(req.clone());
                    let r = handler(&req);
                    let mut head = format!("HTTP/1.1 {} X\r\ncontent-length: {}\r\nconnection: close\r\n", r.status, r.body.len());
                    for (k, v) in &r.headers {
                        head.push_str(&format!("{k}: {v}\r\n"));
                    }
                    head.push_str("\r\n");
                    let _ = s.write_all(head.as_bytes()).await;
                    let _ = s.write_all(r.body.as_bytes()).await;
                    let _ = s.shutdown().await;
                });
            }
        });
        MockServer { port, log, task }
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Requests received so far, in order.
    pub fn requests(&self) -> Vec<Req> {
        self.log.lock().unwrap().clone()
    }

    pub fn count(&self, method: &str, path: &str) -> usize {
        self.requests().iter().filter(|r| r.method == method && r.path == path).count()
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn read_request(s: &mut tokio::net::TcpStream) -> Option<Req> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = s.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let path = first.next()?.to_string();
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
    let len: usize = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < len {
        let n = s.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Some(Req { method, path, headers, body: String::from_utf8_lossy(&body).to_string() })
}

// ---------------------------------------------------------------- in-memory provider

use async_trait::async_trait;
use dbs_core::{Engine, EnvironmentKind, TlsMode};
use dbs_secrets::Secret;

use crate::{
    AccessError, AccessLevel, AccessProvider, AccessRequest, AccessRequestInput, AccessResult, AccessUser, Capabilities, ConnectionPlan, Credentials, Person,
    RequestStatus, Resource, SignInContext, SignedIn, TargetList,
};

type PlanEdit = Box<dyn Fn(&mut ConnectionPlan) + Send + Sync>;

#[derive(Default)]
struct FakeState {
    requests: Vec<AccessRequest>,
    approvals: Vec<AccessRequest>,
    /// Reveals left (`None` = unlimited).
    budget: Option<i64>,
    fetches: usize,
    calls: usize,
    plan_edit: Option<PlanEdit>,
}

/// An in-memory [`AccessProvider`] for tests of the provider-independent logic.
/// Plans connect to `db.example.com` (PostgreSQL, staging); passwords are `pw-<request id>`.
pub struct FakeProvider {
    state: Mutex<FakeState>,
}

impl Default for FakeProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeProvider {
    pub fn new() -> Self {
        FakeProvider { state: Mutex::new(FakeState { budget: Some(5), ..Default::default() }) }
    }
    pub fn add_request(&self, id: &str, status: RequestStatus, expires_at: Option<i64>) {
        self.state.lock().unwrap().requests.push(AccessRequest {
            id: id.into(),
            resource_id: "res-1".into(),
            resource_name: "orders".into(),
            environment_name: "staging".into(),
            environment: EnvironmentKind::Staging,
            engine: Some(Engine::Postgres),
            access: Some(AccessLevel::ReadWrite),
            reason: "testing".into(),
            databases: vec!["shop".into()],
            status,
            expires_at,
            requester: Person { id: "u1".into(), name: "Dev".into(), email: "dev@example.com".into() },
            ..Default::default()
        });
    }
    pub fn add_approval(&self, r: AccessRequest) {
        self.state.lock().unwrap().approvals.push(r);
    }
    pub fn request(&self, id: &str) -> AccessRequest {
        self.state.lock().unwrap().requests.iter().find(|r| r.id == id).cloned().expect("request")
    }
    pub fn set_budget(&self, b: Option<i64>) {
        self.state.lock().unwrap().budget = b;
    }
    pub fn with_plan(&self, f: impl Fn(&mut ConnectionPlan) + Send + Sync + 'static) {
        self.state.lock().unwrap().plan_edit = Some(Box::new(f));
    }
    /// Secrets fetched so far.
    pub fn fetches(&self) -> usize {
        self.state.lock().unwrap().fetches
    }
    /// Provider calls so far.
    pub fn calls(&self) -> usize {
        self.state.lock().unwrap().calls
    }
    fn tick(&self) -> std::sync::MutexGuard<'_, FakeState> {
        let mut s = self.state.lock().unwrap();
        s.calls += 1;
        s
    }
}

#[async_trait]
impl AccessProvider for FakeProvider {
    fn kind(&self) -> &'static str {
        "fake"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities { approvals: true, create_database: false, cancel: true, targets: true }
    }
    async fn sign_in(&self, _ctx: SignInContext<'_>) -> AccessResult<SignedIn> {
        Ok(SignedIn { token: "fake-token".into(), user: self.current_user().await?, expires_at: None })
    }
    async fn sign_out(&self) -> AccessResult<()> {
        Ok(())
    }
    async fn current_user(&self) -> AccessResult<AccessUser> {
        Ok(AccessUser {
            id: "u1".into(),
            email: "dev@example.com".into(),
            name: "Dev".into(),
            role: "manager".into(),
            can_approve: true,
            request_blocked: None,
        })
    }
    async fn list_resources(&self) -> AccessResult<Vec<Resource>> {
        Ok(vec![Resource {
            id: "res-1".into(),
            name: "orders".into(),
            environment_name: "staging".into(),
            environment: EnvironmentKind::Staging,
            engine: Engine::Postgres,
            host: Some("db.example.com".into()),
            port: Some(5432),
            access_levels: vec![AccessLevel::ReadOnly, AccessLevel::ReadWrite],
        }])
    }
    async fn resource_targets(&self, _id: &str) -> AccessResult<TargetList> {
        Ok(TargetList { targets: vec!["shop".into()], error: None })
    }
    async fn create_request(&self, input: &AccessRequestInput) -> AccessResult<AccessRequest> {
        input.validate()?;
        let id = format!("r{}", self.tick().requests.len() + 1);
        self.add_request(&id, RequestStatus::Pending, None);
        Ok(self.request(&id))
    }
    async fn list_requests(&self) -> AccessResult<Vec<AccessRequest>> {
        Ok(self.tick().requests.clone())
    }
    async fn get_request(&self, id: &str) -> AccessResult<AccessRequest> {
        self.tick().requests.iter().find(|r| r.id == id).cloned().ok_or_else(|| AccessError::NotFound("request not found".into()))
    }
    async fn cancel_request(&self, id: &str) -> AccessResult<AccessRequest> {
        let mut s = self.tick();
        let r = s.requests.iter_mut().find(|r| r.id == id).ok_or_else(|| AccessError::NotFound("request not found".into()))?;
        r.status = if r.status == RequestStatus::Pending { RequestStatus::Cancelled } else { RequestStatus::Revoked };
        Ok(r.clone())
    }
    async fn list_approvals(&self) -> AccessResult<Vec<AccessRequest>> {
        Ok(self.tick().approvals.clone())
    }
    async fn approve(&self, id: &str) -> AccessResult<AccessRequest> {
        let mut s = self.tick();
        let i = s.approvals.iter().position(|r| r.id == id).ok_or_else(|| AccessError::NotFound("request not found".into()))?;
        let mut r = s.approvals.remove(i);
        r.status = RequestStatus::Provisioning;
        Ok(r)
    }
    async fn reject(&self, id: &str, reason: &str) -> AccessResult<AccessRequest> {
        let mut s = self.tick();
        let i = s.approvals.iter().position(|r| r.id == id).ok_or_else(|| AccessError::NotFound("request not found".into()))?;
        let mut r = s.approvals.remove(i);
        r.status = RequestStatus::Rejected;
        r.status_detail = Some(reason.into());
        Ok(r)
    }
    async fn connection_plan(&self, id: &str) -> AccessResult<ConnectionPlan> {
        let s = self.tick();
        let r = s.requests.iter().find(|r| r.id == id).ok_or_else(|| AccessError::NotFound("request not found".into()))?;
        if r.status != RequestStatus::Ready {
            return Err(AccessError::NotReady("This request is not ready.".into()));
        }
        if s.budget == Some(0) {
            return Err(AccessError::NoRevealsLeft("No reveals left.".into()));
        }
        let mut plan = ConnectionPlan {
            request_id: id.into(),
            credential_ref: Some(format!("cred-{id}")),
            name: format!("{} · shop", r.resource_name),
            engine: Engine::Postgres,
            host: "db.example.com".into(),
            port: Some(5432),
            database: Some("shop".into()),
            username: format!("dev_{id}"),
            environment: EnvironmentKind::Staging,
            read_only: r.access == Some(AccessLevel::ReadOnly),
            tls: TlsMode::Required,
            expires_at: r.expires_at,
            reveals_remaining: s.budget,
        };
        if let Some(f) = &s.plan_edit {
            f(&mut plan);
        }
        Ok(plan)
    }
    async fn fetch_credentials(&self, plan: &ConnectionPlan) -> AccessResult<Credentials> {
        let mut s = self.tick();
        if s.budget == Some(0) {
            return Err(AccessError::NoRevealsLeft("No reveals left.".into()));
        }
        s.fetches += 1;
        s.budget = s.budget.map(|b| b - 1);
        Ok(Credentials { password: Secret::new(format!("pw-{}", plan.request_id)), reveals_remaining: s.budget })
    }
}
