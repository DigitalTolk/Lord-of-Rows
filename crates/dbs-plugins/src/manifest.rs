//! `plugin.json`: identity, version, compatibility and the capabilities a
//! plugin asks for. Unknown fields and unknown capabilities are rejected so a
//! manifest can never smuggle in a permission the host does not understand.

use serde::{Deserialize, Serialize};

use crate::{PluginError, PluginResult};

/// The only host API version this build understands.
pub const API_VERSION: u32 = 1;

/// Everything a plugin can ever be allowed to do. There is deliberately no
/// capability for credentials, network, filesystem or running SQL: the host
/// API has no way to express them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    /// Transform SQL text the user asks it to format (export `format_sql`).
    FormatSql,
    /// Turn result rows into bytes for a custom export format (export `export_rows`).
    ExportFormat,
    /// Receive result rows the user explicitly passes (required with `export_format`).
    ReadQueryResults,
    /// Receive table/column names (export `describe_schema`).
    ReadSchema,
}

impl Capability {
    pub const ALL: [Capability; 4] = [Capability::FormatSql, Capability::ExportFormat, Capability::ReadQueryResults, Capability::ReadSchema];

    pub fn as_str(self) -> &'static str {
        match self {
            Capability::FormatSql => "format_sql",
            Capability::ExportFormat => "export_format",
            Capability::ReadQueryResults => "read_query_results",
            Capability::ReadSchema => "read_schema",
        }
    }

    /// The guest export that implements this capability, if it has one.
    pub fn export_name(self) -> Option<&'static str> {
        match self {
            Capability::FormatSql => Some("format_sql"),
            Capability::ExportFormat => Some("export_rows"),
            Capability::ReadQueryResults => None,
            Capability::ReadSchema => Some("describe_schema"),
        }
    }
}

impl std::fmt::Display for Capability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportInfo {
    /// Shown in the UI, e.g. "Markdown table".
    pub label: String,
    /// File extension without the dot, e.g. "md".
    pub extension: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingKind {
    Bool,
    String,
    Number,
}

/// A user-editable plugin setting. Values are passed to the guest's optional
/// `configure` export as JSON before each call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingSpec {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: SettingKind,
    pub default: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    /// Reverse-DNS identifier, e.g. `com.example.uppercase-keywords`.
    pub id: String,
    pub name: String,
    /// Semantic version of the plugin.
    pub version: String,
    #[serde(default = "default_api")]
    pub api_version: u32,
    /// Oldest DB Studio version the plugin works with (semver).
    pub min_app_version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    pub capabilities: Vec<Capability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export: Option<ExportInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub settings: Vec<SettingSpec>,
    /// Hex ed25519 public key (32 bytes) of the publisher. Optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
    /// Hex ed25519 signature (64 bytes) over [`crate::signing_message`]. Optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

fn default_api() -> u32 {
    API_VERSION
}

fn bad(msg: impl Into<String>) -> PluginError {
    PluginError::Manifest(msg.into())
}

pub fn valid_id(id: &str) -> bool {
    // Lowercase reverse-DNS with at least two labels; each label starts with a letter.
    id.len() <= 128
        && id.split('.').count() >= 2
        && id.split('.').all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && l.starts_with(|c: char| c.is_ascii_lowercase())
                && l.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        })
}

fn plain_text(s: &str, max: usize) -> bool {
    s.chars().count() <= max && !s.chars().any(|c| c.is_control() && c != '\n')
}

impl Manifest {
    pub fn parse(json: &[u8]) -> PluginResult<Manifest> {
        let m: Manifest = serde_json::from_slice(json).map_err(|e| bad(e.to_string()))?;
        m.validate()?;
        Ok(m)
    }

    pub fn semver(&self) -> semver::Version {
        semver::Version::parse(&self.version).expect("validated")
    }

    pub fn validate(&self) -> PluginResult<()> {
        if !valid_id(&self.id) {
            return Err(bad("id must be lowercase reverse-DNS, e.g. com.example.my-plugin"));
        }
        if self.name.trim().is_empty() || !plain_text(&self.name, 64) {
            return Err(bad("name must be 1-64 characters"));
        }
        semver::Version::parse(&self.version).map_err(|e| bad(format!("version is not semver: {e}")))?;
        semver::Version::parse(&self.min_app_version).map_err(|e| bad(format!("min_app_version is not semver: {e}")))?;
        if self.api_version != API_VERSION {
            return Err(PluginError::Incompatible(format!("plugin API version {} is not supported (this app supports {API_VERSION})", self.api_version)));
        }
        if !plain_text(&self.description, 1000) || !plain_text(&self.author, 200) {
            return Err(bad("description or author is too long"));
        }
        if self.capabilities.is_empty() {
            return Err(bad("at least one capability is required"));
        }
        let mut caps = self.capabilities.clone();
        caps.sort();
        caps.dedup();
        if caps.len() != self.capabilities.len() {
            return Err(bad("duplicate capability"));
        }
        let exports = self.has(Capability::ExportFormat);
        if exports && !self.has(Capability::ReadQueryResults) {
            return Err(bad("export_format requires read_query_results (the exporter receives result rows)"));
        }
        match (&self.export, exports) {
            (Some(e), true) => {
                if e.label.trim().is_empty() || !plain_text(&e.label, 64) {
                    return Err(bad("export.label must be 1-64 characters"));
                }
                if e.extension.is_empty() || e.extension.len() > 10 || !e.extension.chars().all(|c| c.is_ascii_alphanumeric()) {
                    return Err(bad("export.extension must be 1-10 alphanumeric characters"));
                }
            }
            (None, true) => return Err(bad("export_format requires an `export` section")),
            (Some(_), false) => return Err(bad("`export` section requires the export_format capability")),
            (None, false) => {}
        }
        if self.settings.len() > 16 {
            return Err(bad("too many settings (max 16)"));
        }
        for (i, s) in self.settings.iter().enumerate() {
            if s.key.is_empty() || s.key.len() > 32 || !s.key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
                return Err(bad("setting keys must be 1-32 chars of [a-z0-9_]"));
            }
            if self.settings[..i].iter().any(|o| o.key == s.key) {
                return Err(bad("duplicate setting key"));
            }
            if s.label.trim().is_empty() || !plain_text(&s.label, 64) {
                return Err(bad("setting label must be 1-64 characters"));
            }
            if !kind_matches(s.kind, &s.default) {
                return Err(bad(format!("default for setting '{}' does not match its type", s.key)));
            }
        }
        match (&self.public_key, &self.signature) {
            (Some(_), None) | (None, Some(_)) => Err(bad("public_key and signature must be given together")),
            _ => Ok(()),
        }
    }

    pub fn has(&self, c: Capability) -> bool {
        self.capabilities.contains(&c)
    }

    /// Fails unless `app_version` is at least `min_app_version`.
    pub fn check_compatible(&self, app_version: &str) -> PluginResult<()> {
        let app = semver::Version::parse(app_version).map_err(|e| PluginError::Incompatible(e.to_string()))?;
        let min = semver::Version::parse(&self.min_app_version).map_err(|e| bad(e.to_string()))?;
        // Compare without pre-release tags so 0.2.0-dev satisfies min 0.2.0.
        if (app.major, app.minor, app.patch) < (min.major, min.minor, min.patch) {
            return Err(PluginError::Incompatible(format!("requires DB Studio {} or newer (this is {app_version})", self.min_app_version)));
        }
        Ok(())
    }

    /// Validates user-supplied setting values against the declared settings,
    /// filling in defaults. Unknown keys are rejected.
    pub fn resolve_settings(&self, values: &serde_json::Value) -> PluginResult<serde_json::Map<String, serde_json::Value>> {
        let empty = serde_json::Map::new();
        let given = match values {
            serde_json::Value::Null => &empty,
            serde_json::Value::Object(m) => m,
            _ => return Err(bad("settings must be an object")),
        };
        if let Some(k) = given.keys().find(|k| !self.settings.iter().any(|s| &s.key == *k)) {
            return Err(bad(format!("unknown setting '{k}'")));
        }
        let mut out = serde_json::Map::new();
        for s in &self.settings {
            let v = given.get(&s.key).cloned().unwrap_or_else(|| s.default.clone());
            if !kind_matches(s.kind, &v) {
                return Err(bad(format!("setting '{}' has the wrong type", s.key)));
            }
            if v.as_str().is_some_and(|x| x.len() > 4096) {
                return Err(bad(format!("setting '{}' is too long", s.key)));
            }
            out.insert(s.key.clone(), v);
        }
        Ok(out)
    }
}

fn kind_matches(k: SettingKind, v: &serde_json::Value) -> bool {
    match k {
        SettingKind::Bool => v.is_boolean(),
        SettingKind::String => v.is_string(),
        SettingKind::Number => v.is_number(),
    }
}
