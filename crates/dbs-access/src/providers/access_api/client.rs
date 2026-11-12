//! Access API JSON client (`/api/v1`, bearer token). See `docs/access-api.md`.

use std::time::Duration;

use dbs_secrets::Secret;
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;

use super::model::*;
use crate::{check_id, normalize_base_url, AccessError, AccessResult};

pub const USER_AGENT: &str = concat!("LordOfTheRows/", env!("CARGO_PKG_VERSION"));

const TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// Access API client. Cheap to build; holds no connection state.
pub struct Client {
    base: String,
    http: reqwest::Client,
    token: Option<String>,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client").field("base", &self.base).field("token", &self.token.as_ref().map(|_| "***")).finish()
    }
}

impl Client {
    pub fn new(base_url: &str, token: Option<String>) -> AccessResult<Self> {
        let base = normalize_base_url(base_url)?;
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(USER_AGENT)
            .build()
            .map_err(|e| AccessError::Other(format!("HTTP client: {e}")))?;
        Ok(Self { base, http, token })
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    fn host(&self) -> String {
        url::Url::parse(&self.base).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_else(|| self.base.clone())
    }

    async fn call<T: DeserializeOwned>(&self, method: Method, path: &str, body: Option<serde_json::Value>) -> AccessResult<T> {
        let bytes = self.call_raw(method, path, body).await?;
        let bytes = if bytes.is_empty() { b"null".to_vec() } else { bytes };
        serde_json::from_slice(&bytes).map_err(|e| AccessError::Other(format!("the access provider sent an unexpected response ({path}): {e}")))
    }

    async fn call_raw(&self, method: Method, path: &str, body: Option<serde_json::Value>) -> AccessResult<Vec<u8>> {
        let url = format!("{}/api/v1{path}", self.base);
        let mut req = self.http.request(method, &url).header("accept", "application/json");
        if let Some(t) = &self.token {
            req = req.header("authorization", format!("Bearer {t}"));
        }
        if let Some(b) = body {
            let bytes = serde_json::to_vec(&b).map_err(|e| AccessError::Other(e.to_string()))?;
            req = req.header("content-type", "application/json").body(bytes);
        }
        let resp = req.send().await.map_err(|e| unreachable(&self.host(), &e))?;
        let status = resp.status();
        let bytes = resp.bytes().await.map_err(|e| unreachable(&self.host(), &e))?.to_vec();
        if status.is_success() {
            return Ok(bytes);
        }
        Err(status_error(status, &bytes))
    }

    /// Exchanges the one-time code from the loopback redirect for a desktop token.
    pub async fn exchange_code(&self, code: &str, verifier: &str, redirect_uri: &str) -> AccessResult<TokenResponse> {
        let body = serde_json::json!({ "code": code, "code_verifier": verifier, "redirect_uri": redirect_uri });
        self.call(Method::POST, "/auth/desktop/token", Some(body)).await
    }

    pub async fn me(&self) -> AccessResult<User> {
        let r: MeResponse = self.call(Method::GET, "/auth/me", None).await?;
        Ok(r.user)
    }

    /// Revokes the token server-side.
    pub async fn logout(&self) -> AccessResult<()> {
        self.call_raw(Method::POST, "/auth/logout", None).await.map(|_| ())
    }

    /// The service catalog (all pages).
    pub async fn services(&self) -> AccessResult<Vec<Service>> {
        let r: ServiceList = self.call(Method::GET, "/services", None).await?;
        Ok(r.items)
    }

    pub async fn service_targets(&self, service_id: &str) -> AccessResult<Targets> {
        check_id(service_id)?;
        self.call(Method::GET, &format!("/services/{service_id}/targets"), None).await
    }

    pub async fn create_request(&self, input: &CreateRequest) -> AccessResult<AccessRequest> {
        self.call(Method::POST, "/requests", Some(input.wire())).await
    }

    /// The signed-in user's requests, newest first (without provisioning logs).
    pub async fn my_requests(&self) -> AccessResult<Vec<AccessRequest>> {
        let v: Option<Vec<AccessRequest>> = self.call(Method::GET, "/requests", None).await?;
        Ok(v.unwrap_or_default())
    }

    /// One request, with its provisioning log.
    pub async fn request(&self, id: &str) -> AccessResult<AccessRequest> {
        check_id(id)?;
        self.call(Method::GET, &format!("/requests/{id}"), None).await
    }

    /// Cancels a pending request (or gives up approved access).
    pub async fn revoke(&self, id: &str) -> AccessResult<AccessRequest> {
        check_id(id)?;
        self.call(Method::POST, &format!("/requests/{id}/revoke"), None).await
    }

    /// Requests waiting for the signed-in approver.
    pub async fn approvals(&self) -> AccessResult<Vec<AccessRequest>> {
        let v: Option<Vec<AccessRequest>> = self.call(Method::GET, "/approvals", None).await?;
        Ok(v.unwrap_or_default())
    }

    /// Requests the caller decided, newest decision first. An older server without the
    /// endpoint answers 404, reported as `Unsupported`.
    pub async fn decided(&self, cursor: Option<&str>, limit: u32) -> AccessResult<DecidedPage> {
        let query = {
            let mut q = url::form_urlencoded::Serializer::new(String::new());
            q.append_pair("limit", &limit.clamp(1, 100).to_string());
            if let Some(c) = cursor {
                if c.is_empty() || c.len() > 1024 || c.chars().any(char::is_control) {
                    return Err(AccessError::Invalid("invalid page cursor".into()));
                }
                q.append_pair("cursor", c);
            }
            q.finish()
        };
        match self.call(Method::GET, &format!("/approvals/decided?{query}"), None).await {
            Err(AccessError::NotFound(_)) => Err(AccessError::Unsupported("This access provider has no decision history yet".into())),
            r => r,
        }
    }

    pub async fn approve(&self, id: &str) -> AccessResult<AccessRequest> {
        check_id(id)?;
        self.call(Method::POST, &format!("/requests/{id}/approve"), None).await
    }

    pub async fn reject(&self, id: &str, reason: &str) -> AccessResult<AccessRequest> {
        check_id(id)?;
        let reason = reason.trim();
        if reason.is_empty() || reason.len() > 2000 {
            return Err(AccessError::Invalid("A reason (up to 2000 characters) is required to reject a request".into()));
        }
        self.call(Method::POST, &format!("/requests/{id}/reject"), Some(serde_json::json!({ "reason": reason }))).await
    }

    /// Credentials issued for a request that the signed-in user may see.
    pub async fn credentials(&self, request_id: &str) -> AccessResult<Vec<Credential>> {
        check_id(request_id)?;
        let v: Option<Vec<Credential>> = self.call(Method::GET, &format!("/credentials?requestId={request_id}"), None).await?;
        Ok(v.unwrap_or_default())
    }

    /// Reveals a stored password. Each call spends one reveal of the credential's budget.
    pub async fn reveal(&self, credential_id: &str) -> AccessResult<Revealed> {
        check_id(credential_id)?;
        let r: RevealResponse = self.call(Method::POST, &format!("/credentials/{credential_id}/reveal"), None).await?;
        let remaining = (r.reveals_remaining < i32::MAX as i64).then_some(r.reveals_remaining);
        Ok(Revealed { password: Secret::new(r.password), reveals_remaining: remaining })
    }
}

fn unreachable(host: &str, e: &reqwest::Error) -> AccessError {
    let what = if e.is_timeout() {
        "timed out"
    } else if e.is_connect() {
        "could not connect"
    } else {
        "request failed"
    };
    AccessError::Unreachable(format!("Can't reach the access provider at {host} ({what}). Are you on the VPN?"))
}

/// Maps a non-2xx response. Error bodies are `{"error": "<message>"}`.
pub fn status_error(status: StatusCode, body: &[u8]) -> AccessError {
    let server_msg = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|m| m.as_str()).map(clean_message))
        .filter(|m| !m.is_empty());
    let msg = |fallback: &str| server_msg.clone().unwrap_or_else(|| fallback.to_string());
    match status.as_u16() {
        401 => AccessError::SignedOut,
        403 => AccessError::Forbidden(msg("the access provider does not allow this action for your account")),
        404 => AccessError::NotFound(msg("not found at the access provider")),
        409 => AccessError::Conflict(msg("this conflicts with the current state at the access provider")),
        429 => AccessError::NoRevealsLeft(msg("no reveals left")),
        400 | 422 => AccessError::Invalid(msg("the access provider rejected the request")),
        code => AccessError::Other(format!("access provider error (HTTP {code}): {}", msg("no details"))),
    }
}

fn clean_message(s: &str) -> String {
    let s: String = s.chars().filter(|c| !c.is_control()).take(500).collect();
    s.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{MockServer, Reply};

    #[test]
    fn status_mapping() {
        assert_eq!(status_error(StatusCode::UNAUTHORIZED, br#"{"error":"authentication required"}"#), AccessError::SignedOut);
        let e = status_error(StatusCode::FORBIDDEN, br#"{"error":"you do not have a manager assigned yet"}"#);
        assert!(matches!(&e, AccessError::Forbidden(m) if m.contains("manager")), "{e:?}");
        let e = status_error(StatusCode::CONFLICT, br#"{"error":"a pending request for this service already exists"}"#);
        assert!(matches!(&e, AccessError::Conflict(m) if m.contains("pending request")), "{e:?}");
        assert!(matches!(status_error(StatusCode::TOO_MANY_REQUESTS, br#"{"error":"no reveals left"}"#), AccessError::NoRevealsLeft(_)));
        assert!(status_error(StatusCode::BAD_GATEWAY, b"<html>").to_string().contains("HTTP 502"));
    }

    #[tokio::test]
    async fn bearer_token_user_agent_and_401() {
        let srv = MockServer::start(|req| {
            if req.header("authorization") != Some("Bearer tok_good") {
                return Reply::json(401, r#"{"error":"authentication required"}"#);
            }
            assert!(req.header("user-agent").unwrap_or("").starts_with("LordOfTheRows/"));
            Reply::json(200, r#"{"user":{"userId":"u1","email":"dev@example.com","name":"Dev","role":"manager","managerId":"m1"},"csrfToken":""}"#)
        })
        .await;
        let ok = Client::new(&srv.url(), Some("tok_good".into())).unwrap();
        let u = ok.me().await.unwrap();
        assert_eq!(u.email, "dev@example.com");
        assert!(u.is_approver());
        assert_eq!(u.manager_id.as_deref(), Some("m1"));
        let bad = Client::new(&srv.url(), Some("tok_revoked".into())).unwrap();
        assert_eq!(bad.me().await.unwrap_err(), AccessError::SignedOut);
        assert!(!format!("{bad:?}").contains("tok_revoked"), "token never in Debug output");
    }

    #[tokio::test]
    async fn unreachable_server_mentions_vpn() {
        // A port nothing listens on.
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let c = Client::new(&format!("http://127.0.0.1:{port}"), None).unwrap();
        let e = c.me().await.unwrap_err();
        assert!(matches!(&e, AccessError::Unreachable(m) if m.contains("VPN")), "{e:?}");
    }

    #[tokio::test]
    async fn redirects_are_not_followed() {
        let srv =
            MockServer::start(|_| Reply { status: 302, body: String::new(), headers: vec![("location".into(), "http://127.0.0.1:1/steal".into())] }).await;
        let c = Client::new(&srv.url(), Some("tok_x".into())).unwrap();
        assert!(c.me().await.is_err());
        assert_eq!(srv.requests().len(), 1);
    }

    #[tokio::test]
    async fn reveal_and_lists() {
        let srv = MockServer::start(|req| match (req.method.as_str(), req.path.as_str()) {
            ("POST", "/api/v1/credentials/c1/reveal") => Reply::json(200, r#"{"password":"s3cret","revealsRemaining":4}"#),
            ("POST", "/api/v1/credentials/c2/reveal") => Reply::json(200, r#"{"password":"x","revealsRemaining":2147483647}"#),
            ("POST", "/api/v1/credentials/c3/reveal") => Reply::json(429, r#"{"error":"no reveals left"}"#),
            ("GET", "/api/v1/credentials?requestId=r1") => {
                Reply::json(200, r#"[{"credentialId":"c1","accessRequestId":"r1","username":"dev_r1","credentialType":"db_password","status":"active","viewCount":1,"maxViews":5,"createdAt":"2026-01-01T00:00:00Z"}]"#)
            }
            ("GET", "/api/v1/requests") => Reply::json(200, "null"),
            ("GET", "/api/v1/services") => Reply::json(
                200,
                r#"{"items":[{"serviceId":"s1","name":"orders","environmentId":"e1","driverKey":"rds-postgres","isActive":true,"environmentName":"staging","config":{"endpoint":"orders.example.com","port":5432,"engine":"postgres"}}],"total":1}"#,
            ),
            _ => Reply::json(404, r#"{"error":"not found"}"#),
        })
        .await;
        let c = Client::new(&srv.url(), Some("tok_x".into())).unwrap();
        let r = c.reveal("c1").await.unwrap();
        assert_eq!(r.password.expose(), "s3cret");
        assert_eq!(r.reveals_remaining, Some(4));
        assert!(!format!("{r:?}").contains("s3cret"));
        assert_eq!(c.reveal("c2").await.unwrap().reveals_remaining, None, "unlimited");
        assert!(matches!(c.reveal("c3").await.unwrap_err(), AccessError::NoRevealsLeft(_)));
        let creds = c.credentials("r1").await.unwrap();
        assert_eq!(creds[0].reveals_remaining(), Some(4));
        assert!(c.my_requests().await.unwrap().is_empty(), "null list");
        let svcs = c.services().await.unwrap();
        assert_eq!(svcs[0].config_str("endpoint").as_deref(), Some("orders.example.com"));
        assert_eq!(svcs[0].config_port(), Some(5432));
    }

    #[tokio::test]
    async fn create_request_body() {
        let srv = MockServer::start(|req| {
            let v: serde_json::Value = serde_json::from_str(&req.body).unwrap();
            assert_eq!(v["serviceInstanceId"], "s1");
            assert_eq!(v["accessType"], "read");
            assert_eq!(v["requestType"], "developer");
            assert_eq!(v["targetDatabases"][0], "app");
            assert!(v.get("createDatabase").is_none());
            Reply::json(201, r#"{"requestId":"r9","status":"pending","accessType":"read","serviceInstanceId":"s1","createdAt":"2026-01-01T00:00:00Z"}"#)
        })
        .await;
        let c = Client::new(&srv.url(), Some("tok_x".into())).unwrap();
        let input = CreateRequest {
            service_instance_id: "s1".into(),
            access_type: "read".into(),
            reason: "debug ticket".into(),
            target_databases: vec!["app".into()],
            create_database: false,
        };
        let r = c.create_request(&input).await.unwrap();
        assert_eq!(r.request_id, "r9");
        assert_eq!(r.status, "pending");
    }
}
