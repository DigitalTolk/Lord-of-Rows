//! SSH tunnelling for database connections.
//!
//! * Auth: password, private key (with optional passphrase), or SSH agent (Unix).
//! * Jump hosts: each hop is reached through a `direct-tcpip` channel of the
//!   previous one (`ssh -J a,b target`). Every hop uses the same user/auth.
//! * **Strict host-key checking** against an app-managed known_hosts file:
//!   - known & matching → continue,
//!   - unknown → fail with `HOST_KEY_UNKNOWN` and the SHA-256 fingerprint; the
//!     caller retries with `trust_fingerprint` after the user confirms it,
//!   - changed → fail with `HOST_KEY_CHANGED`. Never silently accepted.
//! * The tunnel listens on 127.0.0.1 (ephemeral port) and forwards each accepted
//!   TCP connection to `target_host:target_port` as seen from the last hop.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dbs_core::{DbError, DbResult, ErrorKind, SshAuth, SshConfig};
use russh::client::{self, Handle};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

pub const HOST_KEY_UNKNOWN: &str = "HOST_KEY_UNKNOWN";
pub const HOST_KEY_CHANGED: &str = "HOST_KEY_CHANGED";

/// Secrets for SSH auth. Debug output is redacted.
#[derive(Default)]
pub struct SshSecrets {
    pub password: Option<String>,
    pub key_passphrase: Option<String>,
}

impl std::fmt::Debug for SshSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SshSecrets(***)")
    }
}

#[derive(Debug, Clone)]
enum HostKeyOutcome {
    Unknown { fingerprint: String },
    Changed { fingerprint: String },
    Unsupported(String),
}

struct HostCheck {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    trust: Option<String>,
    outcome: Arc<Mutex<Option<HostKeyOutcome>>>,
}

pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

impl client::Handler for HostCheck {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_key: &russh::keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = match server_key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            russh::keys::PublicKeyOrCertificate::Certificate(_) => {
                *self.outcome.lock().unwrap() = Some(HostKeyOutcome::Unsupported("SSH host certificates are not supported yet".into()));
                return Ok(false);
            }
        };
        let fp = fingerprint(&key);
        let known = if self.known_hosts.exists() { russh::keys::check_known_hosts_path(&self.host, self.port, &key, &self.known_hosts) } else { Ok(false) };
        match known {
            Ok(true) => Ok(true),
            Err(russh::keys::Error::KeyChanged { .. }) => {
                *self.outcome.lock().unwrap() = Some(HostKeyOutcome::Changed { fingerprint: fp });
                Ok(false)
            }
            Ok(false) | Err(_) => {
                if self.trust.as_deref() == Some(fp.as_str()) {
                    russh::keys::known_hosts::learn_known_hosts_path(&self.host, self.port, &key, &self.known_hosts)
                        .map_err(|e| russh::Error::IO(std::io::Error::other(e.to_string())))?;
                    Ok(true)
                } else {
                    *self.outcome.lock().unwrap() = Some(HostKeyOutcome::Unknown { fingerprint: fp });
                    Ok(false)
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Hop {
    host: String,
    port: u16,
}

fn parse_hop(s: &str, default_port: u16) -> DbResult<Hop> {
    let s = s.trim();
    let s = s.rsplit_once('@').map(|(_, h)| h).unwrap_or(s);
    let (host, port) = match s.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() => (h, p.parse().map_err(|_| DbError::invalid("invalid jump host port"))?),
        _ => (s, default_port),
    };
    if host.is_empty() || host.chars().any(|c| c.is_whitespace() || c == '/') {
        return Err(DbError::invalid("invalid jump host"));
    }
    Ok(Hop { host: host.trim_matches(['[', ']']).to_string(), port })
}

fn ssh_err(msg: impl Into<String>) -> DbError {
    DbError::new(ErrorKind::Ssh, msg)
}

/// A live tunnel. Dropping it closes the listener and the SSH session(s).
pub struct Tunnel {
    pub local_port: u16,
    task: JoinHandle<()>,
    _handles: Vec<Arc<Handle<HostCheck>>>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl std::fmt::Debug for Tunnel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tunnel").field("local_port", &self.local_port).finish()
    }
}

async fn authenticate(h: &mut Handle<HostCheck>, cfg: &SshConfig, secrets: &SshSecrets) -> DbResult<()> {
    let user = cfg.user.clone();
    let ok = match cfg.auth {
        SshAuth::Password => {
            let pw = secrets.password.clone().ok_or_else(|| ssh_err("SSH password required"))?;
            h.authenticate_password(user, pw).await.map_err(|e| ssh_err(format!("SSH auth error: {e}")))?.success()
        }
        SshAuth::PrivateKey => {
            let path = cfg.private_key_path.clone().ok_or_else(|| ssh_err("SSH private key path required"))?;
            let key = russh::keys::load_secret_key(&path, secrets.key_passphrase.as_deref()).map_err(|e| {
                let msg = e.to_string();
                if msg.to_ascii_lowercase().contains("encrypt") || msg.to_ascii_lowercase().contains("passphrase") {
                    ssh_err("the SSH private key is encrypted: a correct passphrase is required")
                } else {
                    ssh_err(format!("cannot load SSH private key: {msg}"))
                }
            })?;
            let hash = h.best_supported_rsa_hash().await.map_err(|e| ssh_err(e.to_string()))?.flatten();
            h.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(|e| ssh_err(format!("SSH auth error: {e}")))?
                .success()
        }
        SshAuth::Agent => agent_auth(h, &user).await?,
    };
    if !ok {
        return Err(DbError::new(ErrorKind::Authentication, "SSH authentication failed"));
    }
    Ok(())
}

#[cfg(unix)]
async fn agent_auth(h: &mut Handle<HostCheck>, user: &str) -> DbResult<bool> {
    let mut agent = russh::keys::agent::client::AgentClient::connect_env().await.map_err(|e| ssh_err(format!("SSH agent unavailable: {e}")))?;
    let ids = agent.request_identities().await.map_err(|e| ssh_err(format!("SSH agent error: {e}")))?;
    for id in ids {
        let key = match id {
            russh::keys::agent::AgentIdentity::PublicKey { key, .. } => key,
            _ => continue,
        };
        let hash = h.best_supported_rsa_hash().await.map_err(|e| ssh_err(e.to_string()))?.flatten();
        if let Ok(r) = h.authenticate_publickey_with(user, key, hash, &mut agent).await {
            if r.success() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[cfg(not(unix))]
async fn agent_auth(_h: &mut Handle<HostCheck>, _user: &str) -> DbResult<bool> {
    Err(DbError::unsupported("SSH agent authentication on this platform (use a private key)"))
}

fn map_connect_err(e: russh::Error, outcome: &Arc<Mutex<Option<HostKeyOutcome>>>, hop: &Hop) -> DbError {
    match outcome.lock().unwrap().clone() {
        Some(HostKeyOutcome::Unknown { fingerprint }) => DbError::new(
            ErrorKind::Ssh,
            format!("The authenticity of SSH host {}:{} can't be established. Key fingerprint: {fingerprint}", hop.host, hop.port),
        )
        .with_code(HOST_KEY_UNKNOWN)
        .with_hint(fingerprint),
        Some(HostKeyOutcome::Changed { fingerprint }) => DbError::new(
            ErrorKind::Ssh,
            format!(
                "WARNING: the SSH host key for {}:{} has CHANGED (now {fingerprint}). This could be a man-in-the-middle attack. Connection refused; remove the old key from the app's known_hosts only if you know the change is legitimate.",
                hop.host, hop.port
            ),
        )
        .with_code(HOST_KEY_CHANGED),
        Some(HostKeyOutcome::Unsupported(m)) => ssh_err(m),
        None => ssh_err(format!("SSH connection to {}:{} failed: {e}", hop.host, hop.port)),
    }
}

/// Open a tunnel to `target_host:target_port` (as resolved from the last SSH hop).
/// `trust_fingerprint`: a SHA-256 fingerprint the user explicitly approved; it is
/// recorded in `known_hosts` if presented by a hop that is not yet known.
pub async fn open_tunnel(
    cfg: &SshConfig,
    secrets: SshSecrets,
    target_host: &str,
    target_port: u16,
    known_hosts: &Path,
    trust_fingerprint: Option<&str>,
    timeout: Duration,
) -> DbResult<Tunnel> {
    let mut hops = cfg.jump_hosts.iter().map(|j| parse_hop(j, 22)).collect::<DbResult<Vec<_>>>()?;
    hops.push(parse_hop(&format!("{}:{}", cfg.host, cfg.port), 22)?);
    let config = Arc::new(client::Config {
        keepalive_interval: (cfg.keepalive_secs > 0).then(|| Duration::from_secs(cfg.keepalive_secs as u64)),
        keepalive_max: 3,
        inactivity_timeout: None,
        ..Default::default()
    });

    let mut handles: Vec<Arc<Handle<HostCheck>>> = Vec::new();
    for hop in &hops {
        let outcome: Arc<Mutex<Option<HostKeyOutcome>>> = Arc::default();
        let handler = HostCheck {
            host: hop.host.clone(),
            port: hop.port,
            known_hosts: known_hosts.to_path_buf(),
            trust: trust_fingerprint.map(String::from),
            outcome: outcome.clone(),
        };
        let fut = async {
            match handles.last() {
                None => client::connect(config.clone(), (hop.host.as_str(), hop.port), handler).await,
                Some(prev) => {
                    let ch = prev.channel_open_direct_tcpip(hop.host.clone(), hop.port as u32, "127.0.0.1", 0).await?;
                    client::connect_stream(config.clone(), ch.into_stream(), handler).await
                }
            }
        };
        let mut h = tokio::time::timeout(timeout, fut)
            .await
            .map_err(|_| DbError::new(ErrorKind::Timeout, format!("SSH connection to {}:{} timed out", hop.host, hop.port)))?
            .map_err(|e| map_connect_err(e, &outcome, hop))?;
        authenticate(&mut h, cfg, &secrets).await?;
        handles.push(Arc::new(h));
    }
    drop(secrets);

    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| ssh_err(format!("cannot open local tunnel port: {e}")))?;
    let local_port = listener.local_addr().map_err(|e| ssh_err(e.to_string()))?.port();
    let last = handles.last().cloned().expect("at least one hop");
    let target = target_host.to_string();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut sock, peer)) = listener.accept().await else { break };
            let h = last.clone();
            let target = target.clone();
            tokio::spawn(async move {
                match h.channel_open_direct_tcpip(target, target_port as u32, peer.ip().to_string(), peer.port() as u32).await {
                    Ok(ch) => {
                        let mut stream = ch.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                    }
                    Err(e) => tracing::warn!("ssh direct-tcpip failed: {e}"),
                }
            });
        }
    });
    Ok(Tunnel { local_port, task, _handles: handles })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hop_parsing() {
        assert_eq!(parse_hop("bastion", 22).unwrap(), Hop { host: "bastion".into(), port: 22 });
        assert_eq!(parse_hop("me@bastion:2200", 22).unwrap(), Hop { host: "bastion".into(), port: 2200 });
        assert_eq!(parse_hop("[::1]:22", 22).unwrap(), Hop { host: "::1".into(), port: 22 });
        assert!(parse_hop("bad host", 22).is_err());
        assert!(parse_hop("h:notaport", 22).is_err());
    }

    #[test]
    fn secrets_debug_redacted() {
        assert_eq!(format!("{:?}", SshSecrets { password: Some("x".into()), key_passphrase: None }), "SshSecrets(***)");
    }
}
