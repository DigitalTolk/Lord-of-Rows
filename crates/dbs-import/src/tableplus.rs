//! TablePlus (macOS): `Data/Connections.plist` (array of dictionaries) and
//! `Data/ConnectionGroups.plist` (ID, Name, parent GroupID).
//!
//! Key names are read tolerantly: several spellings are accepted (the
//! environment key is spelled `Enviroment` in current files). Passwords are not
//! in the plist; TablePlus keeps them as generic-password keychain items with
//! service [`KEYCHAIN_SERVICE`] and account `<connection ID>_database` (database
//! password) / `<connection ID>_server` (SSH password).

use std::collections::HashMap;

use dbs_core::{EnvironmentKind, SshAuth, SshConfig, TlsMode};
use dbs_secrets::SecretKind;
use plist::{Dictionary, Value};

use crate::{
    blank, default_environment, engine_from_name, environment_from_name, fallback_name, group_path, hex_color, invalid, non_empty, port_from, Ctx,
    ImportedConnection, KeychainItem, Parsed,
};

pub const KEYCHAIN_SERVICE: &str = "com.tableplus.TablePlus";

/// Keychain account holding a connection's database password.
pub fn db_password_account(connection_id: &str) -> String {
    format!("{connection_id}_database")
}

/// Keychain account holding a connection's SSH password (naming assumed, see module docs).
pub fn ssh_password_account(connection_id: &str) -> String {
    format!("{connection_id}_server")
}

fn get<'a>(d: &'a Dictionary, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| d.get(k))
}

fn s(d: &Dictionary, keys: &[&str]) -> Option<String> {
    match get(d, keys)? {
        Value::String(v) => non_empty(Some(v)),
        Value::Integer(i) => Some(i.to_string()),
        Value::Real(r) => Some(r.to_string()),
        _ => None,
    }
}

fn b(d: &Dictionary, keys: &[&str]) -> bool {
    match get(d, keys) {
        Some(Value::Boolean(v)) => *v,
        Some(Value::Integer(i)) => i.as_signed().unwrap_or(0) != 0,
        Some(Value::String(v)) => matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes"),
        _ => false,
    }
}

fn i(d: &Dictionary, keys: &[&str]) -> Option<i64> {
    match get(d, keys)? {
        Value::Integer(v) => v.as_signed(),
        Value::String(v) => v.trim().parse().ok(),
        _ => None,
    }
}

/// TablePlus SSL modes, in the order its connection form lists them.
fn tls_mode(d: &Dictionary) -> Option<TlsMode> {
    const KEYS: &[&str] = &["tLSMode", "TlsMode", "TLSMode", "tlsMode", "SSLMode", "sslMode"];
    if let Some(n) = i(d, KEYS) {
        return Some(match n {
            0 => TlsMode::Preferred,
            1 => TlsMode::Disabled,
            2 => TlsMode::Required,
            3 => TlsMode::VerifyCa,
            4 => TlsMode::VerifyIdentity,
            _ => return None,
        });
    }
    s(d, KEYS).and_then(|v| crate::tls_mode_from_name(&v))
}

/// Parses `ConnectionGroups.plist` into ID -> full group name (nested groups joined).
fn groups(data: Option<&[u8]>) -> HashMap<String, String> {
    let Some(Ok(Value::Array(items))) = data.map(|d| Value::from_reader(std::io::Cursor::new(d))) else { return HashMap::new() };
    let raw: HashMap<String, (String, Option<String>)> = items
        .iter()
        .filter_map(Value::as_dictionary)
        .filter_map(|g| Some((s(g, &["ID", "Id", "id"])?, (s(g, &["Name", "name"]).unwrap_or_default(), s(g, &["GroupID", "ParentID"])))))
        .collect();
    raw.keys()
        .filter_map(|id| {
            let mut parts = Vec::new();
            let mut cur = Some(id.clone());
            while let Some(c) = cur {
                let Some((name, parent)) = raw.get(&c) else { break };
                parts.insert(0, name.clone());
                cur = parent.clone().filter(|p| p != &c && parts.len() < 16);
            }
            Some((id.clone(), group_path(&parts)?))
        })
        .collect()
}

/// Parses `Connections.plist` (XML or binary) plus, optionally, `ConnectionGroups.plist`.
pub fn parse(connections: &[u8], group_file: Option<&[u8]>, ctx: &Ctx) -> Parsed {
    let v = Value::from_reader(std::io::Cursor::new(connections)).map_err(|e| invalid("not a TablePlus connections file", e))?;
    let items = v.as_array().ok_or_else(|| invalid("not a TablePlus connections file", "expected a list of connections"))?;
    let groups = groups(group_file);
    let mut out = Vec::new();
    for (n, item) in items.iter().enumerate() {
        let Some(d) = item.as_dictionary() else { continue };
        let id = s(d, &["ID", "Id", "id"]).unwrap_or_else(|| format!("row-{}", n + 1));
        let driver = s(d, &["Driver", "DatabaseType", "driver"]).unwrap_or_default();
        let name = s(d, &["ConnectionName", "Name", "name"]);
        let Some(engine) = engine_from_name(&driver) else {
            out.push(ImportedConnection::new(id, name.unwrap_or_else(|| driver.clone()), driver, None));
            continue;
        };
        let mut cfg = blank(engine, "");
        let mut notes = Vec::new();
        cfg.host = s(d, &["DatabaseHost", "Host", "host"]);
        cfg.port = s(d, &["DatabasePort", "Port", "port"]).and_then(|p| port_from(&p));
        cfg.username = s(d, &["DatabaseUser", "User", "user"]);
        cfg.database = if engine.wire_family() == Some(dbs_core::Engine::Sqlite) || matches!(engine, dbs_core::Engine::DuckDb) {
            s(d, &["DatabasePath", "DatabaseName"]).map(|p| ctx.expand(&p))
        } else {
            s(d, &["DatabaseName", "Database"])
        };
        if b(d, &["isUseSocket", "IsUseSocket"]) {
            cfg.socket_path = s(d, &["DatabaseSocket", "Socket"]);
        }
        if let Some(m) = tls_mode(d) {
            cfg.tls.mode = m;
        }
        // TlsKeyPaths: [client key, client certificate, CA certificate] (labels in TlsKeyName).
        if let Some(Value::Array(p)) = get(d, &["TlsKeyPaths", "TLSKeyPaths"]) {
            let at = |k: usize| p.get(k).and_then(Value::as_string).and_then(|x| non_empty(Some(x))).map(|x| ctx.expand(&x));
            cfg.tls.client_key_path = at(0);
            cfg.tls.client_cert_path = at(1);
            cfg.tls.ca_cert_path = at(2);
        }
        let file_based = engine.wire_family() == Some(dbs_core::Engine::Sqlite) || matches!(engine, dbs_core::Engine::DuckDb);
        if cfg.host.is_none() && cfg.socket_path.is_none() && !file_based {
            // The connection form shows 127.0.0.1 as the placeholder for an empty host.
            cfg.host = Some("127.0.0.1".into());
            notes.push("Host was empty in the source; using 127.0.0.1".into());
        }
        if b(d, &["isOverSSH", "IsOverSSH", "OverSSH"]) {
            let host = s(d, &["ServerAddress", "SSHHost"]).unwrap_or_default();
            let user = s(d, &["ServerUser", "SSHUser"]).unwrap_or_default();
            let port = s(d, &["ServerPort", "SSHPort"]).and_then(|p| port_from(&p)).unwrap_or(22);
            let mut ssh = SshConfig { host, port, user, auth: SshAuth::Password, private_key_path: None, jump_hosts: vec![], keepalive_secs: 30 };
            if b(d, &["isUsePrivateKey", "IsUsePrivateKey"]) {
                ssh.auth = SshAuth::PrivateKey;
                let key = s(d, &["ServerPrivateKeyPath", "ServerPrivateKeyName", "PrivateKeyPath"]).filter(|k| !k.ends_with("..."));
                match key {
                    Some(k) if k.contains('/') => ssh.private_key_path = Some(ctx.expand(&k)),
                    // A bare file name: TablePlus picks keys from ~/.ssh.
                    Some(k) => {
                        ssh.private_key_path = Some(ctx.expand(&format!("~/.ssh/{k}")));
                        notes.push("SSH key path assumed to be in ~/.ssh".into());
                    }
                    None => {
                        ssh.auth = SshAuth::Agent;
                        notes.push(
                            "SSH private key is stored inside the source app; using the SSH agent instead (choose the key file after import if needed)".into(),
                        );
                    }
                }
            }
            if ssh.host.is_empty() || ssh.user.is_empty() {
                notes.push("SSH host or user is missing".into());
            }
            cfg.ssh = Some(ssh);
        }
        cfg.environment = match s(d, &["Enviroment", "Environment", "environment"]).and_then(|e| environment_from_name(&e)) {
            Some(e) => e,
            None => default_environment(&cfg),
        };
        if cfg.environment == EnvironmentKind::Custom {
            if let Some(e) = s(d, &["Enviroment", "Environment"]) {
                cfg.tags.push(e);
            }
        }
        cfg.color = s(d, &["statusColor", "StatusColor", "Color"]).and_then(|c| hex_color(&c));
        cfg.group = s(d, &["GroupID", "GroupId"]).and_then(|g| groups.get(&g).cloned());
        cfg.name = name.unwrap_or_else(|| fallback_name(&cfg));
        let ssh_password = cfg.ssh.as_ref().is_some_and(|x| x.auth == SshAuth::Password);
        let mut row = ImportedConnection::new(id.clone(), cfg.name.clone(), driver, Some(cfg));
        row.notes = notes;
        if !id.starts_with("row-") {
            row.keychain.push(KeychainItem { kind: SecretKind::DbPassword, service: KEYCHAIN_SERVICE.into(), account: db_password_account(&id) });
            if ssh_password {
                row.keychain.push(KeychainItem { kind: SecretKind::SshPassword, service: KEYCHAIN_SERVICE.into(), account: ssh_password_account(&id) });
            }
        }
        out.push(row);
    }
    Ok(out)
}
