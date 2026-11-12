//! Access API wire shapes (see `docs/access-api.md`). Read from the server's camelCase
//! JSON and handed to the webview in the app's snake_case convention
//! (`rename_all(deserialize = …)`). Unknown fields are ignored and missing ones
//! default, so servers can grow.

use dbs_secrets::Secret;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"), default)]
pub struct User {
    pub user_id: String,
    pub email: String,
    pub name: String,
    /// `developer` | `manager` | `admin`.
    pub role: String,
    /// The user's manager (who approves their requests); `None` = no manager assigned yet.
    pub manager_id: Option<String>,
}

impl User {
    /// Managers and admins can approve requests.
    pub fn is_approver(&self) -> bool {
        matches!(self.role.as_str(), "manager" | "admin")
    }
}

#[derive(Deserialize)]
pub(crate) struct MeResponse {
    pub user: User,
}

/// `POST /auth/desktop/token` response.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenResponse {
    pub token: String,
    #[serde(default)]
    pub token_id: String,
    /// Unix seconds.
    #[serde(default)]
    pub expires_at: i64,
    pub user: User,
}

impl std::fmt::Debug for TokenResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenResponse")
            .field("token", &"***")
            .field("token_id", &self.token_id)
            .field("expires_at", &self.expires_at)
            .field("user", &self.user)
            .finish()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LogEntry {
    pub ts: String,
    pub level: String,
    pub msg: String,
}

/// An access request as the server shows it (enriched with service + people).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"), default)]
pub struct AccessRequest {
    pub request_id: String,
    pub user_id: String,
    pub service_instance_id: String,
    /// `pending` | `approved` | `rejected` | `expired` | `revoked`.
    pub status: String,
    pub request_type: String,
    /// `read` | `read_write` (databases).
    pub access_type: String,
    pub reason: String,
    pub target_databases: Vec<String>,
    pub create_database: bool,
    pub reviewed_at: Option<String>,
    pub reject_reason: String,
    /// `""` | `queued` | `provisioned` | `failed`.
    pub provisioning_status: String,
    pub provisioning_error: String,
    pub provisioning_log: Vec<LogEntry>,
    /// Approved lifetime in hours (from the matching approval rule).
    pub access_ttl_hours: i64,
    /// Unix seconds; 0 = not set (pending) or never.
    pub expires_at: i64,
    pub created_at: String,
    pub service_name: String,
    pub environment_name: String,
    pub provider: String,
    pub driver_key: String,
    pub requester_name: String,
    pub requester_email: String,
    pub approver_name: String,
    pub approver_email: String,
    pub manager_name: String,
    pub manager_email: String,
    pub endpoint: String,
    pub port: i64,
    /// The targeted databases joined with ", " (or the service default).
    pub database: String,
    pub engine: String,
}

impl AccessRequest {
    /// Approved, provisioned and not past its expiry.
    pub fn is_ready(&self, now: i64) -> bool {
        self.status == "approved" && self.provisioning_status == "provisioned" && (self.expires_at == 0 || self.expires_at > now)
    }

    /// The access is over for good: connections made from it must stop working.
    pub fn is_ended(&self, now: i64) -> bool {
        matches!(self.status.as_str(), "expired" | "revoked" | "rejected") || (self.status == "approved" && self.expires_at > 0 && self.expires_at <= now)
    }
}

/// A service instance from the catalog. `config` is driver-specific (endpoint, port, engine, …).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Service {
    pub service_id: String,
    pub name: String,
    pub environment_id: String,
    pub environment_name: String,
    pub driver_key: String,
    pub region: String,
    pub is_active: bool,
    pub config: serde_json::Value,
}

impl Service {
    pub fn config_str(&self, key: &str) -> Option<String> {
        self.config.get(key).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
    }
    pub fn config_port(&self) -> Option<u16> {
        match self.config.get("port")? {
            serde_json::Value::Number(n) => n.as_u64().and_then(|p| u16::try_from(p).ok()),
            serde_json::Value::String(s) => s.trim().parse().ok(),
            _ => None,
        }
        .filter(|p| *p > 0)
    }
}

/// `GET /approvals/decided` response.
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct DecidedPage {
    pub items: Vec<AccessRequest>,
    pub next: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct ServiceList {
    pub items: Vec<Service>,
}

/// `GET /services/:id/targets`: the databases a request can target.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Targets {
    pub ok: bool,
    pub targets: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"), default)]
pub struct Credential {
    pub credential_id: String,
    pub access_request_id: String,
    pub username: String,
    /// `db_password` | `ssm_direct`.
    pub credential_type: String,
    /// `active` | `revoked`.
    pub status: String,
    pub view_count: i64,
    /// 0 = unlimited.
    pub max_views: i64,
    pub expires_at: i64,
}

impl Credential {
    /// Reveals left; `None` = unlimited.
    pub fn reveals_remaining(&self) -> Option<i64> {
        (self.max_views > 0).then(|| (self.max_views - self.view_count).max(0))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevealResponse {
    pub password: String,
    #[serde(default)]
    pub reveals_remaining: i64,
}

/// A revealed password (zeroised on drop, redacted in `Debug`).
#[derive(Debug)]
pub struct Revealed {
    pub password: Secret,
    /// `None` = unlimited.
    pub reveals_remaining: Option<i64>,
}

/// New developer request (sent camelCase via [`CreateRequest::wire`]).
#[derive(Debug, Clone, PartialEq)]
pub struct CreateRequest {
    pub service_instance_id: String,
    pub access_type: String,
    pub reason: String,
    pub target_databases: Vec<String>,
    /// Ask the server to create the (single) target database at provisioning time.
    pub create_database: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateRequestWire<'a> {
    service_instance_id: &'a str,
    access_type: &'a str,
    reason: &'a str,
    request_type: &'static str,
    target_databases: &'a [String],
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    create_database: bool,
}

impl CreateRequest {
    pub(crate) fn wire(&self) -> serde_json::Value {
        serde_json::to_value(CreateRequestWire {
            service_instance_id: &self.service_instance_id,
            access_type: &self.access_type,
            reason: self.reason.trim(),
            request_type: "developer",
            target_databases: &self.target_databases,
            create_database: self.create_database,
        })
        .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_reads_camel_case_and_writes_snake_case() {
        let r: AccessRequest = serde_json::from_str(
            r#"{"requestId":"r1","status":"approved","provisioningStatus":"provisioned","expiresAt":2000,"serviceName":"orders","driverKey":"rds-mysql","port":3306,"targetDatabases":["app"],"provisioningLog":[{"ts":"t","level":"info","msg":"created user"}],"unknownField":1}"#,
        )
        .unwrap();
        assert_eq!(r.request_id, "r1");
        assert_eq!(r.target_databases, vec!["app"]);
        assert!(r.is_ready(1000));
        assert!(!r.is_ready(2000));
        assert!(r.is_ended(2000));
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["request_id"], "r1");
        assert_eq!(v["provisioning_log"][0]["msg"], "created user");
        assert!(!AccessRequest { status: "pending".into(), ..r.clone() }.is_ended(5000));
        assert!(AccessRequest { status: "revoked".into(), ..r }.is_ended(0));
    }

    #[test]
    fn reveal_budget() {
        let c = Credential { max_views: 5, view_count: 5, ..Default::default() };
        assert_eq!(c.reveals_remaining(), Some(0));
        assert_eq!(Credential { max_views: 0, ..Default::default() }.reveals_remaining(), None);
    }

    #[test]
    fn create_request_wire() {
        let c = CreateRequest {
            service_instance_id: "s1".into(),
            access_type: "read_write".into(),
            reason: "x".into(),
            target_databases: vec!["a".into(), "b".into()],
            create_database: false,
        };
        let w = c.wire();
        assert_eq!(w["serviceInstanceId"], "s1");
        assert_eq!(w["requestType"], "developer");
        assert_eq!(w["targetDatabases"][1], "b");
    }
}
