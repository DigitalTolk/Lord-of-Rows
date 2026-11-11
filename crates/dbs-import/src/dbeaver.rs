//! DBeaver: `<workspace>/General/.dbeaver/data-sources*.json`.
//!
//! User names and passwords normally live in DBeaver's encrypted
//! `credentials-config.json`, which is not read: only a plain `user` in the
//! configuration (present when credentials are not saved) is imported.

use dbs_core::{Engine, EnvironmentKind, SshAuth, SshConfig, TlsMode};
use serde_json::{Map, Value};

use crate::{
    blank, default_environment, engine_from_name, environment_from_name, fallback_name, group_path, hex_color, invalid, non_empty, port_from, Ctx,
    ImportedConnection, Parsed,
};

fn st(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => non_empty(Some(s)),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

/// `"255,128,0"` (DBeaver's colour format) or `#rrggbb`.
fn color(v: &str) -> Option<String> {
    let parts: Vec<u8> = v.split(',').filter_map(|p| p.trim().parse().ok()).collect();
    if parts.len() == 3 {
        return Some(format!("#{:02x}{:02x}{:02x}", parts[0], parts[1], parts[2]));
    }
    hex_color(v)
}

fn engine(provider: &str, driver: &str) -> Option<Engine> {
    // The driver id is more specific (e.g. provider "postgresql", driver "redshift").
    let d = engine_from_name(driver);
    let p = engine_from_name(provider);
    match (p, d) {
        (_, Some(d)) => Some(d),
        (Some(p), None) => Some(p),
        _ => None,
    }
}

/// Folder keys are paths ("Prod/EU"); nested folders become "Prod / EU".
fn folder_name(key: &str) -> Option<String> {
    group_path(&key.split('/').map(str::to_string).collect::<Vec<_>>())
}

fn tls(handlers: Option<&Map<String, Value>>, cfg: &mut dbs_core::ConnectionConfig) {
    let ssl = handlers.and_then(|h| h.get("ssl")).and_then(Value::as_object);
    let Some(ssl) = ssl.filter(|s| truthy(s.get("enabled"))) else { return };
    cfg.tls.mode = TlsMode::Required;
    let Some(props) = ssl.get("properties").and_then(Value::as_object) else { return };
    for (k, v) in props {
        let k = k.to_ascii_lowercase().replace(['.', '-', '_'], "");
        let Some(v) = st(Some(v)) else { continue };
        if k.contains("mode") {
            if let Some(m) = crate::tls_mode_from_name(&v) {
                cfg.tls.mode = m;
            }
        } else if k.contains("ca") && (k.contains("cert") || k.contains("root")) || k == "sslrootcert" {
            cfg.tls.ca_cert_path = Some(v);
        } else if k.contains("clientcert") || k == "sslcert" {
            cfg.tls.client_cert_path = Some(v);
        } else if k.contains("clientkey") || k == "sslkey" {
            cfg.tls.client_key_path = Some(v);
        } else if (k == "verifyservercert" || k == "sslverifyserver") && v == "true" && cfg.tls.mode == TlsMode::Required {
            cfg.tls.mode = TlsMode::VerifyCa;
        }
    }
}

fn ssh(handlers: Option<&Map<String, Value>>, ctx: &Ctx, notes: &mut Vec<String>) -> Option<SshConfig> {
    let h = handlers?.get("ssh_tunnel")?.as_object()?;
    if !truthy(h.get("enabled")) {
        return None;
    }
    let p = h.get("properties").and_then(Value::as_object);
    let prop = |k: &str| st(p.and_then(|p| p.get(k)));
    let auth = match prop("authType").unwrap_or_default().to_ascii_uppercase().as_str() {
        "PUBLIC_KEY" => SshAuth::PrivateKey,
        "AGENT" => SshAuth::Agent,
        _ => SshAuth::Password,
    };
    let user = prop("user").unwrap_or_default();
    if user.is_empty() {
        notes.push("SSH user is kept in the source's encrypted credentials; enter it after import".into());
    }
    Some(SshConfig {
        host: prop("host").unwrap_or_default(),
        port: prop("port").and_then(|x| port_from(&x)).unwrap_or(22),
        user,
        auth,
        private_key_path: prop("keyPath").map(|k| ctx.expand(&k)),
        jump_hosts: vec![],
        keepalive_secs: 30,
    })
}

/// Parses one `data-sources*.json` file.
pub fn parse(json: &[u8], ctx: &Ctx) -> Parsed {
    let v: Value = serde_json::from_slice(json).map_err(|e| invalid("not a DBeaver data-sources file", e))?;
    let conns = v.get("connections").and_then(Value::as_object).ok_or_else(|| invalid("not a DBeaver data-sources file", "no connections"))?;
    let types = v.get("connection-types").and_then(Value::as_object);
    let mut out = Vec::new();
    for (id, c) in conns {
        let provider = st(c.get("provider")).unwrap_or_default();
        let driver = st(c.get("driver")).unwrap_or_default();
        let label = if driver.is_empty() { provider.clone() } else { driver.clone() };
        let name = st(c.get("name"));
        let Some(engine) = engine(&provider, &driver) else {
            out.push(ImportedConnection::new(id.clone(), name.unwrap_or_else(|| label.clone()), label, None));
            continue;
        };
        let conf = c.get("configuration").and_then(Value::as_object);
        let get = |k: &str| st(conf.and_then(|m| m.get(k)));
        let handlers = conf.and_then(|m| m.get("handlers")).and_then(Value::as_object);
        let mut cfg = blank(engine, "");
        let mut notes = Vec::new();
        cfg.host = get("host");
        cfg.port = get("port").and_then(|p| port_from(&p));
        cfg.database = get("database");
        if engine.wire_family() == Some(Engine::Sqlite) || engine == Engine::DuckDb {
            // File databases: the path is in `database`, or only in the JDBC URL.
            let from_url = get("url").and_then(|u| u.split_once(":sqlite:").or_else(|| u.split_once(":duckdb:")).map(|(_, p)| p.to_string()));
            cfg.database = cfg.database.or(from_url).map(|p| ctx.expand(&p));
            cfg.host = None;
            cfg.port = None;
        }
        cfg.username = get("user");
        // Without an enabled SSL handler: the drivers' default.
        cfg.tls.mode = if engine == Engine::Redis { TlsMode::Disabled } else { TlsMode::Preferred };
        tls(handlers, &mut cfg);
        cfg.ssh = ssh(handlers, ctx, &mut notes);
        let ty = get("type").unwrap_or_default();
        let ty_def = types.and_then(|t| t.get(&ty)).and_then(Value::as_object);
        cfg.environment = match ty.as_str() {
            "" => default_environment(&cfg),
            "dev" => EnvironmentKind::Development,
            "test" => EnvironmentKind::Testing,
            "prod" => EnvironmentKind::Production,
            other => {
                let prod = ty_def.is_some_and(|d| truthy(d.get("production")) || truthy(d.get("confirm-execute")));
                let label = ty_def.and_then(|d| st(d.get("name"))).unwrap_or_else(|| other.to_string());
                if prod {
                    EnvironmentKind::Production
                } else {
                    let env = environment_from_name(&label).unwrap_or(EnvironmentKind::Custom);
                    if env == EnvironmentKind::Custom {
                        cfg.tags.push(label);
                    }
                    env
                }
            }
        };
        cfg.color = get("color").or_else(|| ty_def.and_then(|d| st(d.get("color")))).and_then(|c| color(&c));
        cfg.group = st(c.get("folder")).and_then(|f| folder_name(&f));
        cfg.read_only = truthy(c.get("read-only"));
        cfg.notes = st(c.get("description"));
        if cfg.username.is_none() && engine.wire_family() != Some(Engine::Sqlite) {
            notes.push("User name is kept in the source's encrypted credentials; enter it after import".into());
        }
        cfg.name = name.unwrap_or_else(|| fallback_name(&cfg));
        let mut row = ImportedConnection::new(id.clone(), cfg.name.clone(), label, Some(cfg));
        row.notes = notes;
        out.push(row);
    }
    Ok(out)
}
