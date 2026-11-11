//! Provider implementations and the registry keyed by provider kind. Adding a
//! provider = one module implementing [`AccessProvider`] + one entry below.

pub mod passhub;

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
    vec![ProviderKindInfo { kind: passhub::KIND, label: "passhub", default_name: "passhub" }]
}

/// Builds a provider client for a configured provider and its saved session token.
pub fn build_provider(cfg: &ProviderConfig, token: Option<String>) -> AccessResult<Box<dyn AccessProvider>> {
    match cfg.kind.as_str() {
        passhub::KIND => Ok(Box::new(passhub::PasshubProvider::new(&cfg.base_url, token)?)),
        other => Err(crate::AccessError::Unsupported(format!("access provider type \"{other}\""))),
    }
}
