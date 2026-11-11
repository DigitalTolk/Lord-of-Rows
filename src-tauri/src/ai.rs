//! IPC for the optional AI assistant (disabled by default).
//!
//! Flow: `ai_preview` builds the exact, redacted prompt from what the user
//! chose and returns it with a token bound to (endpoint, task, prompt).
//! `ai_send` only transmits a prompt whose token verifies, so the webview can
//! never send text the user did not see. The answer is returned as text;
//! nothing is executed.

use std::time::{Duration, Instant};

use dbs_ai::{AiSettings, Prompt, PromptInput, ProviderKind, TableContext, Task};
use dbs_audit::{Category, Outcome};
use dbs_core::*;
use dbs_secrets::SecretKind;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::{audit, check_len, engine_name};
use crate::state::AppState;

type R<T> = Result<T, DbError>;

const TIMEOUT: Duration = Duration::from_secs(180);

pub(crate) fn ai_settings(st: &AppState) -> AiSettings {
    AiSettings::from_lookup(|k| st.store.get_setting(k).ok().flatten())
}

#[derive(Serialize)]
pub struct AiStatus {
    settings: AiSettings,
    /// Whether a key is saved for the selected provider. The key itself never leaves Rust.
    has_api_key: bool,
}

#[tauri::command]
pub fn ai_status(st: State<'_, AppState>) -> R<AiStatus> {
    let settings = ai_settings(&st);
    let has_api_key = st.secrets.get(settings.provider.secret_owner(), SecretKind::AiApiKey)?.is_some();
    Ok(AiStatus { settings, has_api_key })
}

/// Save (non-empty) or delete (empty) the API key for a provider in the OS keychain.
#[tauri::command]
pub fn ai_set_api_key(st: State<'_, AppState>, provider: ProviderKind, key: String) -> R<()> {
    check_len(&key, 4096, "API key")?;
    let key = key.trim();
    if key.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(DbError::invalid("API key must not contain spaces or control characters"));
    }
    if key.is_empty() {
        st.secrets.delete(provider.secret_owner(), SecretKind::AiApiKey)?;
        audit(&st, Category::CredentialDeleted, Outcome::Success, None, |e| e.detail = Some(format!("ai api key ({})", provider.as_str())));
    } else {
        st.secrets.set(provider.secret_owner(), SecretKind::AiApiKey, key)?;
        audit(&st, Category::CredentialChanged, Outcome::Success, None, |e| e.detail = Some(format!("ai api key ({})", provider.as_str())));
    }
    Ok(())
}

/// Called by `set_setting` for `ai.*` keys: validates, and drops the
/// OpenAI-compatible key when its endpoint changes so a saved key is never
/// sent to a server it was not entered for.
pub(crate) fn on_setting_change(st: &AppState, key: &str, value: &serde_json::Value) -> R<()> {
    dbs_ai::validate_setting(key, value)?;
    if key == dbs_ai::KEY_BASE_URL {
        let old = st.store.get_setting(key).ok().flatten();
        let norm = |v: Option<&serde_json::Value>| v.and_then(|v| v.as_str()).unwrap_or("").trim().trim_end_matches('/').to_string();
        if norm(old.as_ref()) != norm(Some(value)) && st.secrets.get(dbs_ai::OPENAI_SECRET_OWNER, SecretKind::AiApiKey)?.is_some() {
            st.secrets.delete(dbs_ai::OPENAI_SECRET_OWNER, SecretKind::AiApiKey)?;
            audit(st, Category::CredentialDeleted, Outcome::Success, None, |e| e.detail = Some("ai api key (openai_compatible): base URL changed".into()));
        }
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct AiPreviewReq {
    task: Task,
    input: String,
    /// SQL to accompany an error/plan — only when the user ticked it.
    #[serde(default)]
    sql: Option<String>,
    /// Session used for the opt-in context below.
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    include_dialect: bool,
    /// Tables whose column definitions the user chose to include.
    #[serde(default)]
    tables: Vec<TableTarget>,
}

#[derive(Serialize)]
pub struct AiPreview {
    token: String,
    task: Task,
    system: String,
    user: String,
    /// Exactly what will be transmitted (system + user).
    text: String,
    bytes: usize,
    provider: ProviderKind,
    model: String,
    base_url: String,
}

fn table_context(d: &TableDescription) -> TableContext {
    let name = match &d.object.schema {
        Some(s) => format!("{s}.{}", d.object.name),
        None => d.object.name.clone(),
    };
    TableContext {
        name,
        columns: d
            .columns
            .iter()
            .map(|c| dbs_ai::ColumnContext {
                name: c.name.clone(),
                data_type: c.data_type.clone(),
                nullable: c.nullable,
                primary_key: c.is_primary_key || d.primary_key.contains(&c.name),
            })
            .collect(),
        indexes: d
            .indexes
            .iter()
            .filter(|i| !i.primary)
            .map(|i| format!("{} ({}){}", i.name, i.columns.join(", "), if i.unique { " unique" } else { "" }))
            .collect(),
        foreign_keys: d
            .foreign_keys
            .iter()
            .map(|f| {
                let rt = match &f.ref_schema {
                    Some(s) => format!("{s}.{}", f.ref_table),
                    None => f.ref_table.clone(),
                };
                format!("({}) -> {rt}({})", f.columns.join(", "), f.ref_columns.join(", "))
            })
            .collect(),
    }
}

#[tauri::command]
pub async fn ai_preview(st: State<'_, AppState>, req: AiPreviewReq) -> R<AiPreview> {
    let settings = ai_settings(&st);
    settings.ensure_enabled()?;
    let endpoint = settings.endpoint()?;
    check_len(&req.input, dbs_ai::MAX_PROMPT_BYTES, "input")?;
    check_len(req.sql.as_deref().unwrap_or(""), dbs_ai::MAX_PROMPT_BYTES, "SQL")?;
    if req.tables.len() > dbs_ai::MAX_TABLES {
        return Err(DbError::invalid(format!("Select at most {} tables", dbs_ai::MAX_TABLES)));
    }
    let session = match (&req.session_id, req.include_dialect || !req.tables.is_empty()) {
        (Some(id), true) => Some(st.session(id)?),
        (None, true) => return Err(DbError::invalid("Connect to a database to include schema context")),
        _ => None,
    };
    let mut tables = Vec::with_capacity(req.tables.len());
    if let Some(s) = &session {
        for t in &req.tables {
            tables.push(table_context(&s.conn.describe_table(t).await?));
        }
    }
    let input = PromptInput {
        task: req.task,
        input: req.input,
        sql: req.sql,
        dialect: session.as_ref().filter(|_| req.include_dialect).map(|s| engine_name(s.config.engine)),
        tables,
        redact_literals: settings.redact_literals,
    };
    let prompt = dbs_ai::build_prompt(&input)?;
    Ok(AiPreview {
        token: st.ai_guard.token(&endpoint, req.task, &prompt),
        task: req.task,
        text: prompt.preview_text(),
        bytes: prompt.byte_len(),
        system: prompt.system,
        user: prompt.user,
        provider: endpoint.kind,
        model: endpoint.model,
        base_url: endpoint.base_url,
    })
}

#[derive(Deserialize)]
pub struct AiSendReq {
    token: String,
    task: Task,
    system: String,
    user: String,
}

#[derive(Serialize)]
pub struct AiAnswer {
    text: String,
    /// SQL extracted from the answer. Only ever inserted into the editor by the user; never executed here.
    sql: Option<String>,
    truncated: bool,
    provider: ProviderKind,
    model: String,
    duration_ms: u64,
}

async fn transmit(st: &AppState, settings: &AiSettings, task: &str, prompt: &Prompt) -> R<(dbs_ai::Answer, u64)> {
    let endpoint = settings.endpoint()?;
    let key = st.secrets.get(endpoint.kind.secret_owner(), SecretKind::AiApiKey)?;
    let t = Instant::now();
    let res = dbs_ai::send(&endpoint, key.as_ref().map(|k| k.expose()), prompt, TIMEOUT).await;
    drop(key);
    let ms = t.elapsed().as_millis() as u64;
    // Metadata only: never the prompt or the answer.
    audit(st, Category::AiRequest, if res.is_ok() { Outcome::Success } else { Outcome::Failure }, None, |e| {
        e.duration_ms = Some(ms);
        e.error_kind = res.as_ref().err().map(|e| e.kind);
        e.detail = Some(format!("provider={} model={} task={task} bytes={}", endpoint.kind.as_str(), endpoint.model, prompt.byte_len()));
    });
    Ok((res?, ms))
}

#[tauri::command]
pub async fn ai_send(st: State<'_, AppState>, req: AiSendReq) -> R<AiAnswer> {
    let settings = ai_settings(&st);
    settings.ensure_enabled()?;
    let endpoint = settings.endpoint()?;
    check_len(&req.token, 128, "token")?;
    let prompt = Prompt { system: req.system, user: req.user };
    if !st.ai_guard.verify(&endpoint, req.task, &prompt, &req.token) {
        return Err(DbError::new(
            ErrorKind::ConfirmationRequired,
            "This prompt was not approved in a preview, or the AI settings changed since. Preview it again.",
        ));
    }
    let (a, ms) = transmit(&st, &settings, req.task.as_str(), &prompt).await?;
    Ok(AiAnswer { text: a.text, sql: a.sql, truncated: a.truncated, provider: endpoint.kind, model: endpoint.model, duration_ms: ms })
}

/// "Test connection": sends a fixed prompt containing no user data.
#[tauri::command]
pub async fn ai_test(st: State<'_, AppState>) -> R<AiAnswer> {
    let settings = ai_settings(&st);
    settings.ensure_enabled()?;
    let endpoint = settings.endpoint()?;
    let prompt = Prompt { system: "You are a connectivity check.".into(), user: "Reply with the single word OK.".into() };
    let (a, ms) = transmit(&st, &settings, "connection_test", &prompt).await?;
    Ok(AiAnswer { text: a.text, sql: None, truncated: a.truncated, provider: endpoint.kind, model: endpoint.model, duration_ms: ms })
}
