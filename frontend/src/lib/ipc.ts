// Typed wrappers around Tauri IPC. All privileged work happens in Rust; this
// module only marshals arguments. Errors are rethrown as DbError objects.
import { invoke } from '@tauri-apps/api/core';
import type * as T from './types';

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

  listConnections: () => call<T.StoredConnection[]>('list_connections'),
  saveConnection: (config: T.ConnectionConfig, password: string | null, rememberPassword = true) =>
    call<T.ConnectionConfig>('save_connection', { req: { config, password, remember_password: rememberPassword } }),
  deleteConnection: (id: string) => call<void>('delete_connection', { id }),
  reorderConnections: (ids: string[]) => call<void>('reorder_connections', { ids }),
  testConnection: (config: T.ConnectionConfig, password: string | null) =>
    call<{ server: T.ServerInfo; latency_ms: number }>('test_connection', { config, password }),
  exportConnections: () => call<string>('export_connections'),
  importConnections: (json: string) => call<number>('import_connections', { json }),
  parseConnectionUrl: (url: string) => call<{ config: T.ConnectionConfig; password?: string | null }>('parse_connection_url', { url }),

  openSession: (connectionId: string, password?: string | null) => call<T.SessionOpened>('open_session', { connectionId, password: password ?? null }),
  closeSession: (sessionId: string) => call<void>('close_session', { sessionId }),
  pingSession: (sessionId: string) => call<number>('ping_session', { sessionId }),

  listDatabases: (sessionId: string) => call<string[]>('list_databases', { sessionId }),
  listSchemas: (sessionId: string) => call<string[]>('list_schemas', { sessionId }),
  listObjects: (sessionId: string, schema: string | null) => call<T.ObjectRef[]>('list_objects', { sessionId, schema }),
  describeTable: (sessionId: string, target: T.TableTarget) => call<T.TableDescription>('describe_table', { sessionId, target }),
  objectDdl: (sessionId: string, object: T.ObjectRef) => call<string>('object_ddl', { sessionId, object }),

  evaluateSql: (sessionId: string, sql: string) => call<T.Evaluation>('evaluate_sql', { sessionId, sql }),
  splitSql: (engine: T.Engine, sql: string) => call<[number, number][]>('split_sql', { engine, sql }),
  runSql: (req: { session_id: string; sql: string; query_id: string; confirm_token?: string | null; typed_confirmation?: string | null; max_rows?: number | null }) =>
    call<{ results: T.StatementResult[]; duration_ms: number }>('run_sql', { req }),
  cancelQuery: (queryId: string) => call<boolean>('cancel_query', { queryId }),
  explainSql: (sessionId: string, sql: string, analyze: boolean, confirmToken?: string | null, typedConfirmation?: string | null) =>
    call<T.ResultSet>('explain_sql', { sessionId, sql, analyze, confirmToken: confirmToken ?? null, typedConfirmation: typedConfirmation ?? null }),

  fetchTable: (sessionId: string, target: T.TableTarget, page: T.PageRequest) => call<T.ResultSet>('fetch_table', { sessionId, target, page }),
  countRows: (sessionId: string, target: T.TableTarget, filters: T.FilterCondition[]) => call<number>('count_rows', { sessionId, target, filters }),
  previewChanges: (sessionId: string, target: T.TableTarget, changes: T.RowChange[]) =>
    call<{ statements: string[]; decision: T.Decision }>('preview_changes', { sessionId, target, changes }),
  applyChanges: (sessionId: string, target: T.TableTarget, changes: T.RowChange[], confirmToken?: string | null) =>
    call<T.ApplyReport>('apply_changes', { sessionId, target, changes, confirmToken: confirmToken ?? null }),
  copyRows: (columns: T.ColumnMeta[], rows: T.Value[][], options: T.ExportOptions) => call<string>('copy_rows', { columns, rows, options }),

  pickFile: (save: boolean, defaultName?: string, extensions: string[] = []) =>
    call<T.PickedFile | null>('pick_file', { save, defaultName: defaultName ?? null, extensions }),
  exportTable: (sessionId: string, target: T.TableTarget, filters: T.FilterCondition[], grant: string, options: T.ExportOptions, gzip: boolean) =>
    call<{ rows: number; path: string }>('export_table', { sessionId, target, filters, grant, options, gzip }),
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
};
