//! Company rollout helpers: providers preconfigured by the organisation (a JSON file
//! deployed by device management) and `lordoftherows://access` deep links.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{check_id, normalize_base_url, provider_kinds, resolve_kind, AccessError, AccessResult, ProviderConfig};

/// URL scheme of deep links.
pub const DEEP_LINK_SCHEME: &str = "lordoftherows";

#[derive(Deserialize)]
struct ManagedEntry {
    kind: String,
    name: String,
    url: String,
}

/// Stable id of a provider preconfigured for `url` (so its session survives restarts).
pub fn managed_id(normalized_url: &str) -> Uuid {
    let h = Sha256::digest(format!("lotr-managed-access-provider:{normalized_url}").as_bytes());
    let mut b = [0u8; 16];
    b.copy_from_slice(&h[..16]);
    b[6] = (b[6] & 0x0f) | 0x80; // version 8 (custom)
    b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
    Uuid::from_bytes(b)
}

/// Parses a managed `providers.json`: `[{"kind":"access-api","name":"…","url":"https://…"}]`.
/// Entries are validated like user-added providers; invalid ones are skipped and
/// reported. Duplicate URLs keep the first entry. An unknown kind is read as the only
/// registered kind when there is just one (see [`resolve_kind`]).
pub fn parse_managed(json: &str) -> (Vec<ProviderConfig>, Vec<String>) {
    let mut errors = Vec::new();
    if json.len() > 1024 * 1024 {
        return (vec![], vec!["providers file is too large".into()]);
    }
    let entries: Vec<serde_json::Value> = match serde_json::from_str(json) {
        Ok(serde_json::Value::Array(a)) => a,
        Ok(_) => return (vec![], vec!["providers file must be a JSON array".into()]),
        Err(e) => return (vec![], vec![format!("providers file is not valid JSON: {e}")]),
    };
    let mut out: Vec<ProviderConfig> = Vec::new();
    for (i, v) in entries.into_iter().enumerate() {
        let e: ManagedEntry = match serde_json::from_value(v) {
            Ok(e) => e,
            Err(err) => {
                errors.push(format!("entry {i}: {err}"));
                continue;
            }
        };
        let cfg = ProviderConfig { id: Uuid::nil(), kind: e.kind, name: e.name, base_url: e.url }.with_resolved_kind().validated();
        match cfg {
            Ok(mut c) => {
                if out.iter().any(|o| o.base_url == c.base_url) {
                    continue;
                }
                c.id = managed_id(&c.base_url);
                out.push(c);
            }
            Err(err) => errors.push(format!("entry {i}: {err}")),
        }
    }
    (out, errors)
}

/// Merges sources in priority order (first wins on duplicate URLs).
pub fn merge_managed(sources: Vec<Vec<ProviderConfig>>) -> Vec<ProviderConfig> {
    let mut out: Vec<ProviderConfig> = Vec::new();
    for c in sources.into_iter().flatten() {
        if !out.iter().any(|o| o.base_url == c.base_url) {
            out.push(c);
        }
    }
    out
}

/// `lordoftherows://access?provider=<url-encoded base URL>&request=<id>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeepLink {
    /// Normalised provider base URL.
    pub provider_url: String,
    pub request_id: Option<String>,
    /// Provider kind, if the link names one (default: the only / first kind).
    pub kind: String,
}

pub fn parse_deep_link(raw: &str) -> AccessResult<DeepLink> {
    let bad = |m: &str| AccessError::Invalid(format!("unsupported link: {m}"));
    if raw.len() > 4096 {
        return Err(bad("too long"));
    }
    let u = url::Url::parse(raw).map_err(|_| bad("not a URL"))?;
    if u.scheme() != DEEP_LINK_SCHEME || u.host_str() != Some("access") || !matches!(u.path(), "" | "/") {
        return Err(bad("expected lordoftherows://access"));
    }
    let get = |k: &str| u.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
    let provider_url = normalize_base_url(&get("provider").ok_or_else(|| bad("missing provider"))?)?;
    let request_id = get("request").filter(|r| !r.is_empty());
    if let Some(r) = &request_id {
        check_id(r)?;
    }
    let kind = match get("kind") {
        Some(k) => resolve_kind(&k).ok_or_else(|| bad("unknown provider type"))?.to_string(),
        None => provider_kinds()[0].kind.to_string(),
    };
    Ok(DeepLink { provider_url, request_id, kind })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_file() {
        let (ps, errs) = parse_managed(
            r#"[
              {"kind":"access-api","name":"Company access","url":"https://access.example.com/"},
              {"kind":"access-api","name":"Duplicate","url":"https://access.example.com"},
              {"kind":"access-api","name":"Plain","url":"http://access.example.com"},
              {"name":"missing kind","url":"https://y.example.com"}
            ]"#,
        );
        assert_eq!(ps.len(), 1);
        assert_eq!((ps[0].name.as_str(), ps[0].base_url.as_str()), ("Company access", "https://access.example.com"));
        assert_eq!(ps[0].id, managed_id("https://access.example.com"), "stable id");
        assert_eq!(errs.len(), 2, "{errs:?}");
        // A kind this build doesn't know is read as the only registered kind.
        let (ps, errs) = parse_managed(r#"[{"kind":"older-name","name":"X","url":"https://x.example.com"}]"#);
        if provider_kinds().len() == 1 {
            assert_eq!((ps[0].kind.as_str(), errs.len()), ("access-api", 0));
        } else {
            assert_eq!((ps.len(), errs.len()), (0, 1));
        }
        assert!(parse_managed("{}").1[0].contains("array"));
        assert!(parse_managed("nope").1[0].contains("JSON"));
        let a = parse_managed(r#"[{"kind":"access-api","name":"System","url":"https://a.example.com"}]"#).0;
        let b = parse_managed(
            r#"[{"kind":"access-api","name":"User","url":"https://a.example.com"},{"kind":"access-api","name":"Other","url":"https://b.example.com"}]"#,
        )
        .0;
        let m = merge_managed(vec![a, b]);
        assert_eq!(m.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["System", "Other"]);
    }

    #[test]
    fn deep_links() {
        let l = parse_deep_link("lordoftherows://access?provider=https%3A%2F%2Faccess.example.com%2F&request=req-42").unwrap();
        assert_eq!(l, DeepLink { provider_url: "https://access.example.com".into(), request_id: Some("req-42".into()), kind: "access-api".into() });
        assert_eq!(parse_deep_link("lordoftherows://access?provider=https://access.example.com").unwrap().request_id, None);
        for bad in [
            "https://access?provider=https://a.example.com",
            "lordoftherows://other?provider=https://a.example.com",
            "lordoftherows://access/x?provider=https://a.example.com",
            "lordoftherows://access",
            "lordoftherows://access?provider=http://evil.example.com",
            "lordoftherows://access?provider=https://a.example.com&request=../x",
        ] {
            assert!(parse_deep_link(bad).is_err(), "{bad}");
        }
        let named = parse_deep_link("lordoftherows://access?provider=https://a.example.com&kind=access-api").unwrap();
        assert_eq!(named.kind, "access-api");
        let other = parse_deep_link("lordoftherows://access?provider=https://a.example.com&kind=nope");
        if provider_kinds().len() == 1 {
            assert_eq!(other.unwrap().kind, "access-api");
        } else {
            assert!(other.is_err());
        }
    }
}
