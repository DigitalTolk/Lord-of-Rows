//! DataGrip / IntelliJ data sources: `.idea/dataSources.xml` (driver, JDBC URL, group)
//! plus `.idea/dataSources.local.xml` (user name, SSH / SSL settings) and the IDE's
//! `options/sshConfigs.xml` (SSH hosts referenced by id). Passwords are kept by the
//! IDE in its own credential store and are not imported.

use std::collections::HashMap;

use dbs_core::{ConnectionConfig, Engine, SshAuth, SshConfig, TlsMode};

use crate::xml::{self, Element};
use crate::{blank, default_environment, engine_from_name, fallback_name, group_path, invalid, port_from, Ctx, ImportedConnection, Parsed};

/// Splits `jdbc:<sub>:...` into the sub-protocol and a config with host/port/database.
fn from_jdbc(url: &str, engine: Engine, ctx: &Ctx) -> ConnectionConfig {
    let mut cfg = blank(engine, "");
    let rest = url.trim().strip_prefix("jdbc:").unwrap_or(url.trim());
    if engine.wire_family() == Some(Engine::Sqlite) || engine == Engine::DuckDb {
        let path = rest.split_once(':').map(|(_, p)| p).unwrap_or("");
        let path = path.split('?').next().unwrap_or("").trim_start_matches("file:");
        cfg.database = Some(ctx.expand(path)).filter(|p| !p.is_empty());
        return cfg;
    }
    if matches!(engine.wire_family(), Some(Engine::Postgres | Engine::MySql | Engine::Redis)) {
        let scheme = match engine.wire_family() {
            Some(Engine::Postgres) => "postgresql",
            Some(Engine::MySql) => "mysql",
            _ => "redis",
        };
        if let Some((_, after)) = rest.split_once("://") {
            // Only the first host of a multi-host URL; credentials in the URL are dropped.
            let (hosts, tail) = after.split_once(['/', '?']).map(|(h, _)| (h, &after[h.len()..])).unwrap_or((after, ""));
            let first = hosts.split(',').next().unwrap_or(hosts);
            let first = first.rsplit_once('@').map(|(_, h)| h).unwrap_or(first);
            if let Ok((mut c, _password)) = crate::urls::parse_url(&format!("{scheme}://{first}{tail}")) {
                c.engine = engine;
                return c;
            }
        }
    }
    // Generic: `sub://host:port/db` or `sub://host:port;databaseName=db` or Oracle `@host:port:sid`.
    let after = rest.split_once("://").map(|(_, a)| a).or_else(|| rest.split_once('@').map(|(_, a)| a.trim_start_matches("//"))).unwrap_or("");
    let authority = after.split(['/', ';', '?']).next().unwrap_or("");
    let authority = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority).split(',').next().unwrap_or("");
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => (h, port_from(p)),
        _ => (authority, None),
    };
    cfg.host = Some(host.to_string()).filter(|h| !h.is_empty());
    cfg.port = port;
    cfg.database = after
        .split(';')
        .find_map(|kv| kv.strip_prefix("databaseName=").or_else(|| kv.strip_prefix("database=")))
        .map(str::to_string)
        .or_else(|| after.split_once('/').map(|(_, d)| d.split(['?', ';']).next().unwrap_or("").to_string()))
        .filter(|d| !d.is_empty());
    cfg
}

fn ssl(e: &Element, cfg: &mut ConnectionConfig, ctx: &Ctx) {
    let Some(s) = e.child("ssl-config") else { return };
    if s.child_text("enabled") == Some("false") {
        return;
    }
    cfg.tls.mode = s.child_text("mode").and_then(crate::tls_mode_from_name).unwrap_or(TlsMode::Required);
    let p = |k: &str| s.child_text(k).map(|x| ctx.expand(x));
    cfg.tls.ca_cert_path = p("ca-cert");
    cfg.tls.client_cert_path = p("client-cert");
    cfg.tls.client_key_path = p("client-key");
}

/// `options/sshConfigs.xml`: id -> SSH settings.
fn ssh_configs(text: Option<&str>, ctx: &Ctx) -> HashMap<String, SshConfig> {
    let Some(Ok(root)) = text.map(xml::parse) else { return HashMap::new() };
    root.descendants("sshConfig")
        .into_iter()
        .filter_map(|c| {
            let key = c.attr("keyPath").filter(|k| !k.is_empty()).map(|k| ctx.expand(&k.replace("$USER_HOME$", "~")));
            let auth = match c.attr("authType").unwrap_or("") {
                "KEY_PAIR" => SshAuth::PrivateKey,
                "OPEN_SSH" => SshAuth::Agent,
                _ => SshAuth::Password,
            };
            let cfg = SshConfig {
                host: c.attr("host").unwrap_or("").to_string(),
                port: c.attr("port").and_then(port_from).unwrap_or(22),
                user: c.attr("username").unwrap_or("").to_string(),
                auth,
                private_key_path: if auth == SshAuth::PrivateKey { key } else { None },
                jump_hosts: vec![],
                keepalive_secs: 30,
            };
            Some((c.attr("id")?.to_string(), cfg))
        })
        .collect()
}

/// `data_sources`: dataSources.xml; `local`: dataSources.local.xml; `ssh`: sshConfigs.xml.
pub fn parse(data_sources: &str, local: Option<&str>, ssh: Option<&str>, ctx: &Ctx) -> Parsed {
    let root = xml::parse(data_sources).map_err(|e| invalid("not a dataSources.xml file", e))?;
    let sources = root.descendants("data-source");
    if root.name != "project" && root.name != "application" {
        return Err(invalid("not a dataSources.xml file", "unexpected root element"));
    }
    let local_root = local.and_then(|l| xml::parse(l).ok());
    let locals: HashMap<&str, &Element> =
        local_root.as_ref().map(|r| r.descendants("data-source").into_iter().filter_map(|d| Some((d.attr("uuid")?, d))).collect()).unwrap_or_default();
    let tunnels = ssh_configs(ssh, ctx);
    let mut out = Vec::new();
    for (i, ds) in sources.into_iter().enumerate() {
        let key = ds.attr("uuid").map(str::to_string).unwrap_or_else(|| format!("row-{}", i + 1));
        let name = ds.attr("name").map(str::to_string).filter(|n| !n.is_empty());
        let driver = ds.child_text("driver-ref").unwrap_or("").to_string();
        let url = ds.child_text("jdbc-url").unwrap_or("");
        let sub = url.strip_prefix("jdbc:").and_then(|r| r.split(':').next()).unwrap_or("");
        let label = if driver.is_empty() { sub.to_string() } else { driver.clone() };
        let Some(engine) = engine_from_name(&driver).or_else(|| engine_from_name(sub)) else {
            out.push(ImportedConnection::new(key, name.unwrap_or_else(|| label.clone()), label, None));
            continue;
        };
        let mut cfg = from_jdbc(url, engine, ctx);
        let mut notes = Vec::new();
        let loc = locals.get(key.as_str()).copied();
        cfg.username = ds.child_text("user-name").or_else(|| loc.and_then(|l| l.child_text("user-name"))).map(str::to_string);
        ssl(ds, &mut cfg, ctx);
        if let Some(l) = loc {
            ssl(l, &mut cfg, ctx);
        }
        let ssh_props = ds.child("ssh-properties").or_else(|| loc.and_then(|l| l.child("ssh-properties")));
        if let Some(sp) = ssh_props.filter(|sp| sp.child_text("enabled") == Some("true")) {
            match sp.child_text("ssh-config-id").and_then(|id| tunnels.get(id)) {
                Some(t) => cfg.ssh = Some(t.clone()),
                None => notes.push("Uses an SSH tunnel whose settings are stored in the IDE; set up SSH after import".into()),
            }
        }
        cfg.group = ds.attr("group").and_then(|g| group_path(&g.split('/').map(str::to_string).collect::<Vec<_>>()));
        cfg.environment = default_environment(&cfg);
        cfg.notes = ds.child_text("comment").map(str::to_string);
        if ds.child_text("read-only") == Some("true") {
            cfg.read_only = true;
        }
        cfg.name = name.unwrap_or_else(|| fallback_name(&cfg));
        let mut row = ImportedConnection::new(key, cfg.name.clone(), label, Some(cfg));
        row.notes = notes;
        out.push(row);
    }
    Ok(out)
}
