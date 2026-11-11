//! Plugin lifecycle commands: inspect → install (consent) → grant → enable →
//! run. Plugins execute in the `dbs-plugins` wasm sandbox; this module owns
//! the registry, the files under `<app data>/plugins/<id>/<version>/`, the
//! permission checks and the audit trail. Plugins never receive credentials,
//! connections, paths or settings other than their own.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use dbs_audit::{Category, Outcome};
use dbs_core::{ColumnMeta, DbError, ErrorKind, Value};
use dbs_plugins::{Capability, LoadedPlugin, Manifest, PluginError, SignerInfo};
use dbs_store::PluginRecord;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::commands::{audit, ExportReport};
use crate::state::{AppState, GrantMode, APP_VERSION};

type R<T> = Result<T, DbError>;

pub struct PluginHost {
    dir: PathBuf,
    runtime: dbs_plugins::Runtime,
    /// Compiled modules keyed by plugin id, tagged with the wasm hash they came from.
    cache: Mutex<HashMap<String, (String, LoadedPlugin)>>,
}

impl PluginHost {
    pub fn new(dir: PathBuf) -> Result<Self, String> {
        Ok(Self { dir, runtime: dbs_plugins::Runtime::new(Default::default()).map_err(|e| e.to_string())?, cache: Mutex::new(HashMap::new()) })
    }

    fn plugin_dir(&self, id: &str) -> R<PathBuf> {
        // Ids are validated reverse-DNS (no separators or dots-only segments), but check again
        // since this path is about to be written to or deleted.
        if !dbs_plugins::manifest::valid_id(id) {
            return Err(DbError::invalid("invalid plugin id"));
        }
        Ok(self.dir.join(id))
    }
}

fn perr(e: PluginError) -> DbError {
    let kind = match &e {
        PluginError::NotGranted(_) => ErrorKind::Permission,
        PluginError::Incompatible(_) => ErrorKind::Unsupported,
        PluginError::Manifest(_) | PluginError::Package(_) | PluginError::BadSignature | PluginError::InputTooLarge => ErrorKind::InvalidInput,
        _ => ErrorKind::Internal,
    };
    DbError::new(kind, e.to_string())
}

fn io(e: std::io::Error) -> DbError {
    DbError::new(ErrorKind::Io, e.to_string())
}

fn manifest_of(rec: &PluginRecord) -> R<Manifest> {
    serde_json::from_value(rec.manifest.clone()).map_err(|_| DbError::internal("stored plugin manifest is unreadable; reinstall the plugin"))
}

fn grants_of(rec: &PluginRecord) -> Vec<Capability> {
    rec.grants.iter().filter_map(|g| serde_json::from_value(serde_json::Value::String(g.clone())).ok()).collect()
}

fn signer_key(v: &serde_json::Value) -> Option<String> {
    v.get("public_key").and_then(|k| k.as_str()).map(String::from)
}

fn signer_label(s: &SignerInfo) -> String {
    match s {
        SignerInfo::Unsigned => "unsigned".into(),
        SignerInfo::Verified { fingerprint, .. } => format!("key {fingerprint}"),
    }
}

#[derive(Serialize)]
pub struct PluginView {
    #[serde(flatten)]
    rec: PluginRecord,
    /// Why the plugin cannot run on this app version, if it cannot.
    incompatible: Option<String>,
}

fn view(rec: PluginRecord) -> PluginView {
    let incompatible = manifest_of(&rec).and_then(|m| m.check_compatible(APP_VERSION).map_err(perr)).err().map(|e| e.message);
    PluginView { rec, incompatible }
}

#[derive(Serialize)]
pub struct PluginPreview {
    manifest: Manifest,
    signer: SignerInfo,
    wasm_sha256: String,
    installed_version: Option<String>,
    /// The installed version was signed by a different key (or signed, and this one is not).
    signer_changed: bool,
    incompatible: Option<String>,
}

fn read_granted_package(st: &AppState, grant: &str) -> R<dbs_plugins::Package> {
    let g = st.grant(grant, GrantMode::Read)?;
    dbs_plugins::read_package_file(&g.path).map_err(perr)
}

/// Validates a package and describes what it asks for. Installs nothing.
#[tauri::command]
pub fn plugin_inspect(st: State<'_, AppState>, grant: String) -> R<PluginPreview> {
    let pkg = read_granted_package(&st, &grant)?;
    st.plugins.runtime.load(&pkg.manifest, &pkg.wasm).map_err(perr)?;
    let existing = st.store.get_plugin(&pkg.manifest.id).ok();
    let new_key = match &pkg.signer {
        SignerInfo::Verified { public_key, .. } => Some(public_key.clone()),
        SignerInfo::Unsigned => None,
    };
    Ok(PluginPreview {
        incompatible: pkg.manifest.check_compatible(APP_VERSION).err().map(|e| e.to_string()),
        wasm_sha256: pkg.wasm_sha256(),
        signer_changed: existing.as_ref().is_some_and(|r| signer_key(&r.signer).is_some() && signer_key(&r.signer) != new_key),
        installed_version: existing.map(|r| r.version),
        signer: pkg.signer,
        manifest: pkg.manifest,
    })
}

/// Installs (or upgrades) a package the user has inspected. `wasm_sha256`
/// must match the inspected package. Unsigned packages, and packages whose
/// signer differs from the installed version, need `confirm_untrusted`.
/// New installs start disabled with no capabilities granted.
#[tauri::command]
pub fn plugin_install(st: State<'_, AppState>, grant: String, wasm_sha256: String, confirm_untrusted: bool) -> R<PluginView> {
    let pkg = read_granted_package(&st, &grant)?;
    let m = &pkg.manifest;
    let sha = pkg.wasm_sha256();
    if sha != wasm_sha256 {
        return Err(DbError::new(ErrorKind::Permission, "the plugin file changed after it was reviewed; inspect it again"));
    }
    m.check_compatible(APP_VERSION).map_err(perr)?;
    st.plugins.runtime.load(m, &pkg.wasm).map_err(perr)?;
    let existing = st.store.get_plugin(&m.id).ok();
    let new_key = match &pkg.signer {
        SignerInfo::Verified { public_key, .. } => Some(public_key.clone()),
        SignerInfo::Unsigned => None,
    };
    let same_signer = existing.as_ref().is_some_and(|r| signer_key(&r.signer).is_some() && signer_key(&r.signer) == new_key);
    if (new_key.is_none() || existing.as_ref().is_some_and(|r| signer_key(&r.signer).is_some() && !same_signer)) && !confirm_untrusted {
        return Err(DbError::new(ErrorKind::ConfirmationRequired, "this plugin is unsigned or signed by a different key; confirm to install it"));
    }
    if let Some(old) = &existing {
        if let Ok(v) = semver::Version::parse(&old.version) {
            if m.semver() < v {
                return Err(DbError::invalid(format!(
                    "version {} is older than the installed {}; remove the plugin first to downgrade",
                    m.version, old.version
                )));
            }
        }
    }

    // Write files: <dir>/<id>/<version>/{plugin.wasm,plugin.json}, via temp names then rename.
    let base = st.plugins.plugin_dir(&m.id)?;
    let vdir = base.join(&m.version);
    std::fs::create_dir_all(&vdir).map_err(io)?;
    let manifest_json = serde_json::to_vec_pretty(m).map_err(|e| DbError::internal(e.to_string()))?;
    for (name, data) in [("plugin.wasm", pkg.wasm.as_slice()), ("plugin.json", manifest_json.as_slice())] {
        let tmp = vdir.join(format!(".{name}.tmp"));
        std::fs::write(&tmp, data).map_err(io)?;
        std::fs::rename(&tmp, vdir.join(name)).map_err(io)?;
    }
    if let Some(old) = existing.as_ref().filter(|o| o.version != m.version) {
        let _ = std::fs::remove_dir_all(base.join(&old.version));
    }

    // Upgrades by the same signer keep grants still requested; anything else starts from zero.
    let grants: Vec<String> = match &existing {
        Some(old) if same_signer => grants_of(old).into_iter().filter(|c| m.has(*c)).map(|c| c.as_str().to_string()).collect(),
        _ => vec![],
    };
    let settings = existing.as_ref().and_then(|o| m.resolve_settings(&o.settings).ok()).map(serde_json::Value::Object).unwrap_or(serde_json::json!({}));
    let rec = st.store.save_plugin(&PluginRecord {
        id: m.id.clone(),
        version: m.version.clone(),
        manifest: serde_json::to_value(m).map_err(|e| DbError::internal(e.to_string()))?,
        signer: serde_json::to_value(&pkg.signer).map_err(|e| DbError::internal(e.to_string()))?,
        wasm_sha256: sha,
        enabled: false,
        grants,
        settings,
        last_error: None,
        installed: existing.as_ref().map(|o| o.installed.clone()).unwrap_or_default(),
        updated: String::new(),
    })?;
    st.plugins.cache.lock().unwrap().remove(&m.id);
    audit(&st, Category::PluginInstalled, Outcome::Success, None, |e| {
        e.object = Some(m.id.clone());
        e.detail = Some(format!(
            "{} {}{} ({}); requested: {}",
            if existing.is_some() { "upgraded to" } else { "installed" },
            m.version,
            existing.as_ref().map(|o| format!(" from {}", o.version)).unwrap_or_default(),
            signer_label(&pkg.signer),
            m.capabilities.iter().map(|c| c.as_str()).collect::<Vec<_>>().join(",")
        ));
    });
    Ok(view(rec))
}

#[tauri::command]
pub fn plugin_list(st: State<'_, AppState>) -> R<Vec<PluginView>> {
    Ok(st.store.list_plugins()?.into_iter().map(view).collect())
}

#[tauri::command]
pub fn plugin_remove(st: State<'_, AppState>, id: String) -> R<()> {
    let dir = st.plugins.plugin_dir(&id)?;
    let rec = st.store.get_plugin(&id)?;
    st.store.delete_plugin(&id)?;
    st.plugins.cache.lock().unwrap().remove(&id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(io)?;
    }
    audit(&st, Category::PluginRemoved, Outcome::Success, None, |e| {
        e.object = Some(id.clone());
        e.detail = Some(format!("removed {}", rec.version));
    });
    Ok(())
}

/// Replaces the set of granted capabilities. Each must be declared by the
/// manifest. Revoking everything also disables the plugin.
#[tauri::command]
pub fn plugin_set_grants(st: State<'_, AppState>, id: String, grants: Vec<Capability>) -> R<PluginView> {
    let mut rec = st.store.get_plugin(&id)?;
    let m = manifest_of(&rec)?;
    if let Some(c) = grants.iter().find(|c| !m.has(**c)) {
        return Err(DbError::new(ErrorKind::Permission, format!("plugin did not request capability '{c}'")));
    }
    let mut g: Vec<Capability> = grants;
    g.sort();
    g.dedup();
    let before = rec.grants.clone();
    rec.grants = g.iter().map(|c| c.as_str().to_string()).collect();
    if rec.grants.is_empty() {
        rec.enabled = false;
    }
    let rec = st.store.save_plugin(&rec)?;
    audit(&st, Category::PluginPermissionChanged, Outcome::Success, None, |e| {
        e.object = Some(id.clone());
        e.detail = Some(format!("grants [{}] -> [{}]", before.join(","), rec.grants.join(",")));
    });
    Ok(view(rec))
}

#[tauri::command]
pub fn plugin_set_enabled(st: State<'_, AppState>, id: String, enabled: bool) -> R<PluginView> {
    let mut rec = st.store.get_plugin(&id)?;
    if enabled {
        manifest_of(&rec)?.check_compatible(APP_VERSION).map_err(perr)?;
        if rec.grants.is_empty() {
            return Err(DbError::new(ErrorKind::Permission, "grant at least one capability before enabling the plugin"));
        }
        load(&st, &rec)?; // verifies the files on disk still match what was installed
        rec.last_error = None;
    }
    rec.enabled = enabled;
    let rec = st.store.save_plugin(&rec)?;
    audit(&st, Category::PluginPermissionChanged, Outcome::Success, None, |e| {
        e.object = Some(id.clone());
        e.detail = Some(if enabled { "enabled" } else { "disabled" }.into());
    });
    Ok(view(rec))
}

#[tauri::command]
pub fn plugin_set_settings(st: State<'_, AppState>, id: String, settings: serde_json::Value) -> R<PluginView> {
    let mut rec = st.store.get_plugin(&id)?;
    rec.settings = serde_json::Value::Object(manifest_of(&rec)?.resolve_settings(&settings).map_err(perr)?);
    let rec = st.store.save_plugin(&rec)?;
    audit(&st, Category::SettingsChanged, Outcome::Success, None, |e| e.detail = Some(format!("plugin {id}")));
    Ok(view(rec))
}

/// Compiled plugin for an enabled registry row, re-checking the wasm on disk
/// against the hash recorded at install time.
fn load(st: &AppState, rec: &PluginRecord) -> R<LoadedPlugin> {
    if let Some((sha, p)) = st.plugins.cache.lock().unwrap().get(&rec.id) {
        if *sha == rec.wasm_sha256 {
            return Ok(p.clone());
        }
    }
    let path = st.plugins.plugin_dir(&rec.id)?.join(&rec.version).join("plugin.wasm");
    let wasm = std::fs::read(&path).map_err(io)?;
    if hex::encode(Sha256::digest(&wasm)) != rec.wasm_sha256 {
        return Err(DbError::new(ErrorKind::Permission, "plugin files were modified after installation; reinstall the plugin"));
    }
    let p = st.plugins.runtime.load(&manifest_of(rec)?, &wasm).map_err(perr)?;
    st.plugins.cache.lock().unwrap().insert(rec.id.clone(), (rec.wasm_sha256.clone(), p.clone()));
    Ok(p)
}

/// Runs `f` on a blocking thread for an enabled plugin. A plugin that traps,
/// runs out of fuel/memory or returns bad pointers is disabled and audited.
async fn run<T: Send + 'static>(
    st: &AppState,
    id: &str,
    f: impl FnOnce(&LoadedPlugin, &[Capability], &serde_json::Value) -> Result<T, PluginError> + Send + 'static,
) -> R<T> {
    let rec = st.store.get_plugin(id)?;
    if !rec.enabled {
        return Err(DbError::new(ErrorKind::Permission, "plugin is disabled"));
    }
    let p = load(st, &rec)?;
    let grants = grants_of(&rec);
    let settings = rec.settings.clone();
    let res = tokio::task::spawn_blocking(move || f(&p, &grants, &settings)).await.map_err(|e| DbError::internal(e.to_string()))?;
    match res {
        Ok(v) => Ok(v),
        Err(e) if e.is_runtime_failure() => {
            let mut rec = rec;
            rec.enabled = false;
            rec.last_error = Some(e.to_string());
            let _ = st.store.save_plugin(&rec);
            audit(st, Category::PluginPermissionChanged, Outcome::Failure, None, |ev| {
                ev.object = Some(id.to_string());
                ev.detail = Some(format!("disabled after failure: {e}"));
            });
            Err(perr(e).with_hint("The plugin was disabled. Re-enable it in Settings → Plugins after updating it."))
        }
        Err(e) => Err(perr(e)),
    }
}

#[tauri::command]
pub async fn plugin_format_sql(st: State<'_, AppState>, id: String, sql: String) -> R<String> {
    run(&st, &id, move |p, g, s| p.format_sql(g, s, &sql)).await
}

/// Exports rows the user passed from a result grid through a plugin's custom
/// format into a save-dialog grant.
#[tauri::command]
pub async fn plugin_export(st: State<'_, AppState>, id: String, grant: String, columns: Vec<ColumnMeta>, rows: Vec<Vec<Value>>) -> R<ExportReport> {
    let g = st.grant(&grant, GrantMode::Write)?;
    let input = serde_json::to_vec(&serde_json::json!({
        "columns": columns.iter().map(|c| &c.name).collect::<Vec<_>>(),
        "rows": rows.iter().map(|r| r.iter().map(dbs_io::to_json).collect::<Vec<_>>()).collect::<Vec<_>>(),
    }))
    .map_err(|e| DbError::internal(e.to_string()))?;
    let n = rows.len() as u64;
    let bytes = run(&st, &id, move |p, gr, s| p.export_rows(gr, s, &input)).await?;
    std::fs::write(&g.path, &bytes).map_err(io)?;
    audit(&st, Category::Export, Outcome::Success, None, |e| {
        e.rows_affected = Some(n);
        e.detail = Some(format!("via plugin {id}"));
    });
    Ok(ExportReport { rows: n, path: g.path.to_string_lossy().into_owned() })
}
