//! Credential storage. Production builds use the OS store (macOS Keychain,
//! Windows Credential Manager, Linux Secret Service) via `keyring`. Secrets
//! never touch the app's SQLite store or config files.
//!
//! Secrets are returned in a `Secret` wrapper that zeroises on drop and has a
//! redacting `Debug`.

use std::collections::HashMap;
use std::sync::Mutex;

use dbs_core::{DbError, DbResult, ErrorKind};
use uuid::Uuid;
use zeroize::Zeroize;

pub const SERVICE: &str = "dev.dbstudio.credentials";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SecretKind {
    DbPassword,
    SshPassword,
    SshKeyPassphrase,
    TlsClientKey,
    AuthToken,
    AiApiKey,
}

impl SecretKind {
    fn tag(self) -> &'static str {
        match self {
            SecretKind::DbPassword => "db-password",
            SecretKind::SshPassword => "ssh-password",
            SecretKind::SshKeyPassphrase => "ssh-key-passphrase",
            SecretKind::TlsClientKey => "tls-client-key",
            SecretKind::AuthToken => "auth-token",
            SecretKind::AiApiKey => "ai-api-key",
        }
    }
}

pub struct Secret(String);

impl Secret {
    pub fn new(s: String) -> Self {
        Secret(s)
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
    /// Move the value out (caller becomes responsible for its lifetime).
    pub fn into_inner(mut self) -> String {
        std::mem::take(&mut self.0)
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(***)")
    }
}

pub trait SecretStore: Send + Sync {
    fn set(&self, owner: Uuid, kind: SecretKind, value: &str) -> DbResult<()>;
    fn get(&self, owner: Uuid, kind: SecretKind) -> DbResult<Option<Secret>>;
    fn delete(&self, owner: Uuid, kind: SecretKind) -> DbResult<()>;
    fn delete_all(&self, owner: Uuid) -> DbResult<()> {
        for k in [SecretKind::DbPassword, SecretKind::SshPassword, SecretKind::SshKeyPassphrase, SecretKind::TlsClientKey, SecretKind::AuthToken] {
            self.delete(owner, k)?;
        }
        Ok(())
    }
    fn backend_name(&self) -> &'static str;
}

fn account(owner: Uuid, kind: SecretKind) -> String {
    format!("{owner}:{}", kind.tag())
}

#[cfg(feature = "os-keychain")]
pub struct OsKeychain;

#[cfg(feature = "os-keychain")]
impl OsKeychain {
    fn entry(owner: Uuid, kind: SecretKind) -> DbResult<keyring::Entry> {
        keyring::Entry::new(SERVICE, &account(owner, kind)).map_err(|e| DbError::new(ErrorKind::Internal, format!("credential store unavailable: {e}")))
    }
}

#[cfg(feature = "os-keychain")]
impl SecretStore for OsKeychain {
    fn set(&self, owner: Uuid, kind: SecretKind, value: &str) -> DbResult<()> {
        Self::entry(owner, kind)?.set_password(value).map_err(|e| DbError::new(ErrorKind::Internal, format!("could not store credential: {e}")))
    }
    fn get(&self, owner: Uuid, kind: SecretKind) -> DbResult<Option<Secret>> {
        match Self::entry(owner, kind)?.get_password() {
            Ok(p) => Ok(Some(Secret(p))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(DbError::new(ErrorKind::Internal, format!("could not read credential: {e}"))),
        }
    }
    fn delete(&self, owner: Uuid, kind: SecretKind) -> DbResult<()> {
        match Self::entry(owner, kind)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(DbError::new(ErrorKind::Internal, format!("could not delete credential: {e}"))),
        }
    }
    fn backend_name(&self) -> &'static str {
        if cfg!(target_os = "macos") {
            "macOS Keychain"
        } else if cfg!(target_os = "windows") {
            "Windows Credential Manager"
        } else {
            "Secret Service"
        }
    }
}

/// Process-memory store. Used by tests and as an explicit "don't save
/// password" session store. Never persists anything.
#[derive(Default)]
pub struct MemoryStore {
    inner: Mutex<HashMap<String, String>>,
}

impl SecretStore for MemoryStore {
    fn set(&self, owner: Uuid, kind: SecretKind, value: &str) -> DbResult<()> {
        self.inner.lock().unwrap().insert(account(owner, kind), value.to_string());
        Ok(())
    }
    fn get(&self, owner: Uuid, kind: SecretKind) -> DbResult<Option<Secret>> {
        Ok(self.inner.lock().unwrap().get(&account(owner, kind)).cloned().map(Secret))
    }
    fn delete(&self, owner: Uuid, kind: SecretKind) -> DbResult<()> {
        if let Some(mut v) = self.inner.lock().unwrap().remove(&account(owner, kind)) {
            v.zeroize();
        }
        Ok(())
    }
    fn backend_name(&self) -> &'static str {
        "memory (not persisted)"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_roundtrip() {
        let s = MemoryStore::default();
        let id = Uuid::new_v4();
        assert!(s.get(id, SecretKind::DbPassword).unwrap().is_none());
        s.set(id, SecretKind::DbPassword, "pw").unwrap();
        assert_eq!(s.get(id, SecretKind::DbPassword).unwrap().unwrap().expose(), "pw");
        s.delete_all(id).unwrap();
        assert!(s.get(id, SecretKind::DbPassword).unwrap().is_none());
    }

    #[test]
    fn secret_debug_redacted() {
        assert_eq!(format!("{:?}", Secret("x".into())), "Secret(***)");
    }
}
