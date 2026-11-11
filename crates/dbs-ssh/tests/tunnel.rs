//! Real SSH server (docker-compose `sshd`) + real Postgres behind it.
use std::time::Duration;

use dbs_core::*;
use dbs_ssh::{open_tunnel, SshSecrets, HOST_KEY_CHANGED, HOST_KEY_UNKNOWN};
use tokio_util::sync::CancellationToken;

fn enabled() -> Option<String> {
    let h = std::env::var("DBS_IT_SSH_HOST").ok();
    if h.is_none() {
        eprintln!("SKIPPED: DBS_IT_SSH_HOST not set");
    }
    h
}

fn ssh(host: &str, auth: SshAuth) -> SshConfig {
    SshConfig { host: host.into(), port: 22, user: "tunnel".into(), auth, private_key_path: None, jump_hosts: vec![], keepalive_secs: 15 }
}

fn pw(p: &str) -> SshSecrets {
    SshSecrets { password: Some(p.into()), key_passphrase: None }
}

const T: Duration = Duration::from_secs(15);

async fn trust(cfg: &SshConfig, kh: &std::path::Path) -> String {
    let e = open_tunnel(cfg, pw("tunnelpw"), "postgres", 5432, kh, None, T).await.unwrap_err();
    assert_eq!(e.code.as_deref(), Some(HOST_KEY_UNKNOWN), "{e:?}");
    let fp = e.hint.clone().expect("fingerprint");
    assert!(fp.starts_with("SHA256:"), "{fp}");
    fp
}

async fn pg_through(port: u16) -> Vec<StatementResult> {
    let cfg = ConnectionConfig {
        id: uuid::Uuid::new_v4(),
        name: "via ssh".into(),
        engine: Engine::Postgres,
        host: Some("127.0.0.1".into()),
        port: Some(port),
        database: Some("dbs_test".into()),
        username: Some("dbs_test".into()),
        socket_path: None,
        tls: TlsConfig { mode: TlsMode::Disable, ..Default::default() },
        ssh: None,
        environment: EnvironmentKind::Local,
        read_only: false,
        color: None,
        group: None,
        tags: vec![],
        notes: None,
        favorite: false,
        connect_timeout_secs: 10,
        query_timeout_secs: None,
        init_sql: None,
        tunnel: None,
    };
    let c = dbs_drivers::driver_for(Engine::Postgres).unwrap().connect(&cfg, ConnectSecrets { password: Some("dbs_test".into()) }).await.unwrap();
    c.execute("SELECT count(*) FROM shop.customers", &ExecOptions::default(), CancellationToken::new()).await.unwrap()
}

#[tokio::test]
async fn host_key_trust_flow_and_password_tunnel() {
    let Some(host) = enabled() else { return };
    let dir = tempfile::tempdir().unwrap();
    let kh = dir.path().join("known_hosts");
    let cfg = ssh(&host, SshAuth::Password);

    // 1. Unknown host: refused with fingerprint, nothing recorded.
    let fp = trust(&cfg, &kh).await;
    assert!(!kh.exists() || std::fs::read_to_string(&kh).unwrap().is_empty());

    // 2. Approving a *different* fingerprint must not trust the host.
    let e = open_tunnel(&cfg, pw("tunnelpw"), "postgres", 5432, &kh, Some("SHA256:not-the-key"), T).await.unwrap_err();
    assert_eq!(e.code.as_deref(), Some(HOST_KEY_UNKNOWN));

    // 3. Approving the presented fingerprint records it; tunnel works end-to-end.
    let t = open_tunnel(&cfg, pw("tunnelpw"), "postgres", 5432, &kh, Some(&fp), T).await.expect("tunnel");
    assert!(std::fs::read_to_string(&kh).unwrap().contains(&host));
    let r = pg_through(t.local_port).await;
    assert!(format!("{:?}", r[0].result).contains("500") || format!("{:?}", r[0].result).contains("Int"), "{r:?}");
    drop(t);

    // 4. Now known: no approval needed.
    let t2 = open_tunnel(&cfg, pw("tunnelpw"), "postgres", 5432, &kh, None, T).await.expect("known host");
    pg_through(t2.local_port).await;
}

#[tokio::test]
async fn changed_host_key_is_refused() {
    let Some(host) = enabled() else { return };
    let dir = tempfile::tempdir().unwrap();
    let kh = dir.path().join("known_hosts");
    // Record a *different* ed25519 key for this host (simulates a MITM / rebuilt server).
    let other = std::fs::read_to_string("/ssh-keys/id_plain.pub").unwrap();
    let mut parts = other.split_whitespace();
    std::fs::write(&kh, format!("{host} {} {}\n", parts.next().unwrap(), parts.next().unwrap())).unwrap();
    let e = open_tunnel(&ssh(&host, SshAuth::Password), pw("tunnelpw"), "postgres", 5432, &kh, None, T).await.unwrap_err();
    assert_eq!(e.code.as_deref(), Some(HOST_KEY_CHANGED), "{e:?}");
    assert!(e.message.contains("CHANGED"));
    // Even an explicit approval cannot override a changed key.
    let e2 = open_tunnel(&ssh(&host, SshAuth::Password), pw("tunnelpw"), "postgres", 5432, &kh, Some("SHA256:anything"), T).await.unwrap_err();
    assert_eq!(e2.code.as_deref(), Some(HOST_KEY_CHANGED));
}

#[tokio::test]
async fn auth_methods() {
    let Some(host) = enabled() else { return };
    let dir = tempfile::tempdir().unwrap();
    let kh = dir.path().join("known_hosts");
    let fp = trust(&ssh(&host, SshAuth::Password), &kh).await;

    // Wrong password → Authentication error, password not echoed.
    let e = open_tunnel(&ssh(&host, SshAuth::Password), pw("wrong-pw-123"), "postgres", 5432, &kh, Some(&fp), T).await.unwrap_err();
    assert_eq!(e.kind, ErrorKind::Authentication, "{e:?}");
    assert!(!e.message.contains("wrong-pw-123"));

    // Unencrypted private key.
    let mut k = ssh(&host, SshAuth::PrivateKey);
    k.private_key_path = Some("/ssh-keys/id_plain".into());
    let t = open_tunnel(&k, SshSecrets::default(), "postgres", 5432, &kh, None, T).await.expect("key auth");
    pg_through(t.local_port).await;

    // Passphrase-protected key: missing / wrong passphrase fail clearly, right one works.
    k.private_key_path = Some("/ssh-keys/id_secret".into());
    let e = open_tunnel(&k, SshSecrets::default(), "postgres", 5432, &kh, None, T).await.unwrap_err();
    assert!(e.message.to_lowercase().contains("passphrase") || e.message.to_lowercase().contains("key"), "{e:?}");
    let e = open_tunnel(&k, SshSecrets { password: None, key_passphrase: Some("nope".into()) }, "postgres", 5432, &kh, None, T).await.unwrap_err();
    assert_eq!(e.kind, ErrorKind::Ssh, "{e:?}");
    let t = open_tunnel(&k, SshSecrets { password: None, key_passphrase: Some("keypass".into()) }, "postgres", 5432, &kh, None, T)
        .await
        .expect("encrypted key auth");
    pg_through(t.local_port).await;
}

#[tokio::test]
async fn jump_host_chain() {
    let Some(host) = enabled() else { return };
    let dir = tempfile::tempdir().unwrap();
    let kh = dir.path().join("known_hosts");
    let mut cfg = ssh(&host, SshAuth::Password);
    let fp = trust(&cfg, &kh).await;
    // bastion (sshd) → sshd again → postgres
    cfg.jump_hosts = vec![format!("tunnel@{host}:22")];
    let t = open_tunnel(&cfg, pw("tunnelpw"), "postgres", 5432, &kh, Some(&fp), T).await.expect("two-hop tunnel");
    pg_through(t.local_port).await;
}

#[tokio::test]
async fn unreachable_host_times_out_cleanly() {
    if enabled().is_none() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = ssh("10.255.255.1", SshAuth::Password);
    cfg.port = 22;
    let e = open_tunnel(&cfg, pw("x"), "postgres", 5432, &dir.path().join("kh"), None, Duration::from_secs(2)).await.unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Timeout | ErrorKind::Ssh), "{e:?}");
}

/// Postgres via tunnel while keeping the real hostname for TLS verification.
#[tokio::test]
async fn pg_tls_verified_through_tunnel() {
    let Some(host) = enabled() else { return };
    let dir = tempfile::tempdir().unwrap();
    let kh = dir.path().join("known_hosts");
    let cfg = ssh(&host, SshAuth::Password);
    let fp = trust(&cfg, &kh).await;
    let t = open_tunnel(&cfg, pw("tunnelpw"), "postgres", 5432, &kh, Some(&fp), T).await.unwrap();
    let mut c = ConnectionConfig {
        id: uuid::Uuid::new_v4(),
        name: "tls via ssh".into(),
        engine: Engine::Postgres,
        host: Some("postgres".into()),
        port: Some(5432),
        database: Some("dbs_test".into()),
        username: Some("dbs_test".into()),
        socket_path: None,
        tls: TlsConfig { mode: TlsMode::VerifyFull, ca_cert_path: Some("/certs/ca.crt".into()), ..Default::default() },
        ssh: None,
        environment: EnvironmentKind::Production,
        read_only: false,
        color: None,
        group: None,
        tags: vec![],
        notes: None,
        favorite: false,
        connect_timeout_secs: 10,
        query_timeout_secs: None,
        init_sql: None,
        tunnel: Some(("127.0.0.1".into(), t.local_port)),
    };
    let conn =
        dbs_drivers::driver_for(Engine::Postgres).unwrap().connect(&c, ConnectSecrets { password: Some("dbs_test".into()) }).await.expect("tls via tunnel");
    let r = conn.execute("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()", &ExecOptions::default(), CancellationToken::new()).await.unwrap();
    assert_eq!(r[0].result.as_ref().unwrap().rows[0][0], Value::Bool(true));
    // Plain (no TLS) via tunnel also works.
    c.tls = TlsConfig { mode: TlsMode::Disable, ..Default::default() };
    c.environment = EnvironmentKind::Local;
    dbs_drivers::driver_for(Engine::Postgres).unwrap().connect(&c, ConnectSecrets { password: Some("dbs_test".into()) }).await.expect("plain via tunnel");
}
