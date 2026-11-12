//! Access API: Lord of the Rows' own HTTP protocol for access-management services
//! (specified in `docs/access-api.md`). Developers request time-boxed database
//! access, an approver decides, the server provisions a personal database user, and
//! the password can be revealed a limited number of times. Sign-in happens in the
//! browser (whatever single sign-on the server uses) and is handed to the desktop
//! through a PKCE loopback redirect (`/auth/desktop/start|token`).
//!
//! This module is also the reference implementation for adding a provider type.

pub mod client;
pub mod mapping;
mod model;

use async_trait::async_trait;

use self::client::Client;
use self::model::CreateRequest;
use crate::loopback;
use crate::{
    now_unix, AccessError, AccessProvider, AccessRequest, AccessRequestInput, AccessResult, AccessUser, Capabilities, ConnectionPlan, Credentials, Resource,
    SignInContext, SignedIn, TargetList,
};

pub const KIND: &str = "access-api";

pub struct AccessApiProvider {
    client: Client,
}

impl AccessApiProvider {
    pub fn new(base_url: &str, token: Option<String>) -> AccessResult<Self> {
        Ok(Self { client: Client::new(base_url, token)? })
    }
}

fn user(u: model::User) -> AccessUser {
    let can_approve = u.is_approver();
    // The server refuses requests from users without a manager (nobody could approve them).
    let blocked = (u.role == "developer" && u.manager_id.as_deref().unwrap_or("").is_empty()).then(|| "no_approver".to_string());
    AccessUser { id: u.user_id, email: u.email, name: u.name, role: u.role, can_approve, request_blocked: blocked }
}

#[async_trait]
impl AccessProvider for AccessApiProvider {
    fn kind(&self) -> &'static str {
        KIND
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities { approvals: true, create_database: true, cancel: true, targets: true, decided_history: true }
    }

    async fn sign_in(&self, ctx: SignInContext<'_>) -> AccessResult<SignedIn> {
        let base = self.client.base_url().to_string();
        let auth = loopback::authorize(&ctx, |lb| {
            let mut u = url::Url::parse(&format!("{base}/api/v1/auth/desktop/start")).expect("normalised base URL");
            lb.append_params(&mut u);
            u.query_pairs_mut().append_pair("device_name", ctx.device_name);
            u.into()
        })
        .await?;
        let tok = tokio::select! {
            _ = ctx.cancel.cancelled() => return Err(AccessError::Cancelled),
            r = self.client.exchange_code(&auth.code, &auth.verifier, &auth.redirect_uri) => r?,
        };
        let expires_at = (tok.expires_at > 0).then_some(tok.expires_at);
        Ok(SignedIn { token: tok.token, user: user(tok.user), expires_at })
    }

    async fn sign_out(&self) -> AccessResult<()> {
        self.client.logout().await
    }

    async fn current_user(&self) -> AccessResult<AccessUser> {
        Ok(user(self.client.me().await?))
    }

    async fn list_resources(&self) -> AccessResult<Vec<Resource>> {
        let mut out: Vec<Resource> = self.client.services().await?.iter().filter_map(mapping::resource).collect();
        out.sort_by_key(|r| (r.environment_name.to_lowercase(), r.name.to_lowercase()));
        Ok(out)
    }

    async fn resource_targets(&self, resource_id: &str) -> AccessResult<TargetList> {
        // A server without a target lister answers 503; that (like any listing failure) is a
        // soft error: the user can still type database names.
        let t = match self.client.service_targets(resource_id).await {
            Ok(t) => t,
            Err(e @ (AccessError::SignedOut | AccessError::Unreachable(_))) => return Err(e),
            Err(e) => return Ok(TargetList { targets: vec![], error: Some(e.to_string()) }),
        };
        Ok(if t.ok {
            TargetList { targets: t.targets, error: None }
        } else {
            TargetList { targets: vec![], error: Some(t.error.unwrap_or_else(|| "unknown error".into())) }
        })
    }

    async fn create_request(&self, input: &AccessRequestInput) -> AccessResult<AccessRequest> {
        input.validate()?;
        let w = CreateRequest {
            service_instance_id: input.resource_id.clone(),
            access_type: mapping::access_type(input.access).into(),
            // The protocol has no ticket field: it travels as a "[OPS-123] " prefix of the reason.
            reason: match input.ticket() {
                Some(t) => format!("[{t}] {}", input.reason.trim()),
                None => input.reason.trim().into(),
            },
            target_databases: input.databases.iter().map(|d| d.trim().to_string()).collect(),
            create_database: input.create_database,
        };
        Ok(mapping::request(&self.client.create_request(&w).await?, now_unix()))
    }

    async fn list_requests(&self) -> AccessResult<Vec<AccessRequest>> {
        let now = now_unix();
        Ok(self.client.my_requests().await?.iter().map(|r| mapping::request(r, now)).collect())
    }

    async fn get_request(&self, request_id: &str) -> AccessResult<AccessRequest> {
        Ok(mapping::request(&self.client.request(request_id).await?, now_unix()))
    }

    async fn cancel_request(&self, request_id: &str) -> AccessResult<AccessRequest> {
        let mut r = mapping::request(&self.client.revoke(request_id).await?, now_unix());
        // The revoke response may predate the transition; it ended either way.
        if !r.is_ended(now_unix()) {
            r.status = crate::RequestStatus::Revoked;
        }
        Ok(r)
    }

    async fn list_approvals(&self) -> AccessResult<Vec<AccessRequest>> {
        let now = now_unix();
        Ok(self.client.approvals().await?.iter().map(|r| mapping::request(r, now)).collect())
    }

    async fn approve(&self, request_id: &str) -> AccessResult<AccessRequest> {
        Ok(mapping::request(&self.client.approve(request_id).await?, now_unix()))
    }

    async fn reject(&self, request_id: &str, reason: &str) -> AccessResult<AccessRequest> {
        Ok(mapping::request(&self.client.reject(request_id, reason).await?, now_unix()))
    }

    async fn list_decided(&self, cursor: Option<&str>, limit: u32) -> AccessResult<crate::Page<AccessRequest>> {
        let now = now_unix();
        let p = self.client.decided(cursor, limit).await?;
        Ok(crate::Page { items: p.items.iter().map(|r| mapping::request(r, now)).collect(), next: p.next.filter(|n| !n.is_empty()) })
    }

    async fn connection_plan(&self, request_id: &str) -> AccessResult<ConnectionPlan> {
        let now = now_unix();
        let wire = self.client.request(request_id).await?;
        let req = mapping::request(&wire, now);
        let not_ready = match req.status {
            crate::RequestStatus::Ready => None,
            crate::RequestStatus::Pending => Some("This request is still waiting for approval.".to_string()),
            crate::RequestStatus::Provisioning => Some("This request is still being provisioned.".to_string()),
            crate::RequestStatus::Failed => Some(format!("Provisioning failed: {}", req.status_detail.as_deref().unwrap_or("no details"))),
            _ => Some("This access has ended. Request access again.".to_string()),
        };
        if let Some(m) = not_ready {
            return Err(AccessError::NotReady(m));
        }
        let cred = self
            .client
            .credentials(request_id)
            .await?
            .into_iter()
            .find(|c| c.credential_type == "db_password" && c.status == "active")
            .ok_or_else(|| AccessError::NotFound("the access provider has no active database password for this request".into()))?;
        if cred.reveals_remaining() == Some(0) {
            return Err(AccessError::NoRevealsLeft("No password reveals are left for this request. Request access again.".into()));
        }
        mapping::plan(&wire, &cred)
    }

    async fn fetch_credentials(&self, plan: &ConnectionPlan) -> AccessResult<Credentials> {
        let id = plan.credential_ref.as_deref().ok_or_else(|| AccessError::NotFound("no credential to reveal".into()))?;
        let r = self.client.reveal(id).await?;
        Ok(Credentials { password: r.password, reveals_remaining: r.reveals_remaining })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::loopback::challenge_for;
    use crate::testing::{MockServer, Reply};
    use crate::{AccessLevel, RequestStatus};

    /// A mock Access API server whose `/auth/desktop/start` redirects straight back with a code, and
    /// whose token endpoint checks the PKCE verifier against the challenge it saw.
    async fn mock_server() -> MockServer {
        let challenge: Arc<Mutex<String>> = Arc::default();
        MockServer::start(move |req| {
            if req.path.starts_with("/api/v1/auth/desktop/start?") {
                let q: Vec<(String, String)> = url::form_urlencoded::parse(req.path.split_once('?').unwrap().1.as_bytes()).into_owned().collect();
                let get = |k: &str| q.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()).unwrap_or_default();
                assert_eq!(get("device_name"), "Lord of the Rows on test-mac");
                *challenge.lock().unwrap() = get("code_challenge");
                return Reply::redirect(&format!("{}?code=abc123&state={}", get("redirect_uri"), get("state")));
            }
            match (req.method.as_str(), req.path.as_str()) {
                ("POST", "/api/v1/auth/desktop/token") => {
                    let v: serde_json::Value = serde_json::from_str(&req.body).unwrap();
                    if v["code"] != "abc123" || challenge_for(v["code_verifier"].as_str().unwrap()) != *challenge.lock().unwrap() {
                        return Reply::json(400, r#"{"error":"invalid code"}"#);
                    }
                    Reply::json(200, r#"{"token":"tok_abc","tokenId":"t1","expiresAt":4102444800,"user":{"userId":"u1","email":"dev@example.com","name":"Dev","role":"developer"}}"#)
                }
                ("GET", "/api/v1/requests/r1") => Reply::json(
                    200,
                    r#"{"requestId":"r1","status":"approved","provisioningStatus":"provisioned","accessType":"read_write","serviceName":"orders","environmentName":"staging","driverKey":"rds-postgres","engine":"postgres","endpoint":"orders.db.example.com","port":5432,"targetDatabases":["shop"],"expiresAt":4102444800}"#,
                ),
                ("GET", "/api/v1/requests/r2") => Reply::json(200, r#"{"requestId":"r2","status":"pending"}"#),
                ("GET", "/api/v1/credentials?requestId=r1") => Reply::json(200, r#"[{"credentialId":"c1","username":"dev_r1","credentialType":"db_password","status":"active","viewCount":0,"maxViews":5}]"#),
                ("POST", "/api/v1/credentials/c1/reveal") => Reply::json(200, r#"{"password":"pw-1","revealsRemaining":4}"#),
                ("GET", "/api/v1/approvals/decided?limit=50") => Reply::json(
                    200,
                    r#"{"items":[{"requestId":"d1","status":"rejected","rejectReason":"not now","reviewedAt":"2027-01-01T10:00:00Z","requesterName":"Robin"}],"next":"c2"}"#,
                ),
                ("GET", "/api/v1/approvals/decided?limit=50&cursor=c2") => Reply::json(200, r#"{"items":[{"requestId":"d2","status":"expired"}],"next":null}"#),
                ("GET", "/api/v1/services/s1/targets") => Reply::json(503, r#"{"error":"targets not configured"}"#),
                ("GET", "/api/v1/services/s2/targets") => Reply::json(200, r#"{"ok":false,"error":"connection refused"}"#),
                ("GET", "/api/v1/services/s3/targets") => Reply::json(200, r#"{"ok":true,"targets":["app","audit"]}"#),
                ("POST", "/api/v1/requests") => {
                    let v: serde_json::Value = serde_json::from_str(&req.body).unwrap();
                    assert_eq!((v["accessType"].as_str(), v["requestType"].as_str()), (Some("read"), Some("developer")));
                    assert_eq!(v["reason"], "[OPS-123] ticket");
                    Reply::json(201, r#"{"requestId":"r9","status":"pending","accessType":"read","serviceInstanceId":"s1","reason":"[OPS-123] ticket"}"#)
                }
                _ => Reply::json(404, r#"{"error":"not found"}"#),
            }
        })
        .await
    }

    fn browser(url: &str) -> AccessResult<()> {
        let url = url.to_string();
        tokio::spawn(async move {
            let _ = reqwest::get(&url).await;
        });
        Ok(())
    }

    #[tokio::test]
    async fn sign_in_exchanges_code_with_verifier() {
        let srv = mock_server().await;
        let p = AccessApiProvider::new(&srv.url(), None).unwrap();
        let s = p
            .sign_in(SignInContext {
                device_name: "Lord of the Rows on test-mac",
                open_browser: &browser,
                cancel: CancellationToken::new(),
                timeout: Duration::from_secs(10),
            })
            .await
            .unwrap();
        assert_eq!(s.token, "tok_abc");
        assert_eq!(s.user.email, "dev@example.com");
        assert_eq!(s.user.request_blocked.as_deref(), Some("no_approver"), "developer without a manager");
        assert!(!s.user.can_approve);
        assert!(!format!("{s:?}").contains("tok_abc"));
        assert_eq!(srv.count("POST", "/api/v1/auth/desktop/token"), 1);
    }

    #[tokio::test]
    async fn plan_then_fetch_reveals_once() {
        let srv = mock_server().await;
        let p = AccessApiProvider::new(&srv.url(), Some("tok_x".into())).unwrap();
        let plan = p.connection_plan("r1").await.unwrap();
        assert_eq!(srv.count("POST", "/api/v1/credentials/c1/reveal"), 0, "planning never reveals");
        assert_eq!((plan.username.as_str(), plan.reveals_remaining), ("dev_r1", Some(5)));
        let c = p.fetch_credentials(&plan).await.unwrap();
        assert_eq!(c.password.expose(), "pw-1");
        assert_eq!(c.reveals_remaining, Some(4));
        assert!(matches!(p.connection_plan("r2").await, Err(AccessError::NotReady(m)) if m.contains("waiting for approval")));
    }

    #[tokio::test]
    async fn create_request_maps_access_level() {
        let srv = mock_server().await;
        let p = AccessApiProvider::new(&srv.url(), Some("tok_x".into())).unwrap();
        let input = AccessRequestInput {
            resource_id: "s1".into(),
            access: AccessLevel::ReadOnly,
            reason: "ticket".into(),
            databases: vec!["app".into()],
            create_database: false,
            ticket: Some("OPS-123".into()),
        };
        let r = p.create_request(&input).await.unwrap();
        assert_eq!((r.id.as_str(), r.status), ("r9", RequestStatus::Pending));
        assert_eq!((r.ticket.as_deref(), r.reason.as_str()), (Some("OPS-123"), "ticket"));
        let n = srv.requests().len();
        assert!(p.create_request(&AccessRequestInput { reason: " ".into(), ..input }).await.is_err());
        assert_eq!(srv.requests().len(), n, "validated before sending");
    }

    #[tokio::test]
    async fn target_listing_failures_are_soft() {
        let srv = mock_server().await;
        let p = AccessApiProvider::new(&srv.url(), Some("tok_x".into())).unwrap();
        let t = p.resource_targets("s1").await.unwrap();
        assert!(t.targets.is_empty() && t.error.as_deref().unwrap().contains("targets not configured"), "{t:?}");
        assert_eq!(p.resource_targets("s2").await.unwrap().error.as_deref(), Some("connection refused"));
        assert_eq!(p.resource_targets("s3").await.unwrap().targets, vec!["app", "audit"]);
    }

    #[tokio::test]
    async fn decided_history_pages_and_old_servers() {
        let srv = mock_server().await;
        let p = AccessApiProvider::new(&srv.url(), Some("tok_x".into())).unwrap();
        let page = p.list_decided(None, 50).await.unwrap();
        assert_eq!(page.items[0].status, RequestStatus::Rejected);
        assert_eq!(page.items[0].status_detail.as_deref(), Some("not now"));
        assert_eq!(page.items[0].decided_at.as_deref(), Some("2027-01-01T10:00:00Z"));
        assert_eq!(page.next.as_deref(), Some("c2"));
        let last = p.list_decided(Some("c2"), 50).await.unwrap();
        assert_eq!((last.items[0].status, last.next), (RequestStatus::Expired, None));
        // An older server (no endpoint): 404 -> Unsupported, so the UI hides the tab.
        let old = MockServer::start(|_| Reply::json(404, r#"{"error":"not found"}"#)).await;
        let p = AccessApiProvider::new(&old.url(), Some("tok_x".into())).unwrap();
        assert!(matches!(p.list_decided(None, 50).await, Err(AccessError::Unsupported(_))));
        assert!(p.list_decided(Some("bad\ncursor"), 50).await.is_err());
    }
}
