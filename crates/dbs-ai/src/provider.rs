//! Provider clients: Anthropic Messages API and OpenAI-compatible chat
//! completions (OpenAI, Ollama, LM Studio, vLLM, …). The API key is sent only
//! in the authentication header; redirects are never followed.

use std::time::Duration;

use dbs_core::{DbError, DbResult, ErrorKind};
use serde::Serialize;
use serde_json::{json, Value};

use crate::{Prompt, ProviderKind};

pub const ANTHROPIC_VERSION: &str = "2026-10-21";
const MAX_TOKENS: u32 = 16_000;
/// Models that accept server-side refusal fallbacks.
const FALLBACK_MODELS: &[&str] = &["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"];
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Endpoint {
    pub kind: ProviderKind,
    pub model: String,
    /// Without trailing slash. Anthropic: `https://api.anthropic.com`; OpenAI-compatible: up to and including `/v1`.
    pub base_url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Answer {
    pub text: String,
    /// First fenced SQL block in the answer, for "Insert into editor". Never executed by the app.
    pub sql: Option<String>,
    /// True when the answer was cut off by the output limit.
    pub truncated: bool,
}

fn provider_name(k: ProviderKind) -> &'static str {
    match k {
        ProviderKind::Anthropic => "Anthropic",
        ProviderKind::OpenaiCompatible => "the AI endpoint",
    }
}

/// Send an approved prompt. `api_key` is optional only for OpenAI-compatible
/// local servers.
pub async fn send(ep: &Endpoint, api_key: Option<&str>, prompt: &Prompt, timeout: Duration) -> DbResult<Answer> {
    if ep.model.trim().is_empty() {
        return Err(DbError::invalid("Set a model in Settings → AI"));
    }
    let api_key = api_key.filter(|k| !k.is_empty());
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("DBStudio/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| DbError::internal(format!("HTTP client: {e}")))?;
    let (url, body, req) = match ep.kind {
        ProviderKind::Anthropic => {
            let key = api_key.ok_or_else(|| DbError::new(ErrorKind::Authentication, "No Anthropic API key saved. Add one in Settings → AI."))?;
            let url = format!("{}/v1/messages", ep.base_url);
            let mut body = json!({
                "model": ep.model,
                "max_tokens": MAX_TOKENS,
                "system": prompt.system,
                "messages": [{ "role": "user", "content": prompt.user }],
            });
            let mut req = client.post(&url).header("x-api-key", key).header("anthropic-version", ANTHROPIC_VERSION);
            if FALLBACK_MODELS.contains(&ep.model.as_str()) {
                // If the model declines on a safety classifier, let the API retry on a fallback model.
                body["fallbacks"] = json!("default");
                req = req.header("anthropic-beta", FALLBACK_BETA);
            }
            (url, body, req)
        }
        ProviderKind::OpenaiCompatible => {
            let url = format!("{}/chat/completions", ep.base_url);
            let body = json!({
                "model": ep.model,
                "messages": [
                    { "role": "system", "content": prompt.system },
                    { "role": "user", "content": prompt.user },
                ],
            });
            let mut req = client.post(&url);
            if let Some(k) = api_key {
                req = req.header("authorization", format!("Bearer {k}"));
            }
            (url, body, req)
        }
    };
    let bytes = serde_json::to_vec(&body).map_err(|e| DbError::internal(e.to_string()))?;
    let resp = req.header("content-type", "application/json").body(bytes).send().await.map_err(|e| network_error(ep, &url, e))?;
    let status = resp.status();
    let raw = resp.bytes().await.map_err(|e| network_error(ep, &url, e))?;
    let v: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(http_error(ep, status.as_u16(), &v));
    }
    let (text, truncated) = match ep.kind {
        ProviderKind::Anthropic => parse_anthropic(&v)?,
        ProviderKind::OpenaiCompatible => parse_openai(&v)?,
    };
    Ok(Answer { sql: extract_sql(&text), text, truncated })
}

fn parse_anthropic(v: &Value) -> DbResult<(String, bool)> {
    let stop = v["stop_reason"].as_str().unwrap_or_default();
    if stop == "refusal" {
        let why = v["stop_details"]["explanation"].as_str().unwrap_or("no reason given");
        return Err(DbError::new(ErrorKind::PolicyBlocked, format!("The model declined this request ({why}).")));
    }
    let text: Vec<&str> = v["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
    if text.is_empty() {
        return Err(DbError::internal("The AI response contained no text"));
    }
    Ok((text.join("\n"), stop == "max_tokens"))
}

fn parse_openai(v: &Value) -> DbResult<(String, bool)> {
    let choice = &v["choices"][0];
    let text = choice["message"]["content"].as_str().filter(|s| !s.is_empty()).ok_or_else(|| DbError::internal("The AI response contained no text"))?;
    Ok((text.to_string(), choice["finish_reason"] == "length"))
}

fn network_error(ep: &Endpoint, url: &str, e: reqwest::Error) -> DbError {
    let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
    if e.is_timeout() {
        DbError::new(ErrorKind::Timeout, format!("{} did not answer in time ({host})", provider_name(ep.kind)))
    } else if e.is_connect() {
        DbError::new(ErrorKind::Connection, format!("Could not reach {} at {host}. Check the URL and that the server is running.", provider_name(ep.kind)))
    } else {
        DbError::new(ErrorKind::Connection, format!("Request to {} failed: {e}", provider_name(ep.kind)))
    }
}

fn http_error(ep: &Endpoint, status: u16, body: &Value) -> DbError {
    let detail: String =
        body["error"]["message"].as_str().or_else(|| body["error"].as_str()).or_else(|| body["message"].as_str()).unwrap_or("").chars().take(500).collect();
    let detail = if detail.is_empty() { String::new() } else { format!(": {detail}") };
    let who = provider_name(ep.kind);
    match status {
        401 | 403 => DbError::new(ErrorKind::Authentication, format!("{who} rejected the API key (HTTP {status}){detail}")),
        404 => DbError::new(ErrorKind::NotFound, format!("{who}: model \"{}\" or endpoint not found (HTTP 404){detail}", ep.model)),
        429 => DbError::new(ErrorKind::Connection, format!("{who} rate limit reached (HTTP 429); try again later{detail}")),
        300..=399 => {
            DbError::new(ErrorKind::Connection, format!("{who} answered with a redirect (HTTP {status}); redirects are not followed. Check the base URL."))
        }
        _ => DbError::new(ErrorKind::Connection, format!("{who} returned HTTP {status}{detail}")),
    }
}

/// First ```sql block (or the first unlabeled ``` block) in the answer.
pub fn extract_sql(text: &str) -> Option<String> {
    let blocks: Vec<(String, String)> = {
        let mut out = vec![];
        let mut rest = text;
        while let Some(start) = rest.find("```") {
            let after = &rest[start + 3..];
            let nl = after.find('\n')?;
            let lang = after[..nl].trim().to_ascii_lowercase();
            let body = &after[nl + 1..];
            let Some(end) = body.find("```") else { break };
            out.push((lang, body[..end].trim().to_string()));
            rest = &body[end + 3..];
        }
        out
    };
    blocks
        .iter()
        .find(|(l, b)| (l == "sql" || l.ends_with("sql")) && !b.is_empty())
        .or_else(|| blocks.iter().find(|(l, b)| l.is_empty() && !b.is_empty()))
        .map(|(_, b)| b.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Tiny one-shot HTTP server: records the raw request, replies with `status` + `body`.
    async fn mock(status: &'static str, body: &'static str) -> (String, Arc<Mutex<String>>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(String::new()));
        let s2 = seen.clone();
        tokio::spawn(async move {
            let (mut sock, _) = l.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                let n = sock.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some(h) = text.find("\r\n\r\n") {
                    let len = text[..h]
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if buf.len() >= h + 4 + len {
                        break;
                    }
                }
            }
            *s2.lock().unwrap() = String::from_utf8_lossy(&buf).to_string();
            let resp = format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nlocation: http://127.0.0.1:1/x\r\nconnection: close\r\n\r\n{body}", body.len());
            sock.write_all(resp.as_bytes()).await.unwrap();
            sock.shutdown().await.ok();
        });
        (format!("http://{addr}"), seen)
    }

    fn prompt() -> Prompt {
        Prompt { system: "SYS".into(), user: "Task: Explain this SQL.\nSELECT 1".into() }
    }

    fn split(raw: &str) -> (String, String) {
        let (h, b) = raw.split_once("\r\n\r\n").unwrap();
        (h.to_ascii_lowercase(), b.to_string())
    }

    #[tokio::test]
    async fn openai_compatible_request_shape_and_key_only_in_header() {
        let (base, seen) =
            mock("200 OK", r#"{"choices":[{"message":{"role":"assistant","content":"Here:\n```sql\nSELECT 2;\n```"},"finish_reason":"stop"}]}"#).await;
        let ep = Endpoint { kind: ProviderKind::OpenaiCompatible, model: "llama3.1".into(), base_url: format!("{base}/v1") };
        let a = send(&ep, Some("sk-test-SECRET"), &prompt(), Duration::from_secs(5)).await.unwrap();
        assert_eq!(a.sql.as_deref(), Some("SELECT 2;"));
        assert!(!a.truncated);
        let raw = seen.lock().unwrap().clone();
        let (head, body) = split(&raw);
        assert!(head.starts_with("post /v1/chat/completions http/1.1"), "{head}");
        assert!(head.contains("authorization: bearer sk-test-secret"), "{head}");
        assert_eq!(raw.matches("sk-test-SECRET").count(), 1, "key appears once, in the header only");
        assert!(!body.contains("sk-test"));
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["model"], "llama3.1");
        assert_eq!(v["messages"][0]["role"], "system");
        assert_eq!(v["messages"][0]["content"], "SYS");
        assert_eq!(v["messages"][1]["content"], prompt().user);
        assert_eq!(v.as_object().unwrap().len(), 2, "no extra fields: {v}");
    }

    #[tokio::test]
    async fn openai_compatible_without_key_sends_no_auth_header() {
        let (base, seen) = mock("200 OK", r#"{"choices":[{"message":{"content":"ok"},"finish_reason":"length"}]}"#).await;
        let ep = Endpoint { kind: ProviderKind::OpenaiCompatible, model: "m".into(), base_url: base };
        let a = send(&ep, None, &prompt(), Duration::from_secs(5)).await.unwrap();
        assert!(a.truncated && a.sql.is_none());
        assert!(!seen.lock().unwrap().to_ascii_lowercase().contains("authorization:"));
    }

    #[tokio::test]
    async fn anthropic_request_shape() {
        let (base, seen) =
            mock("200 OK", r#"{"content":[{"type":"thinking","thinking":""},{"type":"text","text":"It selects one."}],"stop_reason":"end_turn"}"#).await;
        let ep = Endpoint { kind: ProviderKind::Anthropic, model: "claude-opus-5-5".into(), base_url: base };
        let a = send(&ep, Some("sk-ant-SECRET"), &prompt(), Duration::from_secs(5)).await.unwrap();
        assert_eq!(a.text, "It selects one.");
        let raw = seen.lock().unwrap().clone();
        let (head, body) = split(&raw);
        assert!(head.starts_with("post /v1/messages http/1.1"), "{head}");
        assert!(head.contains("x-api-key: sk-ant-secret"));
        assert!(head.contains(&format!("anthropic-version: {ANTHROPIC_VERSION}")));
        assert!(head.contains(&format!("anthropic-beta: {FALLBACK_BETA}")));
        assert_eq!(raw.matches("sk-ant-SECRET").count(), 1);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["model"], "claude-opus-5-5");
        assert_eq!(v["system"], "SYS");
        assert_eq!(v["messages"][0]["role"], "user");
        assert_eq!(v["messages"][0]["content"], prompt().user);
        assert!(v.get("temperature").is_none());
    }

    #[tokio::test]
    async fn anthropic_requires_key_and_maps_errors() {
        let ep = Endpoint { kind: ProviderKind::Anthropic, model: "claude-opus-5-5".into(), base_url: "http://127.0.0.1:1".into() };
        let e = send(&ep, None, &prompt(), Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Authentication);

        let (base, _) = mock("401 Unauthorized", r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#).await;
        let ep = Endpoint { base_url: base, ..ep };
        let e = send(&ep, Some("bad"), &prompt(), Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Authentication);
        assert!(e.message.contains("invalid x-api-key"), "{}", e.message);

        let (base, _) =
            mock("200 OK", r#"{"content":[],"stop_reason":"refusal","stop_details":{"type":"refusal","category":"cyber","explanation":"policy"}}"#).await;
        let ep = Endpoint { base_url: base, ..ep };
        let e = send(&ep, Some("k"), &prompt(), Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(e.kind, ErrorKind::PolicyBlocked);
    }

    #[tokio::test]
    async fn redirects_are_not_followed() {
        let (base, _) = mock("302 Found", "{}").await;
        let ep = Endpoint { kind: ProviderKind::OpenaiCompatible, model: "m".into(), base_url: base };
        let e = send(&ep, Some("k"), &prompt(), Duration::from_secs(5)).await.unwrap_err();
        assert!(e.message.contains("redirect"), "{}", e.message);
    }

    #[tokio::test]
    async fn unreachable_server_is_a_clear_error() {
        let ep = Endpoint { kind: ProviderKind::OpenaiCompatible, model: "m".into(), base_url: "http://127.0.0.1:1/v1".into() };
        let e = send(&ep, None, &prompt(), Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Connection);
        assert!(e.message.contains("127.0.0.1"), "{}", e.message);
    }

    #[test]
    fn sql_extraction() {
        assert_eq!(extract_sql("a\n```sql\nSELECT 1;\n```\nb").as_deref(), Some("SELECT 1;"));
        assert_eq!(extract_sql("```text\nhi\n```\n```postgresql\nSELECT 2\n```").as_deref(), Some("SELECT 2"));
        assert_eq!(extract_sql("```\nSELECT 3\n```").as_deref(), Some("SELECT 3"));
        assert_eq!(extract_sql("no code"), None);
        assert_eq!(extract_sql("```sql\nunterminated"), None);
    }
}
