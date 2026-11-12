//! Provider implementations and the registry keyed by provider kind. Adding a
//! provider = one module implementing [`AccessProvider`] + one entry below.
//! [`access_api`] (the Access API, `docs/access-api.md`) is the reference implementation.

pub mod access_api;

use std::collections::HashSet;
use std::sync::Mutex;

use serde::Serialize;

use crate::{AccessProvider, AccessResult, ProviderConfig};

/// A provider implementation the user can add.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProviderKindInfo {
    pub kind: &'static str,
    /// Product name shown in the "Add provider" picker.
    pub label: &'static str,
    /// Default display name for a new provider of this kind.
    pub default_name: &'static str,
}

pub fn provider_kinds() -> Vec<ProviderKindInfo> {
    vec![ProviderKindInfo { kind: access_api::KIND, label: "Access API", default_name: "Access API" }]
}

/// Resolves a provider kind read from stored settings, a managed `providers.json` or a
/// deep link to a registered kind. A kind this build doesn't know (for example one
/// written by a development build under another name) is read as the only registered
/// kind when exactly one is registered, and logged once; otherwise `None`.
pub fn resolve_kind(kind: &str) -> Option<&'static str> {
    let kinds = provider_kinds();
    if let Some(k) = kinds.iter().find(|k| k.kind == kind) {
        return Some(k.kind);
    }
    let [only] = kinds.as_slice() else { return None };
    static LOGGED: Mutex<Option<HashSet<String>>> = Mutex::new(None);
    if LOGGED.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashSet::new).insert(kind.to_string()) {
        tracing::info!("access provider type {kind:?} is not known; using {:?}, the only registered type", only.kind);
    }
    Some(only.kind)
}

/// Builds a provider client for a configured provider and its saved session token.
pub fn build_provider(cfg: &ProviderConfig, token: Option<String>) -> AccessResult<Box<dyn AccessProvider>> {
    match resolve_kind(&cfg.kind) {
        Some(access_api::KIND) => Ok(Box::new(access_api::AccessApiProvider::new(&cfg.base_url, token)?)),
        _ => Err(crate::AccessError::Unsupported(format!("access provider type \"{}\"", cfg.kind))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_kinds_fall_back_to_the_only_kind() {
        assert_eq!(resolve_kind(access_api::KIND), Some(access_api::KIND));
        let expected = if provider_kinds().len() == 1 { Some(provider_kinds()[0].kind) } else { None };
        assert_eq!(resolve_kind("some-older-name"), expected);
        assert_eq!(resolve_kind(""), expected);
    }
}
