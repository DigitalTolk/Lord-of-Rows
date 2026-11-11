//! Connection URLs (`postgres://user@host:5432/db?sslmode=...`), one or many.

use dbs_core::{ConnectionConfig, DbError, DbResult, Engine, TlsMode};
use dbs_secrets::Secret;

use crate::{blank, default_environment, ImportedConnection, Parsed};

/// Parses one URL into a config (nil id, Development environment). A password in the
/// URL is returned separately so it can go to the keychain.
pub fn parse_url(url: &str) -> DbResult<(ConnectionConfig, Option<String>)> {
    if url.len() > 4096 {
        return Err(DbError::invalid("URL is too large"));
    }
    let url = url.trim();
    let (scheme, rest) = url
        .split_once("://")
        .or_else(|| url.split_once(':').filter(|(s, _)| s.eq_ignore_ascii_case("sqlite")))
        .ok_or_else(|| DbError::invalid("not a connection URL"))?;
    let engine = match scheme.to_ascii_lowercase().as_str() {
        "postgres" | "postgresql" => Engine::Postgres,
        "mysql" => Engine::MySql,
        "mariadb" => Engine::MariaDb,
        "redis" | "rediss" => Engine::Redis,
        "sqlite" | "file" => Engine::Sqlite,
        "cockroachdb" => Engine::CockroachDb,
        _ => return Err(DbError::unsupported(&format!("URL scheme {scheme}"))),
    };
    let mut cfg = blank(engine, "");
    if engine == Engine::Sqlite {
        if rest.is_empty() {
            return Err(DbError::invalid("a database file path is required"));
        }
        cfg.database = Some(rest.to_string());
        cfg.name = rest.rsplit('/').next().unwrap_or("sqlite").to_string();
        return Ok((cfg, None));
    }
    let (main, query) = rest.split_once('?').unwrap_or((rest, ""));
    let (auth_host, db) = main.split_once('/').unwrap_or((main, ""));
    let (auth, hostport) = match auth_host.rsplit_once('@') {
        Some((a, h)) => (Some(a), h),
        None => (None, auth_host),
    };
    let mut password = None;
    if let Some(a) = auth {
        let (u, p) = a.split_once(':').map(|(u, p)| (u, Some(p))).unwrap_or((a, None));
        cfg.username = Some(pct_decode(u)).filter(|s| !s.is_empty());
        password = p.map(pct_decode);
    }
    let (h, p) = match hostport.rsplit_once(':') {
        Some((h, p)) if !h.ends_with(']') || hostport.starts_with('[') => (h, Some(p)),
        _ => (hostport, None),
    };
    cfg.host = Some(h.to_string()).filter(|s| !s.is_empty());
    if let Some(p) = p {
        cfg.port = Some(p.parse().map_err(|_| DbError::invalid("invalid port"))?);
    }
    cfg.database = Some(pct_decode(db)).filter(|s| !s.is_empty());
    for kv in query.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        match (k, v) {
            ("sslmode" | "ssl-mode" | "ssl_mode", m) => {
                cfg.tls.mode = match m.to_ascii_lowercase().replace('_', "-").as_str() {
                    "disable" | "disabled" => TlsMode::Disabled,
                    "allow" | "prefer" | "preferred" => TlsMode::Preferred,
                    "require" | "required" => TlsMode::Required,
                    "verify-ca" => TlsMode::VerifyCa,
                    // verify-full / verify-identity, and anything unknown: the strictest mode.
                    _ => TlsMode::VerifyIdentity,
                }
            }
            // libpq certificate parameters (paths only; files are read at connect time).
            ("sslrootcert", p) if !p.is_empty() => cfg.tls.ca_cert_path = Some(pct_decode(p)),
            ("sslcert", p) if !p.is_empty() => cfg.tls.client_cert_path = Some(pct_decode(p)),
            ("sslkey", p) if !p.is_empty() => cfg.tls.client_key_path = Some(pct_decode(p)),
            _ => {}
        }
    }
    let has_mode = ["sslmode=", "ssl-mode=", "ssl_mode="].iter().any(|k| query.contains(k));
    if !has_mode {
        cfg.tls.mode = match scheme.to_ascii_lowercase().as_str() {
            "redis" => TlsMode::Disabled,
            "rediss" => TlsMode::VerifyIdentity,
            // libpq / MySQL client default.
            _ => TlsMode::Preferred,
        };
    }
    cfg.name = format!("{}@{}", cfg.database.clone().unwrap_or_default(), cfg.host.clone().unwrap_or_default());
    Ok((cfg, password))
}

pub fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// One URL per line; blank lines and `#` comments are ignored. Lines that don't parse
/// become rows with an error, so the user sees what was skipped.
pub fn parse_list(text: &str) -> Parsed {
    if text.len() > 1024 * 1024 {
        return Err(DbError::invalid("the URL list is too large"));
    }
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let key = format!("line-{}", i + 1);
        let scheme = line.split(':').next().unwrap_or("").to_string();
        match parse_url(line) {
            Ok((mut cfg, pw)) => {
                cfg.environment = default_environment(&cfg);
                let mut row = ImportedConnection::new(key, cfg.name.clone(), scheme, Some(cfg));
                row.password = pw.filter(|p| !p.is_empty()).map(Secret::new);
                out.push(row);
            }
            Err(e) => {
                // Never echo the line itself: it may contain a password.
                let mut row = ImportedConnection::new(key, format!("Line {}", i + 1), scheme, None);
                row.error = Some(e.message);
                out.push(row);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbs_core::EnvironmentKind;

    #[test]
    fn url_list() {
        let rows = parse_list(
            "# team DBs\npostgres://app:s3cret@db.example.com:5432/shop?sslmode=require\n\nmysql://root@localhost/dev\nsqlite:/tmp/x.db\nmongodb://h/x\n",
        )
        .unwrap();
        assert_eq!(rows.len(), 4);
        let pg = rows[0].config.as_ref().unwrap();
        assert_eq!((pg.engine, pg.host.as_deref(), pg.port, pg.tls.mode), (Engine::Postgres, Some("db.example.com"), Some(5432), TlsMode::Required));
        assert_eq!(pg.environment, EnvironmentKind::Development);
        assert_eq!(rows[0].password.as_ref().unwrap().expose(), "s3cret");
        assert_eq!(rows[1].config.as_ref().unwrap().environment, EnvironmentKind::Local);
        assert_eq!(rows[2].config.as_ref().unwrap().database.as_deref(), Some("/tmp/x.db"));
        assert!(rows[3].config.is_none() && rows[3].error.is_some());
        assert!(!rows[3].name.contains("mongodb"));
    }

    #[test]
    fn pct_decode_handles_edge_cases() {
        assert_eq!(pct_decode("a%2"), "a%2");
        assert_eq!(pct_decode("%zz"), "%zz");
        assert_eq!(pct_decode("%41"), "A");
    }
}
