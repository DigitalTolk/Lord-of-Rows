//! Desktop shell: wires the backend crates to Tauri IPC commands.
//! Every command validates its arguments; safety policy and audit logging are
//! enforced here, in Rust, not in the webview.

mod ai;
mod backup;
mod commands;
mod state;

use std::collections::HashMap;
use std::sync::Mutex;

use dbs_audit::AuditLog;
use dbs_safety::ConfirmationGuard;
use dbs_store::AppStore;
use state::AppState;
use tauri::Manager;

fn is_app_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => {
            matches!(url.host_str(), Some("tauri.localhost"))
                || (cfg!(debug_assertions) && matches!(url.host_str(), Some("localhost")) && url.port() == Some(5173))
        }
        _ => false,
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("app data dir");
            std::fs::create_dir_all(&dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
            }
            let store = AppStore::open(&dir.join("app.db")).map_err(|e| e.message)?;
            let audit = AuditLog::open(&dir.join("audit.db"), state::APP_VERSION).map_err(|e| e.message)?;
            if let Ok(Some(p)) = store.get_setting("audit.queryText") {
                if let Ok(policy) = serde_json::from_value(p) {
                    *audit.query_policy.lock().unwrap() = policy;
                }
            }
            app.manage(AppState {
                store,
                audit,
                secrets: Box::new(dbs_secrets::OsKeychain),
                session_secrets: Default::default(),
                guard: ConfirmationGuard::new(state::random_key()),
                ai_guard: dbs_ai::PromptGuard::new(state::random_key()),
                sessions: Mutex::new(HashMap::new()),
                running: Mutex::new(HashMap::new()),
                grants: Mutex::new(HashMap::new()),
                known_hosts: dir.join("known_hosts"),
            });
            // Main window is created here (not in tauri.conf.json) so a navigation
            // guard can be attached: the webview may only ever show bundled content.
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("DB Studio")
                .inner_size(1400.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .on_navigation(is_app_url)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::reorder_connections,
            commands::test_connection,
            commands::export_connections,
            commands::import_connections,
            commands::parse_connection_url,
            commands::open_session,
            commands::close_session,
            commands::ping_session,
            commands::list_databases,
            commands::list_schemas,
            commands::list_objects,
            commands::use_schema,
            commands::describe_table,
            commands::object_ddl,
            commands::evaluate_sql,
            commands::run_sql,
            commands::cancel_query,
            commands::split_sql,
            commands::explain_sql,
            commands::fetch_table,
            commands::count_rows,
            commands::preview_changes,
            commands::apply_changes,
            commands::copy_rows,
            commands::pick_file,
            commands::export_table,
            commands::export_query,
            commands::import_preview,
            commands::import_run,
            commands::schema_snapshot,
            commands::schema_diff,
            commands::designer_preview,
            commands::run_migration,
            commands::list_db_sessions,
            commands::kill_db_session,
            commands::audit_query,
            commands::audit_verify,
            commands::audit_export,
            commands::audit_purge,
            commands::get_settings,
            commands::set_setting,
            commands::reset_settings,
            commands::list_snippets,
            commands::save_snippet,
            commands::delete_snippet,
            commands::list_history,
            commands::clear_history,
            commands::list_documents,
            commands::save_document,
            commands::delete_document,
            commands::backup_tools,
            commands::run_backup,
            commands::run_restore,
            ai::ai_status,
            ai::ai_set_api_key,
            ai::ai_preview,
            ai::ai_send,
            ai::ai_test,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DB Studio");
}
