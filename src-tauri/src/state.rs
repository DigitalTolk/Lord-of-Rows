use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use dbs_audit::AuditLog;
use dbs_core::{ConnectionConfig, DatabaseConnection, DbError, DbResult, ErrorKind};
use dbs_safety::{ConfirmationGuard, SafetyPolicy};
use dbs_secrets::SecretStore;
use dbs_store::AppStore;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub struct Session {
    pub id: Uuid,
    pub config: ConnectionConfig,
    pub conn: Arc<dyn DatabaseConnection>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum GrantMode {
    Read,
    Write,
}

/// A file the user picked in a native dialog. The webview only ever holds the
/// grant id, never a raw path it can choose itself.
#[derive(Clone)]
pub struct FileGrant {
    pub path: PathBuf,
    pub mode: GrantMode,
}

pub struct AppState {
    pub store: AppStore,
    pub audit: AuditLog,
    pub secrets: Box<dyn SecretStore>,
    pub session_secrets: dbs_secrets::MemoryStore,
    pub guard: ConfirmationGuard,
    pub sessions: Mutex<HashMap<Uuid, Arc<Session>>>,
    pub running: Mutex<HashMap<String, CancellationToken>>,
    pub grants: Mutex<HashMap<String, FileGrant>>,
}

impl AppState {
    pub fn session(&self, id: &str) -> DbResult<Arc<Session>> {
        let id = Uuid::parse_str(id).map_err(|_| DbError::invalid("invalid session id"))?;
        self.sessions.lock().unwrap().get(&id).cloned().ok_or_else(|| DbError::new(ErrorKind::NotFound, "session is not open"))
    }

    pub fn policy_for(&self, cfg: &ConnectionConfig) -> SafetyPolicy {
        if cfg.read_only {
            return SafetyPolicy::read_only();
        }
        let key = format!("safety.policy.{}", serde_json::to_value(cfg.environment).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default());
        self.store
            .get_setting(&key)
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_value::<SafetyPolicy>(v).ok())
            // A stored policy may only be *stricter* for production: never drop below the default.
            .filter(|p| !cfg.is_production() || p.confirm_at.is_some_and(|c| c <= dbs_safety::Risk::Write))
            .unwrap_or_else(|| SafetyPolicy::for_environment(cfg.environment))
    }

    pub fn grant(&self, id: &str, mode: GrantMode) -> DbResult<FileGrant> {
        let g = self.grants.lock().unwrap().get(id).cloned().ok_or_else(|| DbError::new(ErrorKind::Permission, "file access was not granted"))?;
        if g.mode != mode {
            return Err(DbError::new(ErrorKind::Permission, "file grant does not allow this operation"));
        }
        Ok(g)
    }

    pub fn store_query_text(&self, cfg: &ConnectionConfig) -> bool {
        match self.store.get_setting("privacy.historyText").ok().flatten().and_then(|v| v.as_str().map(String::from)).as_deref() {
            Some("always") => true,
            Some("never") => false,
            _ => !cfg.is_production(), // default: "non_production"
        }
    }

    pub fn max_rows(&self) -> usize {
        self.store.get_setting("query.maxRows").ok().flatten().and_then(|v| v.as_u64()).map(|n| n.clamp(1, 1_000_000) as usize).unwrap_or(10_000)
    }
}

pub fn random_key() -> [u8; 32] {
    let mut k = [0u8; 32];
    getrandom::getrandom(&mut k).expect("OS RNG unavailable");
    k
}
