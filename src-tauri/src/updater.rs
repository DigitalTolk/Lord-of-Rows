//! Application updates via `tauri-plugin-updater`.
//!
//! Every update artifact is verified against the minisign public key in
//! `tauri.conf.json` (`plugins.updater.pubkey`) before it is installed, and
//! `requireSignedVersion` binds each signature to the version it was signed
//! for, so a tampered manifest cannot pair a new version number with an older
//! signed build. Nothing here relaxes those checks.
//!
//! The webview gets no updater plugin permissions: it can only call the
//! commands below, which read the endpoint from settings (no hardcoded remote
//! URL — the app is offline-first) and emit `update://progress` events.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use dbs_audit::{Category, Outcome};
use dbs_core::{DbError, ErrorKind};
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::commands::audit;
use crate::state::{AppState, APP_VERSION};

type R<T> = Result<T, DbError>;

pub const PROGRESS_EVENT: &str = "update://progress";
const MAX_URL_LEN: usize = 2048;
const MAX_NOTES_LEN: usize = 64 * 1024;
/// Emit at most one progress event per this many downloaded bytes.
const PROGRESS_STEP: u64 = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Beta,
}

impl Channel {
    fn as_str(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Beta => "beta",
        }
    }
}

#[derive(Default)]
pub struct UpdaterState {
    /// The update the user was last shown by `check_update`; `install_update` only installs this.
    pending: Mutex<Option<(Channel, Update)>>,
    installing: AtomicBool,
    installed: AtomicBool,
    /// Audit detail for the install in flight; recorded on success (or just before the Windows installer exits the app).
    success_detail: Mutex<Option<String>>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum UpdateCheck {
    NotConfigured { channel: Channel, current_version: &'static str },
    UpToDate { channel: Channel, current_version: &'static str },
    Available { channel: Channel, current_version: &'static str, version: String, notes: Option<String>, date: Option<String> },
}

#[derive(Serialize, Clone)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum Progress {
    Downloading { downloaded: u64, total: Option<u64> },
    Verifying,
    Installing,
}

#[derive(Serialize)]
pub struct Installed {
    version: String,
    restart_required: bool,
}

// ---------------------------------------------------------------- pure logic

/// Validates an update endpoint URL. `https` is required; plain `http` is only
/// accepted for loopback hosts when `allow_loopback_http` is set (debug builds,
/// matching the plugin, which refuses non-https endpoints in release builds).
pub fn validate_endpoint(raw: &str, allow_loopback_http: bool) -> R<Url> {
    let raw = raw.trim();
    if raw.len() > MAX_URL_LEN {
        return Err(DbError::invalid("update endpoint URL is too long"));
    }
    let url = Url::parse(raw).map_err(|e| DbError::invalid(format!("invalid update endpoint URL: {e}")))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(DbError::invalid("update endpoint URL must not contain credentials"));
    }
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" if url.host_str().is_some_and(|h| !h.is_empty()) => Ok(url),
        "http" if loopback && allow_loopback_http => Ok(url),
        "http" if loopback => Err(DbError::invalid("plain http update endpoints are only allowed for localhost in development builds")),
        _ => Err(DbError::invalid("update endpoint must use https")),
    }
}

/// Picks the endpoint for `channel`. `Ok(None)` means updates are not configured for it.
pub fn resolve_endpoint(channel: Channel, stable: Option<&str>, beta: Option<&str>, allow_loopback_http: bool) -> R<Option<Url>> {
    let raw = match channel {
        Channel::Stable => stable,
        Channel::Beta => beta,
    };
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => validate_endpoint(s, allow_loopback_http).map(Some),
        None => Ok(None),
    }
}

/// Compatibility check applied to the manifest: the offered version must be strictly
/// newer than the running one, and the stable channel never accepts pre-releases.
pub fn accepts_release(channel: Channel, current: &Version, remote: &Version) -> bool {
    remote > current && (channel == Channel::Beta || remote.pre.is_empty())
}

pub fn parse_channel(v: Option<&serde_json::Value>) -> R<Channel> {
    match v {
        None | Some(serde_json::Value::Null) => Ok(Channel::Stable),
        Some(v) => serde_json::from_value(v.clone()).map_err(|_| DbError::invalid("update channel must be \"stable\" or \"beta\"")),
    }
}

/// Validation hook for `set_setting` on `updates.*` keys.
pub fn validate_setting(key: &str, value: &serde_json::Value) -> R<()> {
    match key {
        "updates.channel" => parse_channel(Some(value)).map(|_| ()),
        "updates.autoCheck" if !value.is_boolean() => Err(DbError::invalid("updates.autoCheck must be a boolean")),
        "updates.endpoint.stable" | "updates.endpoint.beta" => match value {
            serde_json::Value::Null => Ok(()),
            serde_json::Value::String(s) if s.trim().is_empty() => Ok(()),
            serde_json::Value::String(s) => validate_endpoint(s, cfg!(debug_assertions)).map(|_| ()),
            _ => Err(DbError::invalid("update endpoint must be a string")),
        },
        _ => Ok(()),
    }
}

fn truncate_notes(mut s: String) -> String {
    if s.len() > MAX_NOTES_LEN {
        let mut end = MAX_NOTES_LEN;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
        s.push_str("\n…");
    }
    s
}

fn is_signature_error(e: &tauri_plugin_updater::Error) -> bool {
    use tauri_plugin_updater::Error as E;
    matches!(e, E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) | E::SignedVersionMismatch { .. } | E::MissingSignedVersion)
}

fn map_err(e: tauri_plugin_updater::Error) -> DbError {
    use tauri_plugin_updater::Error as E;
    let msg = e.to_string();
    if is_signature_error(&e) {
        return DbError::new(ErrorKind::PolicyBlocked, format!("update rejected: signature verification failed ({msg})"))
            .with_hint("The downloaded update is not signed by the Lord of the Rows release key. Nothing was installed.");
    }
    match e {
        E::Reqwest(_) | E::Network(_) => DbError::new(ErrorKind::Connection, format!("update server unreachable: {msg}")),
        E::Serialization(_) | E::Semver(_) | E::ReleaseNotFound => DbError::invalid(format!("invalid update manifest: {msg}")),
        E::TargetNotFound(_) | E::TargetsNotFound(_) => DbError::new(ErrorKind::Unsupported, format!("no update for this platform: {msg}")),
        E::InsecureTransportProtocol => DbError::invalid(msg),
        E::Io(_) | E::TempDirNotFound | E::TempDirNotOnSameMountPoint => DbError::new(ErrorKind::Io, msg),
        _ => DbError::internal(msg),
    }
}

// ---------------------------------------------------------------- commands

fn setting_str(st: &AppState, key: &str) -> R<Option<String>> {
    Ok(st.store.get_setting(key)?.and_then(|v| v.as_str().map(String::from)))
}

fn record_success(app: &AppHandle) {
    let detail = app.state::<UpdaterState>().success_detail.lock().unwrap().take();
    if let Some(d) = detail {
        audit(&app.state::<AppState>(), Category::AppUpdated, Outcome::Success, None, |e| e.detail = Some(d));
    }
}

#[tauri::command]
pub async fn check_update(app: AppHandle, st: State<'_, AppState>, up: State<'_, UpdaterState>) -> R<UpdateCheck> {
    let channel = parse_channel(st.store.get_setting("updates.channel")?.as_ref())?;
    let stable = setting_str(&st, "updates.endpoint.stable")?;
    let beta = setting_str(&st, "updates.endpoint.beta")?;
    let Some(url) = resolve_endpoint(channel, stable.as_deref(), beta.as_deref(), cfg!(debug_assertions))? else {
        *up.pending.lock().unwrap() = None;
        return Ok(UpdateCheck::NotConfigured { channel, current_version: APP_VERSION });
    };
    let hook = app.clone();
    let updater = app
        .updater_builder()
        .version_comparator(move |current, release| accepts_release(channel, &current, &release.version))
        .timeout(Duration::from_secs(60))
        // Windows: the installer exits the app, so the success audit is written here.
        .on_before_exit(move || record_success(&hook))
        .endpoints(vec![url])
        .map_err(map_err)?
        .build()
        .map_err(map_err)?;
    let found = updater.check().await.map_err(map_err)?;
    let res = match &found {
        None => UpdateCheck::UpToDate { channel, current_version: APP_VERSION },
        Some(u) => UpdateCheck::Available {
            channel,
            current_version: APP_VERSION,
            version: u.version.clone(),
            notes: u.body.clone().map(truncate_notes),
            date: u.date.and_then(|d| chrono::DateTime::from_timestamp(d.unix_timestamp(), 0)).map(|d| d.to_rfc3339()),
        },
    };
    *up.pending.lock().unwrap() = found.map(|u| (channel, u));
    Ok(res)
}

#[tauri::command]
pub async fn install_update(app: AppHandle, st: State<'_, AppState>, up: State<'_, UpdaterState>, version: String) -> R<Installed> {
    let (channel, update) = up.pending.lock().unwrap().clone().ok_or_else(|| DbError::invalid("no update pending; check for updates first"))?;
    // Only install exactly what the user was shown.
    if update.version != version {
        return Err(DbError::invalid("the pending update changed; check for updates again"));
    }
    if up.installing.swap(true, Ordering::SeqCst) {
        return Err(DbError::invalid("an update is already being installed"));
    }
    let detail = format!("{} -> {} ({})", update.current_version, update.version, channel.as_str());
    *up.success_detail.lock().unwrap() = Some(detail.clone());

    let emit = |p: Progress| {
        let _ = app.emit(PROGRESS_EVENT, p);
    };
    let mut downloaded = 0u64;
    let mut last = 0u64;
    let result = async {
        // `download` verifies the minisign signature (and signed version) before returning.
        let bytes = update
            .download(
                |chunk, total| {
                    downloaded += chunk as u64;
                    if downloaded - last >= PROGRESS_STEP || total.is_some_and(|t| downloaded >= t) {
                        last = downloaded;
                        emit(Progress::Downloading { downloaded, total });
                    }
                },
                || emit(Progress::Verifying),
            )
            .await?;
        emit(Progress::Installing);
        // `install` verifies again before touching the installation.
        update.install(&bytes)
    }
    .await;
    up.installing.store(false, Ordering::SeqCst);

    match result {
        Ok(()) => {
            record_success(&app);
            up.installed.store(true, Ordering::SeqCst);
            *up.pending.lock().unwrap() = None;
            Ok(Installed { version: update.version.clone(), restart_required: true })
        }
        Err(e) => {
            up.success_detail.lock().unwrap().take();
            let err = map_err(e);
            audit(&st, Category::AppUpdated, Outcome::Failure, None, |ev| {
                ev.error_kind = Some(err.kind);
                ev.detail = Some(detail);
            });
            Err(err)
        }
    }
}

/// Relaunches the app; only allowed after an update was installed.
#[tauri::command]
pub fn restart_after_update(app: AppHandle, up: State<'_, UpdaterState>) -> R<()> {
    if !up.installed.load(Ordering::SeqCst) {
        return Err(DbError::invalid("no update has been installed"));
    }
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn endpoint_requires_https_except_loopback_in_dev() {
        assert!(validate_endpoint("https://updates.example.com/stable/latest.json", false).is_ok());
        assert!(validate_endpoint("  https://updates.example.com/{{target}}/{{arch}}/{{current_version}}  ", false).is_ok());
        assert!(validate_endpoint("http://updates.example.com/latest.json", true).is_err());
        assert!(validate_endpoint("http://localhost:8080/latest.json", true).is_ok());
        assert!(validate_endpoint("http://127.0.0.1/latest.json", true).is_ok());
        assert!(validate_endpoint("http://[::1]:9000/latest.json", true).is_ok());
        assert!(validate_endpoint("http://localhost:8080/latest.json", false).is_err());
        assert!(validate_endpoint("http://localhost.evil.com/latest.json", true).is_err());
        assert!(validate_endpoint("file:///etc/passwd", true).is_err());
        assert!(validate_endpoint("ftp://example.com/x", true).is_err());
        assert!(validate_endpoint("https://user:pw@example.com/x", false).is_err());
        assert!(validate_endpoint("not a url", false).is_err());
        assert!(validate_endpoint(&format!("https://example.com/{}", "a".repeat(MAX_URL_LEN)), false).is_err());
    }

    #[test]
    fn channel_selects_its_own_endpoint_without_fallback() {
        let s = Some("https://u.example.com/stable.json");
        let b = Some("https://u.example.com/beta.json");
        assert_eq!(resolve_endpoint(Channel::Stable, s, b, false).unwrap().unwrap().as_str(), "https://u.example.com/stable.json");
        assert_eq!(resolve_endpoint(Channel::Beta, s, b, false).unwrap().unwrap().as_str(), "https://u.example.com/beta.json");
        assert!(resolve_endpoint(Channel::Beta, s, None, false).unwrap().is_none());
        assert!(resolve_endpoint(Channel::Stable, Some("   "), b, false).unwrap().is_none());
        assert!(resolve_endpoint(Channel::Stable, Some("http://u.example.com/x"), b, false).is_err());
    }

    #[test]
    fn only_newer_versions_are_accepted_and_stable_skips_prereleases() {
        let v = |s: &str| Version::parse(s).unwrap();
        let cur = v("0.1.0");
        assert!(accepts_release(Channel::Stable, &cur, &v("0.2.0")));
        assert!(accepts_release(Channel::Stable, &cur, &v("0.1.1")));
        assert!(!accepts_release(Channel::Stable, &cur, &v("0.1.0")));
        assert!(!accepts_release(Channel::Stable, &cur, &v("0.0.9")));
        assert!(!accepts_release(Channel::Beta, &cur, &v("0.0.9")));
        assert!(!accepts_release(Channel::Stable, &cur, &v("0.2.0-beta.1")));
        assert!(accepts_release(Channel::Beta, &cur, &v("0.2.0-beta.1")));
        // A pre-release of the running version is older than it.
        assert!(!accepts_release(Channel::Beta, &cur, &v("0.1.0-rc.1")));
        assert!(accepts_release(Channel::Beta, &v("0.2.0-beta.1"), &v("0.2.0-beta.2")));
        assert!(accepts_release(Channel::Beta, &v("0.2.0-beta.2"), &v("0.2.0")));
    }

    #[test]
    fn channel_parsing_and_setting_validation() {
        assert_eq!(parse_channel(None).unwrap(), Channel::Stable);
        assert_eq!(parse_channel(Some(&json!("beta"))).unwrap(), Channel::Beta);
        assert!(parse_channel(Some(&json!("nightly"))).is_err());
        assert!(validate_setting("updates.channel", &json!("stable")).is_ok());
        assert!(validate_setting("updates.channel", &json!(3)).is_err());
        assert!(validate_setting("updates.autoCheck", &json!(true)).is_ok());
        assert!(validate_setting("updates.autoCheck", &json!("yes")).is_err());
        assert!(validate_setting("updates.endpoint.beta", &json!("")).is_ok());
        assert!(validate_setting("updates.endpoint.beta", &json!("https://u.example.com/beta.json")).is_ok());
        assert!(validate_setting("updates.endpoint.stable", &json!("http://u.example.com/x")).is_err());
        assert!(validate_setting("updates.endpoint.stable", &json!(1)).is_err());
    }

    #[test]
    fn notes_are_truncated_on_char_boundary() {
        let s = "é".repeat(MAX_NOTES_LEN);
        let t = truncate_notes(s);
        assert!(t.len() <= MAX_NOTES_LEN + "\n…".len());
        assert!(t.ends_with('…'));
        assert_eq!(truncate_notes("short".into()), "short");
    }

    #[test]
    fn signature_failures_are_reported_as_policy_blocks() {
        let e = map_err(tauri_plugin_updater::Error::SignedVersionMismatch { signed: "0.1.0".into(), announced: "9.9.9".into() });
        assert_eq!(e.kind, ErrorKind::PolicyBlocked);
        assert!(e.message.contains("signature verification failed"));
        assert_eq!(map_err(tauri_plugin_updater::Error::MissingSignedVersion).kind, ErrorKind::PolicyBlocked);
        assert_eq!(map_err(tauri_plugin_updater::Error::ReleaseNotFound).kind, ErrorKind::InvalidInput);
    }

    /// The updater config shipped in tauri.conf.json: signature checks must stay strict.
    fn updater_config() -> serde_json::Value {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        conf["plugins"]["updater"].clone()
    }

    #[test]
    fn shipped_updater_config_keeps_verification_strict() {
        let cfg = updater_config();
        assert!(cfg["pubkey"].as_str().is_some_and(|k| !k.is_empty()), "pubkey must be set");
        assert_eq!(cfg["requireSignedVersion"], json!(true));
        for k in ["dangerousInsecureTransportProtocol", "dangerousAcceptInvalidCerts", "dangerousAcceptInvalidHostnames", "allowDowngrades"] {
            assert!(cfg.get(k).is_none_or(|v| v == &json!(false)), "{k} must not be enabled");
        }
        // No hardcoded remote endpoint: the URL comes from user settings only.
        assert!(cfg.get("endpoints").is_none_or(|v| v.as_array().is_some_and(|a| a.is_empty())));
    }

    /// Mirrors the plugin's `verify_signature` (base64 key/signature, minisign
    /// with prehash) against a fixture signed by `tauri signer sign --app-version 0.2.0`
    /// with the private key matching the shipped public key.
    #[test]
    fn shipped_pubkey_verifies_release_signatures_and_rejects_tampering() {
        use base64::Engine;
        const ARTIFACT: &[u8] = b"DB Studio updater signature fixture v0.2.0\n";
        const SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUVkFYVHAwbFkzMlpmWWtlNmFQbGFjbWhEMllEYnN0ZW9yYXNmL1lWWUMvOFJsQk9ybXRvSVdSeDJiR1lvR09oaDhxZXJiWk5hNlViaC8ydmxEbzF4SXUrelNKcWp6UFF3PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0MzkxMDA3CWZpbGU6YXJ0aWZhY3QuYmluCXZlcnNpb246MC4yLjAKS3ZLRVdjNm52em1pL0FDU3FIT0g3cHAwQUM3czMvU1psVkZiN25jZ1hZdmkrYStaaEtwTkRBNm5DQUd5cHhCWDBkL1FyVWVra1g3UWQ0WGF0T2E3QWc9PQo=";
        let b64 = |s: &str| String::from_utf8(base64::engine::general_purpose::STANDARD.decode(s).unwrap()).unwrap();
        let key = minisign_verify::PublicKey::decode(&b64(updater_config()["pubkey"].as_str().unwrap())).unwrap();
        let sig = minisign_verify::Signature::decode(&b64(SIG)).unwrap();

        key.verify(ARTIFACT, &sig, true).expect("genuine artifact must verify");
        assert!(sig.trusted_comment().contains("version:0.2.0"), "signature is bound to the release version");

        let mut tampered = ARTIFACT.to_vec();
        tampered[0] ^= 1;
        assert!(key.verify(&tampered, &sig, true).is_err(), "tampered artifact must be rejected");
        // Same bytes, but the signature's trusted comment altered (e.g. to claim another version).
        let forged = b64(SIG).replace("version:0.2.0", "version:9.9.9");
        let forged = minisign_verify::Signature::decode(&forged).unwrap();
        assert!(key.verify(ARTIFACT, &forged, true).is_err(), "altered trusted comment must be rejected");
        // A key that did not sign the artifact.
        let other = minisign_verify::PublicKey::from_base64("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3").unwrap();
        assert!(other.verify(ARTIFACT, &sig, true).is_err(), "signature from another key must be rejected");
    }
}
