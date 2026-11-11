//! pgAdmin 4 `servers.json` (File > Export Servers / `setup.py dump-servers`).
//! Older exports keep SSL settings at the top level; newer ones under
//! `ConnectionParameters`. Passwords are never part of the export.

use dbs_core::{Engine, SshAuth, SshConfig, TlsMode};
use serde_json::{Map, Value};

use crate::{blank, default_environment, fallback_name, group_path, hex_color, invalid, non_empty, port_from, Ctx, ImportedConnection, Parsed};

fn st(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => non_empty(Some(s)),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn num(v: Option<&Value>) -> i64 {
    match v {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::Bool(b)) => *b as i64,
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

pub fn parse(json: &[u8], ctx: &Ctx) -> Parsed {
    let v: Value = serde_json::from_slice(json).map_err(|e| invalid("not a pgAdmin servers file", e))?;
    let servers = v.get("Servers").and_then(Value::as_object).ok_or_else(|| invalid("not a pgAdmin servers file", "no \"Servers\""))?;
    let mut out = Vec::new();
    for (id, srv) in servers {
        let Some(m) = srv.as_object() else { continue };
        let get = |k: &str| st(m.get(k));
        let params: Option<&Map<String, Value>> = m.get("ConnectionParameters").and_then(Value::as_object);
        let param = |k: &str| st(params.and_then(|p| p.get(k)));
        let mut cfg = blank(Engine::Postgres, "");
        cfg.host = get("Host").or_else(|| get("HostAddr"));
        cfg.port = get("Port").and_then(|p| port_from(&p));
        cfg.database = get("MaintenanceDB");
        cfg.username = get("Username");
        cfg.tls.mode = param("sslmode").or_else(|| get("SSLMode")).and_then(|x| crate::tls_mode_from_name(&x)).unwrap_or(TlsMode::Preferred);
        cfg.tls.ca_cert_path = param("sslrootcert").or_else(|| get("SSLRootCert")).map(|p| ctx.expand(&p));
        cfg.tls.client_cert_path = param("sslcert").or_else(|| get("SSLCert")).map(|p| ctx.expand(&p));
        cfg.tls.client_key_path = param("sslkey").or_else(|| get("SSLKey")).map(|p| ctx.expand(&p));
        if let Some(t) = param("connect_timeout").and_then(|t| t.parse::<u32>().ok()).filter(|t| (1..=600).contains(t)) {
            cfg.connect_timeout_secs = t;
        }
        if num(m.get("UseSSHTunnel")) != 0 {
            let key = if num(m.get("TunnelAuthentication")) == 1 { get("TunnelIdentityFile").map(|k| ctx.expand(&k)) } else { None };
            cfg.ssh = Some(SshConfig {
                host: get("TunnelHost").unwrap_or_default(),
                port: get("TunnelPort").and_then(|p| port_from(&p)).unwrap_or(22),
                user: get("TunnelUsername").unwrap_or_default(),
                auth: if key.is_some() { SshAuth::PrivateKey } else { SshAuth::Password },
                private_key_path: key,
                jump_hosts: vec![],
                keepalive_secs: 30,
            });
        }
        cfg.color = get("BGColor").and_then(|c| hex_color(&c));
        cfg.notes = get("Comment");
        cfg.group = get("Group").and_then(|g| group_path(&[g]));
        cfg.environment = default_environment(&cfg);
        cfg.name = get("Name").unwrap_or_else(|| fallback_name(&cfg));
        let mut row = ImportedConnection::new(id.clone(), cfg.name.clone(), "PostgreSQL", Some(cfg));
        if get("Service").is_some() && get("Host").is_none() {
            row.notes.push("Uses a pg_service.conf service; enter the host after import".into());
        }
        out.push(row);
    }
    Ok(out)
}
