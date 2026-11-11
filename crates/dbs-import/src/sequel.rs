//! Sequel Ace / Sequel Pro `Favorites.plist`: `{"Favorites Root": {"Children": [...]}}`,
//! where an entry with `Children` is a group. MySQL only. Passwords (kept in the
//! keychain by these apps) are not imported.

use dbs_core::{Engine, SshAuth, SshConfig, TlsMode};
use plist::{Dictionary, Value};

use crate::{blank, default_environment, fallback_name, group_path, invalid, non_empty, port_from, Ctx, ImportedConnection, Parsed};

fn s(d: &Dictionary, k: &str) -> Option<String> {
    match d.get(k)? {
        Value::String(v) => non_empty(Some(v)),
        Value::Integer(i) => Some(i.to_string()),
        _ => None,
    }
}

fn n(d: &Dictionary, k: &str) -> i64 {
    match d.get(k) {
        Some(Value::Integer(i)) => i.as_signed().unwrap_or(0),
        Some(Value::Boolean(b)) => *b as i64,
        Some(Value::String(v)) => v.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// The favourite colour labels, in menu order.
const COLORS: [&str; 7] = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#6b7280"];

fn walk(items: &[Value], path: &mut Vec<String>, ctx: &Ctx, out: &mut Vec<ImportedConnection>) {
    for item in items {
        let Some(d) = item.as_dictionary() else { continue };
        if let Some(Value::Array(children)) = d.get("Children") {
            if path.len() < 16 {
                path.push(s(d, "Name").unwrap_or_default());
                walk(children, path, ctx, out);
                path.pop();
            }
            continue;
        }
        let key = s(d, "id").unwrap_or_else(|| format!("row-{}", out.len() + 1));
        let mut cfg = blank(Engine::MySql, "");
        let mut notes = Vec::new();
        cfg.host = s(d, "host");
        cfg.port = s(d, "port").and_then(|p| port_from(&p));
        cfg.username = s(d, "user");
        cfg.database = s(d, "database");
        // type: 0 = TCP/IP, 1 = socket, 2 = SSH, 3 = AWS IAM.
        match n(d, "type") {
            1 => {
                cfg.socket_path = s(d, "socket").or_else(|| Some("/tmp/mysql.sock".into()));
                cfg.host = cfg.host.or_else(|| Some("localhost".into()));
            }
            2 => {
                let key = if n(d, "sshKeyLocationEnabled") != 0 { s(d, "sshKeyLocation").map(|k| ctx.expand(&k)) } else { None };
                cfg.ssh = Some(SshConfig {
                    host: s(d, "sshHost").unwrap_or_default(),
                    port: s(d, "sshPort").and_then(|p| port_from(&p)).unwrap_or(22),
                    user: s(d, "sshUser").unwrap_or_default(),
                    auth: if key.is_some() { SshAuth::PrivateKey } else { SshAuth::Password },
                    private_key_path: key,
                    jump_hosts: vec![],
                    keepalive_secs: 30,
                });
            }
            3 => notes.push("AWS IAM authentication is not supported; a password is needed".into()),
            _ => {}
        }
        if cfg.host.is_none() && cfg.socket_path.is_none() {
            cfg.host = Some("127.0.0.1".into());
        }
        cfg.tls.mode = TlsMode::Preferred;
        if n(d, "useSSL") != 0 {
            cfg.tls.mode = TlsMode::Required;
            let path = |file: &str, on: &str| if n(d, on) != 0 { s(d, file).map(|p| ctx.expand(&p)) } else { None };
            cfg.tls.client_key_path = path("sslKeyFileLocation", "sslKeyFileLocationEnabled");
            cfg.tls.client_cert_path = path("sslCertificateFileLocation", "sslCertificateFileLocationEnabled");
            cfg.tls.ca_cert_path = path("sslCACertFileLocation", "sslCACertFileLocationEnabled");
            if cfg.tls.ca_cert_path.is_some() {
                cfg.tls.mode = TlsMode::VerifyCa;
            }
        }
        let ci = n(d, "colorIndex");
        cfg.color = usize::try_from(ci).ok().and_then(|i| COLORS.get(i)).map(|c| c.to_string());
        cfg.environment = default_environment(&cfg);
        cfg.group = group_path(path);
        cfg.name = s(d, "name").unwrap_or_else(|| fallback_name(&cfg));
        let mut row = ImportedConnection::new(key, cfg.name.clone(), "MySQL", Some(cfg));
        row.notes = notes;
        out.push(row);
    }
}

pub fn parse(data: &[u8], ctx: &Ctx) -> Parsed {
    let v = Value::from_reader(std::io::Cursor::new(data)).map_err(|e| invalid("not a favorites file", e))?;
    let root = v.as_dictionary().and_then(|d| d.get("Favorites Root")).and_then(Value::as_dictionary);
    let children = root.and_then(|r| r.get("Children")).and_then(Value::as_array).ok_or_else(|| invalid("not a favorites file", "no \"Favorites Root\""))?;
    let mut out = Vec::new();
    walk(children, &mut vec![], ctx, &mut out);
    Ok(out)
}
