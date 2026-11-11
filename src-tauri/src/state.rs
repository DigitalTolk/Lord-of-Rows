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
    /// Keeps the SSH tunnel open for the lifetime of the session.
    pub _tunnel: Option<dbs_ssh::Tunnel>,
    /// Label of the window that opened the session. Sessions are owned by one
    /// window; closing that window disconnects them (see `take_window_sessions`).
    pub owner: String,
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
    /// Binds AI prompt previews to what is sent (see `ai.rs`).
    pub ai_guard: dbs_ai::PromptGuard,
    pub sessions: Mutex<HashMap<Uuid, Arc<Session>>>,
    pub running: Mutex<HashMap<String, CancellationToken>>,
    /// Flow-control state of streaming runs, keyed like `running`.
    pub stream_acks: Mutex<HashMap<String, Arc<crate::commands::StreamAcks>>>,
    pub grants: Mutex<HashMap<String, FileGrant>>,
    /// App-managed SSH known_hosts (separate from ~/.ssh/known_hosts).
    pub known_hosts: PathBuf,
    pub plugins: crate::plugins::PluginHost,
}

impl AppState {
    pub fn session(&self, id: &str) -> DbResult<Arc<Session>> {
        let id = Uuid::parse_str(id).map_err(|_| DbError::invalid("invalid session id"))?;
        self.sessions.lock().unwrap().get(&id).cloned().ok_or_else(|| DbError::new(ErrorKind::NotFound, "session is not open"))
    }

    /// Removes and returns every session owned by window `label`, so the caller
    /// can close the connections. Other windows' sessions are untouched.
    pub fn take_window_sessions(&self, label: &str) -> Vec<Arc<Session>> {
        take_owned(&mut self.sessions.lock().unwrap(), label)
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

fn take_owned(map: &mut HashMap<Uuid, Arc<Session>>, label: &str) -> Vec<Arc<Session>> {
    let mut taken = Vec::new();
    map.retain(|_, s| {
        if s.owner == label {
            taken.push(s.clone());
            false
        } else {
            true
        }
    });
    taken
}

pub fn random_key() -> [u8; 32] {
    let mut k = [0u8; 32];
    getrandom::getrandom(&mut k).expect("OS RNG unavailable");
    k
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbs_core::{ConnectSecrets, Engine, EnvironmentKind, TlsConfig};

    async fn sqlite_session(dir: &std::path::Path, owner: &str) -> Arc<Session> {
        let path = dir.join(format!("{owner}-{}.db", Uuid::new_v4()));
        // An empty file is a valid (empty) SQLite database; the driver refuses to create new files.
        std::fs::write(&path, b"").unwrap();
        let config = ConnectionConfig {
            id: Uuid::new_v4(),
            name: owner.into(),
            engine: Engine::Sqlite,
            host: None,
            port: None,
            database: Some(path.to_string_lossy().into_owned()),
            username: None,
            socket_path: None,
            tls: TlsConfig::default(),
            ssh: None,
            environment: EnvironmentKind::Local,
            read_only: false,
            color: None,
            group: None,
            tags: vec![],
            notes: None,
            favorite: false,
            connect_timeout_secs: 5,
            query_timeout_secs: None,
            init_sql: None,
            key_separator: None,
            tunnel: None,
        };
        let conn = dbs_drivers::driver_for(Engine::Sqlite).unwrap().connect(&config, ConnectSecrets::default()).await.expect("sqlite connect");
        Arc::new(Session { id: Uuid::new_v4(), config, conn: Arc::from(conn), _tunnel: None, owner: owner.into() })
    }

    #[tokio::test]
    async fn closing_a_window_takes_only_its_own_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let mut map = HashMap::new();
        for owner in ["main", "window-1", "window-1", "window-2"] {
            let s = sqlite_session(dir.path(), owner).await;
            map.insert(s.id, s);
        }
        let taken = take_owned(&mut map, "window-1");
        assert_eq!(taken.len(), 2);
        assert!(taken.iter().all(|s| s.owner == "window-1"));
        assert_eq!(map.len(), 2);
        assert!(map.values().all(|s| s.owner != "window-1"));
        // The taken connections are real and can be closed; the others stay usable.
        for s in taken {
            s.conn.close().await.unwrap();
        }
        for s in map.values() {
            s.conn.ping().await.unwrap();
        }
        assert!(take_owned(&mut map, "window-1").is_empty());
        assert_eq!(take_owned(&mut map, "main").len(), 1);
    }
}
