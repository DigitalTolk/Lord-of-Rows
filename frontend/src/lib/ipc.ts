// Typed wrappers around Tauri IPC. All privileged work happens in Rust; this
// module only marshals arguments. Errors are rethrown as DbError objects.
import { Channel, invoke } from '@tauri-apps/api/core';
import type * as T from './types';
import { hydrate } from './hydrate';
import type { StreamMsg } from './stream';

export class IpcError extends Error {
  constructor(public err: T.DbError) {
    super(err.message);
  }
  get kind() {
    return this.err.kind;
  }
}

async function call<R>(cmd: string, args?: Record<string, unknown>): Promise<R> {
  try {
    return await invoke<R>(cmd, args);
  } catch (e) {
    if (e && typeof e === 'object' && 'message' in e && 'kind' in e) throw new IpcError(e as T.DbError);
    throw new IpcError({ kind: 'internal', message: String(e) });
  }
}

export const api = {
  appInfo: () => call<T.AppInfo>('app_info'),
  /** Opens another app window (own tabs, own sessions); resolves to its label. */
  openWindow: () => call<string>('open_window'),
  openPrivacySettings: (pane: 'local_network') => call<void>('open_privacy_settings', { pane }),

  listConnections: () => call<T.StoredConnection[]>('list_connections'),
  saveConnection: (config: T.ConnectionConfig, password: string | null, rememberPassword = true, ssh: { password?: string | null; passphrase?: string | null } = {}) =>
    call<T.ConnectionConfig>('save_connection', { req: { config, password, remember_password: rememberPassword, ssh_password: ssh.password ?? null, ssh_passphrase: ssh.passphrase ?? null } }),
  deleteConnection: (id: string) => call<void>('delete_connection', { id }),
  reorderConnections: (ids: string[]) => call<void>('reorder_connections', { ids }),
  listConnectionGroups: () => call<T.ConnectionGroup[]>('list_connection_groups'),
  saveConnectionGroup: (group: T.ConnectionGroup) => call<T.ConnectionGroup>('save_connection_group', { group }),
  renameConnectionGroup: (from: string, to: string) => call<void>('rename_connection_group', { from, to }),
  /** Removes the group; its connections become ungrouped. Resolves to how many moved. */
  deleteConnectionGroup: (name: string) => call<number>('delete_connection_group', { name }),
  reorderConnectionGroups: (names: string[]) => call<void>('reorder_connection_groups', { names }),
  setConnectionGroup: (id: string, group: string | null) => call<T.ConnectionConfig>('set_connection_group', { id, group }),
  testConnection: (config: T.ConnectionConfig, password: string | null, ssh: { password?: string | null; passphrase?: string | null } = {}, trustHostKey?: string) =>
    call<{ server: T.ServerInfo; latency_ms: number }>('test_connection', { config, password, sshPassword: ssh.password ?? null, sshPassphrase: ssh.passphrase ?? null, trustHostKey: trustHostKey ?? null }),
  exportConnections: () => call<string>('export_connections'),
  importConnections: (json: string) => call<number>('import_connections', { json }),
  parseConnectionUrl: (url: string) => call<{ config: T.ConnectionConfig; password?: string | null }>('parse_connection_url', { url }),

  /** `database` (Postgres family only) opens the saved connection on another database of the same server. */
  openSession: (connectionId: string, password?: string | null, trustHostKey?: string, database?: string | null) =>
    call<T.SessionOpened>('open_session', { connectionId, password: password ?? null, trustHostKey: trustHostKey ?? null, database: database ?? null }),
  closeSession: (sessionId: string) => call<void>('close_session', { sessionId }),
  pingSession: (sessionId: string) => call<number>('ping_session', { sessionId }),

  listDatabases: (sessionId: string) => call<string[]>('list_databases', { sessionId }),
  listSchemas: (sessionId: string) => call<string[]>('list_schemas', { sessionId }),
  useSchema: (sessionId: string, schema: string) => call<void>('use_schema', { sessionId, schema }),
  /** `CREATE DATABASE`/`CREATE SCHEMA` text, quoted in Rust; run it through evaluateSql + runMigration. */
  createDatabaseSql: (sessionId: string, name: string) => call<string>('create_database_sql', { sessionId, name }),
  listObjects: (sessionId: string, schema: string | null) => call<T.ObjectRef[]>('list_objects', { sessionId, schema }),
  describeTable: (sessionId: string, target: T.TableTarget) => call<T.TableDescription>('describe_table', { sessionId, target }),
  objectDdl: (sessionId: string, object: T.ObjectRef) => call<string>('object_ddl', { sessionId, object }),

  evaluateSql: (sessionId: string, sql: string) => call<T.Evaluation>('evaluate_sql', { sessionId, sql }),
  splitSql: (engine: T.Engine, sql: string) => call<[number, number][]>('split_sql', { engine, sql }),
  runSql: (req: { session_id: string; sql: string; query_id: string; confirm_token?: string | null; typed_confirmation?: string | null; max_rows?: number | null }) =>
    call<{ results: T.StatementResult[]; duration_ms: number }>('run_sql', { req }).then((r) => ({ ...r, results: r.results.map((s) => ({ ...s, result: hydrate(s.result) })) })),
  /** Streaming run: same safety gate as runSql; rows arrive via `onMessage` (see lib/stream.ts). */
  runSqlStream: (req: { session_id: string; sql: string; query_id: string; confirm_token?: string | null; typed_confirmation?: string | null; max_rows?: number | null }, onMessage: (m: StreamMsg) => void) =>
    call<{ duration_ms: number; ok: boolean }>('run_sql_stream', { req, onEvent: new Channel<StreamMsg>(onMessage) }),
  ackQueryStream: (queryId: string, seq: number) => call<void>('ack_query_stream', { queryId, seq }),
  cancelQuery: (queryId: string) => call<boolean>('cancel_query', { queryId }),
  explainSql: (sessionId: string, sql: string, analyze: boolean, confirmToken?: string | null, typedConfirmation?: string | null) =>
    call<T.ResultSet>('explain_sql', { sessionId, sql, analyze, confirmToken: confirmToken ?? null, typedConfirmation: typedConfirmation ?? null }).then(hydrate),

  fetchTable: (sessionId: string, target: T.TableTarget, page: T.PageRequest) => call<T.ResultSet>('fetch_table', { sessionId, target, page }).then(hydrate),
  countRows: (sessionId: string, target: T.TableTarget, filters: T.FilterCondition[]) => call<number>('count_rows', { sessionId, target, filters }),
  tableSelectSql: (sessionId: string, target: T.TableTarget, page: T.PageRequest) => call<string>('table_select_sql', { sessionId, target, page }),
  validateFilterSql: (sessionId: string, expr: string) => call<void>('validate_filter_sql', { sessionId, expr }),
  previewChanges: (sessionId: string, target: T.TableTarget, changes: T.RowChange[]) =>
    call<{ statements: string[]; decision: T.Decision }>('preview_changes', { sessionId, target, changes }),
  applyChanges: (sessionId: string, target: T.TableTarget, changes: T.RowChange[], confirmToken?: string | null) =>
    call<T.ApplyReport>('apply_changes', { sessionId, target, changes, confirmToken: confirmToken ?? null }),
  copyRows: (columns: T.ColumnMeta[], rows: T.Value[][], options: T.ExportOptions) => call<string>('copy_rows', { columns, rows, options }),

  /** Native picker for SSL key/cert/CA files: returns the chosen path only (never contents). */
  pickCertPath: (kind: 'key' | 'cert' | 'ca') => call<string | null>('pick_cert_path', { kind }),
  pickFile: (save: boolean, defaultName?: string, extensions: string[] = []) =>
    call<T.PickedFile | null>('pick_file', { save, defaultName: defaultName ?? null, extensions }),
  exportTable: (sessionId: string, target: T.TableTarget, filters: T.FilterCondition[], grant: string, options: T.ExportOptions, gzip: boolean) =>
    call<{ rows: number; path: string }>('export_table', { sessionId, target, filters, grant, options, gzip }),
  /** Write rows already loaded in the UI (e.g. the current grid page) to a file granted by pickFile. */
  exportRows: (sessionId: string, target: T.TableTarget, columns: T.ColumnMeta[], rows: T.Value[][], grant: string, options: T.ExportOptions) =>
    call<{ rows: number; path: string }>('export_rows', { sessionId, target, columns, rows, grant, options }),
  exportQuery: (sessionId: string, sql: string, grant: string, options: T.ExportOptions, gzip: boolean) =>
    call<{ rows: number; path: string }>('export_query', { sessionId, sql, grant, options, gzip }),
  importPreview: (grant: string, options: T.ImportOptions) => call<T.ImportPreview>('import_preview', { grant, options }),
  importRun: (req: { session_id: string; grant: string; options: T.ImportOptions; target: T.TableTarget; mapping: T.ColumnMapping[]; create_table: boolean; atomic: boolean; confirm_token?: string | null }) =>
    call<{ rows_imported: number; batches_failed: [number, string][]; committed: boolean; confirm?: T.Decision | null }>('import_run', { req }),

  schemaSnapshot: (sessionId: string, schema: string | null) => call<T.TableDescription[]>('schema_snapshot', { sessionId, schema }),
  schemaDiff: (sourceSession: string, sourceSchema: string | null, targetSession: string, targetSchema: string | null, includeDrops: boolean) =>
    call<T.DiffResult>('schema_diff', { sourceSession, sourceSchema, targetSession, targetSchema, includeDrops }),
  designerPreview: (sessionId: string, original: T.TableTarget | null, edited: T.TableDescription, renames: [string, string][]) =>
    call<T.Migration>('designer_preview', { sessionId, original, edited, renames }),
  runMigration: (sessionId: string, sql: string, confirmToken?: string | null, typedConfirmation?: string | null) =>
    call<{ results: T.StatementResult[]; duration_ms: number }>('run_migration', { sessionId, sql, confirmToken: confirmToken ?? null, typedConfirmation: typedConfirmation ?? null }),

  listDbSessions: (sessionId: string) => call<T.SessionInfo[]>('list_db_sessions', { sessionId }),
  killDbSession: (sessionId: string, targetId: string, confirmToken?: string | null) =>
    call<{ ok?: boolean; confirm?: { token: string; message: string } }>('kill_db_session', { sessionId, targetId, confirmToken: confirmToken ?? null }),

  auditQuery: (filter: T.AuditFilter) => call<T.AuditEntry[]>('audit_query', { filter }),
  auditVerify: () => call<{ entries: number; ok: boolean; first_bad_seq?: number | null; head_hash: string }>('audit_verify'),
  auditExport: (filter: T.AuditFilter, grant: string) => call<number>('audit_export', { filter, grant }),
  auditPurge: (before: string) => call<number>('audit_purge', { before }),

  getSettings: () => call<Record<string, unknown>>('get_settings'),
  setSetting: (key: string, value: unknown) => call<void>('set_setting', { key, value }),
  resetSettings: () => call<void>('reset_settings'),

  listSnippets: () => call<T.Snippet[]>('list_snippets'),
  saveSnippet: (snippet: T.Snippet) => call<T.Snippet>('save_snippet', { snippet }),
  deleteSnippet: (id: string) => call<void>('delete_snippet', { id }),
  listHistory: (connectionId: string, limit = 200) => call<T.HistoryEntry[]>('list_history', { connectionId, limit }),
  clearHistory: (connectionId: string | null) => call<void>('clear_history', { connectionId }),

  listDocuments: <B>(kind: string) => call<T.Document<B>[]>('list_documents', { kind }),
  saveDocument: (kind: string, id: string, name: string, body: unknown) => call<void>('save_document', { kind, id, name, body }),
  deleteDocument: (kind: string, id: string) => call<void>('delete_document', { kind, id }),

  backupTools: () => call<{ tool: string; path?: string | null; version?: string | null }[]>('backup_tools'),
  runBackup: (sessionId: string, grant: string, options: { scope: 'full' | 'schema_only' | 'data_only'; tables: string[]; compress: boolean }) =>
    call<{ tool: string; bytes: number; verified: boolean; notes: string[] }>('run_backup', { sessionId, grant, options }),
  runRestore: (sessionId: string, grant: string, confirmToken?: string | null, typedConfirmation?: string | null) =>
    call<{ tool: string; verified: boolean; notes: string[] }>('run_restore', { sessionId, grant, confirmToken: confirmToken ?? null, typedConfirmation: typedConfirmation ?? null }),

  // AI assistant: Rust builds and redacts the prompt; only a previewed prompt (bound by its token) can be sent.
  aiStatus: () => call<T.AiStatus>('ai_status'),
  aiSetApiKey: (provider: T.AiProvider, key: string) => call<void>('ai_set_api_key', { provider, key }),
  aiPreview: (req: T.AiPreviewRequest) => call<T.AiPreview>('ai_preview', { req }),
  aiSend: (p: T.AiPreview) => call<T.AiAnswer>('ai_send', { req: { token: p.token, task: p.task, system: p.system, user: p.user } }),
  aiTest: () => call<T.AiAnswer>('ai_test'),
  checkUpdate: () => call<T.UpdateCheck>('check_update'),
  installUpdate: (version: string) => call<{ version: string; restart_required: boolean }>('install_update', { version }),
  restartAfterUpdate: () => call<void>('restart_after_update'),
  pluginList: () => call<T.PluginInfo[]>('plugin_list'),
  pluginInspect: (grant: string) => call<T.PluginPreview>('plugin_inspect', { grant }),
  pluginInstall: (grant: string, wasmSha256: string, confirmUntrusted: boolean) => call<T.PluginInfo>('plugin_install', { grant, wasmSha256, confirmUntrusted }),
  pluginRemove: (id: string) => call<void>('plugin_remove', { id }),
  pluginSetEnabled: (id: string, enabled: boolean) => call<T.PluginInfo>('plugin_set_enabled', { id, enabled }),
  pluginSetGrants: (id: string, grants: T.PluginCapability[]) => call<T.PluginInfo>('plugin_set_grants', { id, grants }),
  pluginSetSettings: (id: string, settings: Record<string, unknown>) => call<T.PluginInfo>('plugin_set_settings', { id, settings }),
  pluginFormatSql: (id: string, sql: string) => call<string>('plugin_format_sql', { id, sql }),
  pluginExport: (id: string, grant: string, columns: T.ColumnMeta[], rows: T.Value[][]) => call<{ rows: number; path: string }>('plugin_export', { id, grant, columns, rows }),
};
