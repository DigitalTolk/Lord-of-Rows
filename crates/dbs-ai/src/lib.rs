//! Optional AI assistant. **Disabled by default.**
//!
//! Privacy model (see docs/AI_ASSISTANT.md):
//! - Nothing is sent unless `ai.enabled` is true *and* the user approved an
//!   exact prompt shown in a preview. The preview is bound to the prompt text
//!   and the provider endpoint by a keyed hash ([`PromptGuard`]), so the UI
//!   cannot send different text than it previewed.
//! - Default context is only the text the user is acting on. Table column
//!   definitions are added only when the user ticks them; table data is never
//!   included.
//! - Secrets are redacted (`password=…`, URL userinfo, `PASSWORD '…'`) and,
//!   by default, string/number literals are replaced with `?`.
//! - Network calls happen here, in Rust, never in the webview.

mod prompt;
mod provider;
mod redact;

use dbs_core::{DbError, DbResult, ErrorKind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub use prompt::{build_prompt, ColumnContext, Prompt, PromptInput, TableContext, MAX_PROMPT_BYTES, MAX_TABLES};
pub use provider::{extract_sql, send, Answer, Endpoint};
pub use redact::{redact_free_text, redact_quoted_values, redact_sql};

pub const KEY_ENABLED: &str = "ai.enabled";
pub const KEY_PROVIDER: &str = "ai.provider";
pub const KEY_MODEL: &str = "ai.model";
pub const KEY_BASE_URL: &str = "ai.baseUrl";
pub const KEY_REDACT_LITERALS: &str = "ai.redactLiterals";

pub const ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
pub const DEFAULT_ANTHROPIC_MODEL: &str = "claude-opus-5-5";
pub const DEFAULT_OPENAI_BASE_URL: &str = "http://localhost:11434/v1";
pub const DEFAULT_OPENAI_MODEL: &str = "llama3.1";

/// Keychain owners for the API keys (one per provider, so switching provider
/// never sends one vendor's key to another endpoint).
pub const ANTHROPIC_SECRET_OWNER: Uuid = Uuid::from_u128(0x6462_7374_7564_696f_a100_0000_0000_0001);
pub const OPENAI_SECRET_OWNER: Uuid = Uuid::from_u128(0x6462_7374_7564_696f_a100_0000_0000_0002);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    #[default]
    Anthropic,
    OpenaiCompatible,
}

impl ProviderKind {
    pub fn secret_owner(self) -> Uuid {
        match self {
            ProviderKind::Anthropic => ANTHROPIC_SECRET_OWNER,
            ProviderKind::OpenaiCompatible => OPENAI_SECRET_OWNER,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderKind::Anthropic => "anthropic",
            ProviderKind::OpenaiCompatible => "openai_compatible",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Task {
    ExplainSql,
    GenerateSql,
    OptimizeSql,
    ExplainError,
    ExplainPlan,
    SuggestIndexes,
    SummarizeSchema,
}

impl Task {
    pub fn as_str(self) -> &'static str {
        match self {
            Task::ExplainSql => "explain_sql",
            Task::GenerateSql => "generate_sql",
            Task::OptimizeSql => "optimize_sql",
            Task::ExplainError => "explain_error",
            Task::ExplainPlan => "explain_plan",
            Task::SuggestIndexes => "suggest_indexes",
            Task::SummarizeSchema => "summarize_schema",
        }
    }
}

/// AI settings as stored in the app settings table. Every default is the
/// private one: disabled, literals redacted.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AiSettings {
    pub enabled: bool,
    pub provider: ProviderKind,
    pub model: String,
    pub base_url: String,
    pub redact_literals: bool,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self::from_lookup(|_| None)
    }
}

impl AiSettings {
    pub fn from_lookup(get: impl Fn(&str) -> Option<serde_json::Value>) -> Self {
        let s = |k: &str| get(k).and_then(|v| v.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty());
        let provider = get(KEY_PROVIDER).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        let (def_model, def_base) = match provider {
            ProviderKind::Anthropic => (DEFAULT_ANTHROPIC_MODEL, ANTHROPIC_BASE_URL),
            ProviderKind::OpenaiCompatible => (DEFAULT_OPENAI_MODEL, DEFAULT_OPENAI_BASE_URL),
        };
        AiSettings {
            enabled: get(KEY_ENABLED).and_then(|v| v.as_bool()).unwrap_or(false),
            provider,
            model: s(KEY_MODEL).unwrap_or_else(|| def_model.into()),
            // The Anthropic endpoint is fixed; only OpenAI-compatible servers are configurable.
            base_url: match provider {
                ProviderKind::Anthropic => def_base.into(),
                ProviderKind::OpenaiCompatible => s(KEY_BASE_URL).unwrap_or_else(|| def_base.into()),
            },
            redact_literals: get(KEY_REDACT_LITERALS).and_then(|v| v.as_bool()).unwrap_or(true),
        }
    }

    /// Refuse every AI operation unless the user turned the assistant on.
    pub fn ensure_enabled(&self) -> DbResult<()> {
        if !self.enabled {
            return Err(DbError::new(ErrorKind::Permission, "The AI assistant is disabled. Enable it in Settings → AI."));
        }
        Ok(())
    }

    pub fn endpoint(&self) -> DbResult<Endpoint> {
        validate_base_url(&self.base_url)?;
        Ok(Endpoint { kind: self.provider, model: self.model.clone(), base_url: self.base_url.trim_end_matches('/').to_string() })
    }
}

/// `https://` anywhere; plain `http://` only to this machine (e.g. Ollama), so
/// API keys and prompts never cross the network unencrypted.
pub fn validate_base_url(s: &str) -> DbResult<url::Url> {
    let u = url::Url::parse(s.trim()).map_err(|_| DbError::invalid("AI base URL is not a valid URL"))?;
    if !u.username().is_empty() || u.password().is_some() {
        return Err(DbError::invalid("AI base URL must not contain credentials; save the API key separately"));
    }
    if u.query().is_some() || u.fragment().is_some() {
        return Err(DbError::invalid("AI base URL must not contain a query or fragment"));
    }
    match u.scheme() {
        "https" => Ok(u),
        "http" => {
            let local = match u.host() {
                Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
                Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                None => false,
            };
            if local {
                Ok(u)
            } else {
                Err(DbError::invalid("AI base URL must use https:// (plain http:// is only allowed for localhost)"))
            }
        }
        _ => Err(DbError::invalid("AI base URL must use https://")),
    }
}

/// Validate an `ai.*` setting value before it is stored.
pub fn validate_setting(key: &str, value: &serde_json::Value) -> DbResult<()> {
    let bad = || DbError::invalid(format!("invalid value for {key}"));
    match key {
        KEY_ENABLED | KEY_REDACT_LITERALS => value.as_bool().map(|_| ()).ok_or_else(bad),
        KEY_PROVIDER => serde_json::from_value::<ProviderKind>(value.clone()).map(|_| ()).map_err(|_| bad()),
        KEY_MODEL => match value.as_str() {
            Some(m) if m.len() <= 200 && m.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:/@".contains(c)) => Ok(()),
            _ => Err(DbError::invalid("model name may only contain letters, digits and - _ . : / @")),
        },
        KEY_BASE_URL => match value.as_str() {
            Some("") => Ok(()),
            Some(u) => validate_base_url(u).map(|_| ()),
            None => Err(bad()),
        },
        _ => Err(DbError::invalid("unknown AI setting")),
    }
}

/// Binds an approved preview to the exact prompt and endpoint, like
/// `dbs_safety::ConfirmationGuard` does for SQL confirmations.
pub struct PromptGuard {
    key: [u8; 32],
}

impl PromptGuard {
    pub fn new(key: [u8; 32]) -> Self {
        Self { key }
    }

    pub fn token(&self, endpoint: &Endpoint, task: Task, prompt: &Prompt) -> String {
        let mut h = Sha256::new();
        h.update(self.key);
        for part in [endpoint.kind.as_str(), &endpoint.model, &endpoint.base_url, task.as_str(), &prompt.system, &prompt.user] {
            h.update((part.len() as u64).to_le_bytes());
            h.update(part.as_bytes());
        }
        hex::encode(h.finalize())
    }

    pub fn verify(&self, endpoint: &Endpoint, task: Task, prompt: &Prompt, token: &str) -> bool {
        let expected = self.token(endpoint, task, prompt);
        expected.len() == token.len() && expected.bytes().zip(token.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(pairs: &[(&str, serde_json::Value)]) -> AiSettings {
        AiSettings::from_lookup(|k| pairs.iter().find(|(kk, _)| *kk == k).map(|(_, v)| v.clone()))
    }

    #[test]
    fn disabled_by_default_and_refuses() {
        let s = AiSettings::default();
        assert!(!s.enabled);
        assert!(s.redact_literals);
        assert_eq!(s.provider, ProviderKind::Anthropic);
        assert_eq!(s.model, DEFAULT_ANTHROPIC_MODEL);
        let e = s.ensure_enabled().unwrap_err();
        assert_eq!(e.kind, ErrorKind::Permission);
        assert!(settings(&[(KEY_ENABLED, json!(false))]).ensure_enabled().is_err());
        assert!(settings(&[(KEY_ENABLED, json!("true"))]).ensure_enabled().is_err(), "only a real boolean enables");
        assert!(settings(&[(KEY_ENABLED, json!(true))]).ensure_enabled().is_ok());
    }

    #[test]
    fn anthropic_base_url_is_fixed() {
        let s = settings(&[(KEY_BASE_URL, json!("https://evil.example"))]);
        assert_eq!(s.base_url, ANTHROPIC_BASE_URL);
        let s = settings(&[(KEY_PROVIDER, json!("openai_compatible"))]);
        assert_eq!(s.base_url, DEFAULT_OPENAI_BASE_URL);
        assert_eq!(s.model, DEFAULT_OPENAI_MODEL);
    }

    #[test]
    fn base_url_rules() {
        assert!(validate_base_url("http://localhost:11434/v1").is_ok());
        assert!(validate_base_url("http://127.0.0.1:8080/v1").is_ok());
        assert!(validate_base_url("http://[::1]:8080/v1").is_ok());
        assert!(validate_base_url("https://llm.internal.example/v1").is_ok());
        assert!(validate_base_url("http://llm.example.com/v1").is_err());
        assert!(validate_base_url("https://user:pw@llm.example.com/v1").is_err());
        assert!(validate_base_url("file:///etc/passwd").is_err());
        assert!(validate_base_url("https://x.example/v1?key=1").is_err());
    }

    #[test]
    fn setting_validation() {
        assert!(validate_setting(KEY_ENABLED, &json!(true)).is_ok());
        assert!(validate_setting(KEY_ENABLED, &json!("yes")).is_err());
        assert!(validate_setting(KEY_PROVIDER, &json!("openai_compatible")).is_ok());
        assert!(validate_setting(KEY_PROVIDER, &json!("other")).is_err());
        assert!(validate_setting(KEY_MODEL, &json!("claude-opus-5-5")).is_ok());
        assert!(validate_setting(KEY_MODEL, &json!("qwen2.5-coder:7b")).is_ok());
        assert!(validate_setting(KEY_MODEL, &json!("a b")).is_err());
        assert!(validate_setting(KEY_BASE_URL, &json!("http://example.com")).is_err());
        assert!(validate_setting("ai.apiKey", &json!("sk-123")).is_err(), "keys never go into settings");
    }

    #[test]
    fn guard_binds_prompt_task_and_endpoint() {
        let g = PromptGuard::new([3; 32]);
        let ep = Endpoint { kind: ProviderKind::Anthropic, model: "m".into(), base_url: ANTHROPIC_BASE_URL.into() };
        let p = Prompt { system: "sys".into(), user: "SELECT 1".into() };
        let t = g.token(&ep, Task::ExplainSql, &p);
        assert!(g.verify(&ep, Task::ExplainSql, &p, &t));
        let p2 = Prompt { system: "sys".into(), user: "SELECT * FROM secrets".into() };
        assert!(!g.verify(&ep, Task::ExplainSql, &p2, &t));
        assert!(!g.verify(&ep, Task::OptimizeSql, &p, &t));
        let ep2 = Endpoint { base_url: "https://other.example".into(), ..ep.clone() };
        assert!(!g.verify(&ep2, Task::ExplainSql, &p, &t));
        assert!(!PromptGuard::new([4; 32]).verify(&ep, Task::ExplainSql, &p, &t));
    }
}
