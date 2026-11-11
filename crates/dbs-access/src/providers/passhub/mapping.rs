//! From passhub's service / request vocabulary to the provider-neutral models.

use dbs_core::{Engine, EnvironmentKind, TlsMode};

use super::model::{AccessRequest as Wire, Credential, Service};
use crate::{AccessError, AccessLevel, AccessRequest, AccessResult, ConnectionPlan, LogEntry, Person, RequestStatus, Resource};

/// Database engine for a passhub driver. `engine` is the detected engine string
/// (RDS engine name or a version banner) and tells MariaDB apart from MySQL.
/// `None` for drivers this app can't connect to (DocumentDB, SSM, unknown).
pub fn engine_for(driver_key: &str, engine: &str) -> Option<Engine> {
    match driver_key {
        "rds-mysql" | "onprem-mysql" => Some(if engine.to_ascii_lowercase().contains("maria") { Engine::MariaDb } else { Engine::MySql }),
        "rds-postgres" | "onprem-postgres" => Some(Engine::Postgres),
        _ => None,
    }
}

/// Environment kind from an environment name (`prod`, `production-eu`, `staging`,
/// `dev`, …). Unknown names map to `Custom`.
pub fn environment_for(name: &str) -> EnvironmentKind {
    let n = name.trim().to_ascii_lowercase();
    let has = |w: &str| n.split(|c: char| !c.is_ascii_alphanumeric()).any(|t| t == w);
    if n.contains("preprod") || n.contains("pre-prod") || n.contains("stag") || has("uat") {
        EnvironmentKind::Staging
    } else if n.contains("prod") || has("prd") || has("live") {
        EnvironmentKind::Production
    } else if n.contains("test") || has("qa") {
        EnvironmentKind::Testing
    } else if n.contains("dev") {
        EnvironmentKind::Development
    } else if n.contains("local") {
        EnvironmentKind::Local
    } else {
        EnvironmentKind::Custom
    }
}

/// RDS always offers TLS but its CA is usually not in the OS trust store, so the
/// connection is encrypted without chain verification (REQUIRED). On-prem servers
/// may not have TLS at all: PREFERRED, except for production, which the app
/// refuses to reach over a link that may fall back to plaintext.
pub fn tls_for(driver_key: &str, env: EnvironmentKind) -> TlsMode {
    if driver_key.starts_with("rds-") || env == EnvironmentKind::Production {
        TlsMode::Required
    } else {
        TlsMode::Preferred
    }
}

pub fn access_level(t: &str) -> Option<AccessLevel> {
    match t {
        "read" => Some(AccessLevel::ReadOnly),
        "read_write" => Some(AccessLevel::ReadWrite),
        _ => None,
    }
}

pub fn access_type(l: AccessLevel) -> &'static str {
    match l {
        AccessLevel::ReadOnly => "read",
        AccessLevel::ReadWrite => "read_write",
    }
}

/// Active database services this app can connect to.
pub fn resource(s: &Service) -> Option<Resource> {
    if !s.is_active {
        return None;
    }
    let engine = engine_for(&s.driver_key, &s.config_str("engine").unwrap_or_default())?;
    Some(Resource {
        id: s.service_id.clone(),
        name: s.name.clone(),
        environment_name: s.environment_name.clone(),
        environment: environment_for(&s.environment_name),
        engine,
        host: s.config_str("endpoint").or_else(|| s.config_str("host")),
        port: s.config_port(),
        access_levels: vec![AccessLevel::ReadOnly, AccessLevel::ReadWrite],
    })
}

/// passhub's lifecycle status + provisioning status collapsed into one state.
pub fn status(r: &Wire, now: i64) -> RequestStatus {
    match r.status.as_str() {
        "pending" => RequestStatus::Pending,
        "rejected" => RequestStatus::Rejected,
        "expired" => RequestStatus::Expired,
        "revoked" => RequestStatus::Revoked,
        "approved" => match r.provisioning_status.as_str() {
            "failed" => RequestStatus::Failed,
            "provisioned" if r.expires_at > 0 && r.expires_at <= now => RequestStatus::Expired,
            "provisioned" => RequestStatus::Ready,
            _ => RequestStatus::Provisioning,
        },
        _ => RequestStatus::Pending,
    }
}

fn person(id: &str, name: &str, email: &str) -> Option<Person> {
    (!name.is_empty() || !email.is_empty()).then(|| Person { id: id.to_string(), name: name.to_string(), email: email.to_string() })
}

pub fn request(r: &Wire, now: i64) -> AccessRequest {
    let status = status(r, now);
    let approver =
        if status == RequestStatus::Pending { person("", &r.manager_name, &r.manager_email) } else { person("", &r.approver_name, &r.approver_email) };
    let databases = if r.target_databases.is_empty() {
        r.database.split(',').map(|d| d.trim().to_string()).filter(|d| !d.is_empty()).collect()
    } else {
        r.target_databases.clone()
    };
    let detail = match status {
        RequestStatus::Failed => Some(r.provisioning_error.clone()),
        RequestStatus::Rejected => Some(r.reject_reason.clone()),
        _ => None,
    }
    .filter(|d| !d.is_empty());
    AccessRequest {
        id: r.request_id.clone(),
        resource_id: r.service_instance_id.clone(),
        resource_name: r.service_name.clone(),
        environment_name: r.environment_name.clone(),
        environment: environment_for(&r.environment_name),
        engine: engine_for(&r.driver_key, &r.engine),
        access: access_level(&r.access_type),
        reason: r.reason.clone(),
        databases,
        create_database: r.create_database,
        status,
        status_detail: detail,
        requester: Person { id: r.user_id.clone(), name: r.requester_name.clone(), email: r.requester_email.clone() },
        approver,
        log: r.provisioning_log.iter().map(|l| LogEntry { ts: l.ts.clone(), level: l.level.clone(), msg: l.msg.clone() }).collect(),
        created_at: r.created_at.clone(),
        expires_at: (r.expires_at > 0).then_some(r.expires_at),
        lifetime_hours: (r.access_ttl_hours > 0).then_some(r.access_ttl_hours),
        decided_at: r.reviewed_at.clone().filter(|t| !t.is_empty()),
    }
}

/// The database the connection opens: the first database the request targets.
pub fn primary_database(r: &Wire) -> Option<String> {
    r.target_databases.first().cloned().or_else(|| r.database.split(',').next().map(|s| s.trim().to_string())).filter(|d| !d.is_empty())
}

/// Connection details for a provisioned request and its database credential.
pub fn plan(r: &Wire, cred: &Credential) -> AccessResult<ConnectionPlan> {
    let engine = engine_for(&r.driver_key, &r.engine)
        .ok_or_else(|| AccessError::Unsupported(format!("passhub service type \"{}\" can't be opened in this app", r.driver_key)))?;
    let host = r.endpoint.trim();
    if host.is_empty() {
        return Err(AccessError::Invalid("passhub did not provide an endpoint for this service".into()));
    }
    if cred.username.trim().is_empty() {
        return Err(AccessError::Invalid("passhub did not provide a database username for this request".into()));
    }
    let environment = environment_for(&r.environment_name);
    let database = primary_database(r);
    let service = if r.service_name.trim().is_empty() { "passhub" } else { r.service_name.trim() };
    let label = database.clone().unwrap_or_else(|| engine_label(engine).to_string());
    Ok(ConnectionPlan {
        request_id: r.request_id.clone(),
        credential_ref: Some(cred.credential_id.clone()),
        name: format!("{service} · {label}"),
        engine,
        host: host.to_string(),
        port: u16::try_from(r.port).ok().filter(|p| *p > 0),
        database,
        username: cred.username.trim().to_string(),
        environment,
        read_only: r.access_type == "read",
        tls: tls_for(&r.driver_key, environment),
        expires_at: Some(r.expires_at).filter(|t| *t > 0).or(Some(cred.expires_at).filter(|t| *t > 0)),
        reveals_remaining: cred.reveals_remaining(),
    })
}

fn engine_label(e: Engine) -> &'static str {
    match e {
        Engine::MySql => "MySQL",
        Engine::MariaDb => "MariaDB",
        _ => "PostgreSQL",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engines() {
        assert_eq!(engine_for("rds-mysql", "mysql"), Some(Engine::MySql));
        assert_eq!(engine_for("rds-mysql", "aurora-mysql"), Some(Engine::MySql));
        assert_eq!(engine_for("rds-mysql", "mariadb"), Some(Engine::MariaDb));
        assert_eq!(engine_for("onprem-mysql", "10.11.6-MariaDB"), Some(Engine::MariaDb));
        assert_eq!(engine_for("onprem-mysql", ""), Some(Engine::MySql));
        assert_eq!(engine_for("rds-postgres", "aurora-postgresql"), Some(Engine::Postgres));
        assert_eq!(engine_for("onprem-postgres", ""), Some(Engine::Postgres));
        for k in ["documentdb", "ssm", "", "rds-oracle"] {
            assert_eq!(engine_for(k, "docdb"), None, "{k}");
        }
    }

    #[test]
    fn environments() {
        use EnvironmentKind::*;
        for (n, k) in [
            ("prod", Production),
            ("Production", Production),
            ("production-eu", Production),
            ("eu-prd", Production),
            ("preprod", Staging),
            ("staging", Staging),
            ("stage", Staging),
            ("uat", Staging),
            ("dev", Development),
            ("development", Development),
            ("test", Testing),
            ("qa", Testing),
            ("local", Local),
            ("sandbox", Custom),
            ("", Custom),
        ] {
            assert_eq!(environment_for(n), k, "{n}");
        }
    }

    #[test]
    fn tls_defaults() {
        assert_eq!(tls_for("rds-postgres", EnvironmentKind::Development), TlsMode::Required);
        assert_eq!(tls_for("onprem-mysql", EnvironmentKind::Development), TlsMode::Preferred);
        assert_eq!(tls_for("onprem-mysql", EnvironmentKind::Production), TlsMode::Required);
    }

    fn wire() -> Wire {
        Wire {
            request_id: "r1".into(),
            status: "approved".into(),
            provisioning_status: "provisioned".into(),
            access_type: "read".into(),
            service_name: "orders".into(),
            environment_name: "prod".into(),
            driver_key: "rds-mysql".into(),
            engine: "mysql".into(),
            endpoint: "orders.cluster.example.com".into(),
            port: 3306,
            target_databases: vec!["shop".into(), "audit".into()],
            database: "shop, audit".into(),
            expires_at: 4_000_000_000,
            manager_name: "Morgan".into(),
            approver_name: "Avery".into(),
            ..Default::default()
        }
    }

    #[test]
    fn statuses() {
        let s = |st: &str, p: &str, exp: i64| status(&Wire { status: st.into(), provisioning_status: p.into(), expires_at: exp, ..Default::default() }, 1000);
        assert_eq!(s("pending", "", 0), RequestStatus::Pending);
        assert_eq!(s("approved", "", 0), RequestStatus::Provisioning);
        assert_eq!(s("approved", "queued", 0), RequestStatus::Provisioning);
        assert_eq!(s("approved", "failed", 0), RequestStatus::Failed);
        assert_eq!(s("approved", "provisioned", 2000), RequestStatus::Ready);
        assert_eq!(s("approved", "provisioned", 1000), RequestStatus::Expired);
        assert_eq!(s("rejected", "", 0), RequestStatus::Rejected);
        assert_eq!(s("revoked", "provisioned", 0), RequestStatus::Revoked);
        let r = request(&wire(), 1000);
        assert_eq!(r.approver.unwrap().name, "Avery");
        assert_eq!(r.access, Some(AccessLevel::ReadOnly));
        assert_eq!(r.environment, EnvironmentKind::Production);
        let p = request(&Wire { status: "pending".into(), ..wire() }, 1000);
        assert_eq!(p.approver.unwrap().name, "Morgan", "pending: who will decide");
    }

    #[test]
    fn plan_from_request() {
        let cred = Credential {
            credential_id: "c1".into(),
            username: "dev_r1".into(),
            credential_type: "db_password".into(),
            max_views: 5,
            view_count: 1,
            ..Default::default()
        };
        let p = plan(&wire(), &cred).unwrap();
        assert_eq!(p.name, "orders · shop");
        assert_eq!((p.engine, p.port, p.database.as_deref(), p.username.as_str()), (Engine::MySql, Some(3306), Some("shop"), "dev_r1"));
        assert_eq!((p.environment, p.tls, p.read_only), (EnvironmentKind::Production, TlsMode::Required, true));
        assert_eq!((p.credential_ref.as_deref(), p.expires_at, p.reveals_remaining), (Some("c1"), Some(4_000_000_000), Some(4)));

        let rw = Wire {
            access_type: "read_write".into(),
            target_databases: vec![],
            database: String::new(),
            driver_key: "onprem-postgres".into(),
            environment_name: "dev".into(),
            port: 0,
            ..wire()
        };
        let p = plan(&rw, &cred).unwrap();
        assert!(!p.read_only);
        assert_eq!((p.name.as_str(), p.port, p.tls), ("orders · PostgreSQL", None, TlsMode::Preferred));

        assert!(plan(&Wire { driver_key: "documentdb".into(), ..wire() }, &cred).is_err());
        assert!(plan(&Wire { endpoint: " ".into(), ..wire() }, &cred).is_err());
        assert!(plan(&wire(), &Credential { username: String::new(), ..cred }).is_err());
    }

    #[test]
    fn resources() {
        let mut s = Service {
            service_id: "s1".into(),
            name: "orders".into(),
            environment_name: "staging".into(),
            driver_key: "rds-mysql".into(),
            is_active: true,
            config: serde_json::json!({"endpoint":"db.example.com","port":"3307","engine":"mariadb"}),
            ..Default::default()
        };
        let r = resource(&s).unwrap();
        assert_eq!((r.engine, r.environment, r.port), (Engine::MariaDb, EnvironmentKind::Staging, Some(3307)));
        s.driver_key = "ssm".into();
        assert!(resource(&s).is_none());
        s.driver_key = "rds-postgres".into();
        s.is_active = false;
        assert!(resource(&s).is_none());
    }
}
