// TypeScript mirrors of the Rust IPC types (dbs-core, dbs-safety, dbs-audit, ...).
// Keep in sync with crates/*/src; serde uses snake_case.

export type Engine =
  | 'postgres' | 'my_sql' | 'maria_db' | 'sqlite' | 'sql_server' | 'oracle' | 'cockroach_db' | 'redshift'
  | 'single_store' | 'greenplum' | 'vertica' | 'duck_db' | 'lib_sql' | 'turso' | 'yugabyte_db' | 'percona'
  | 'mongo_db' | 'redis' | 'cassandra' | 'dynamo_db' | 'elasticsearch' | 'click_house' | 'big_query'
  | 'snowflake' | 'cloudflare_d1';

export type EnvironmentKind = 'local' | 'development' | 'testing' | 'staging' | 'production' | 'custom';
// Standard SSL modes. Older saved configs may still say 'disable' / 'verify_full' (the backend reads both).
export type TlsMode = 'preferred' | 'disabled' | 'required' | 'verify_ca' | 'verify_identity';

export interface TlsConfig {
  mode: TlsMode;
  ca_cert_path?: string | null;
  client_cert_path?: string | null;
  client_key_path?: string | null;
}

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  auth: 'password' | 'private_key' | 'agent';
  private_key_path?: string | null;
  jump_hosts: string[];
  keepalive_secs: number;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  engine: Engine;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
  socket_path?: string | null;
  tls: TlsConfig;
  ssh?: SshConfig | null;
  environment: EnvironmentKind;
  read_only: boolean;
  color?: string | null;
  group?: string | null;
  tags: string[];
  notes?: string | null;
  favorite: boolean;
  connect_timeout_secs: number;
  query_timeout_secs?: number | null;
  init_sql?: string | null;
  /** Key-value engines: namespace separator for the sidebar key tree (default `:`). */
  key_separator?: string | null;
  /** Set by the backend for connections created from an access request (read-only to the UI). */
  managed_by?: ManagedBy | null;
}

/** Origin + lifetime of a connection made from an access request (dbs-core `ManagedBy`). */
export interface ManagedBy {
  provider_id: string;
  provider_kind: string;
  request_id: string;
  credential_ref?: string | null;
  /** Unix seconds. */
  expires_at?: number | null;
  /** Access ended: the password was wiped and connecting is refused. */
  expired: boolean;
}

export interface StoredConnection {
  config: ConnectionConfig;
  last_used?: string | null;
  sort: number;
}

/** Connection-list group metadata (dbs-store). Membership is `ConnectionConfig.group`. */
export interface ConnectionGroup {
  name: string;
  color?: string | null;
  collapsed: boolean;
  sort: number;
}

export type Value =
  | { t: 'null' }
  | { t: 'bool'; v: boolean }
  | { t: 'int'; v: number }
  | { t: 'big_int'; v: string }
  | { t: 'float'; v: number }
  | { t: 'decimal'; v: string }
  | { t: 'text'; v: string }
  | { t: 'bytes'; v: { hex: string; len: number; truncated: boolean } }
  | { t: 'json'; v: unknown }
  | { t: 'uuid'; v: string }
  | { t: 'date'; v: string }
  | { t: 'time'; v: string }
  | { t: 'timestamp'; v: { iso: string; tz: boolean } }
  | { t: 'array'; v: Value[] }
  | { t: 'other'; v: { type_name: string; text: string } };

export interface ColumnMeta {
  name: string;
  type_name: string;
  nullable?: boolean | null;
  table?: string | null;
}

export interface ResultSet {
  columns: ColumnMeta[];
  rows: Value[][];
  truncated: boolean;
}

export interface StatementResult {
  statement_index: number;
  sql_excerpt: string;
  result?: ResultSet | null;
  rows_affected?: number | null;
  duration_ms: number;
  notices: string[];
  /** Rows are still arriving (streaming run). */
  streaming?: boolean;
}

export type ObjectKind =
  | 'database' | 'schema' | 'table' | 'view' | 'materialized_view' | 'function' | 'procedure' | 'trigger'
  | 'sequence' | 'index' | 'type' | 'enum' | 'extension' | 'role' | 'event' | 'collection' | 'key';

export interface ObjectRef {
  kind: ObjectKind;
  database?: string | null;
  schema?: string | null;
  name: string;
}

export interface ColumnDef {
  name: string;
  data_type: string;
  nullable: boolean;
  default?: string | null;
  is_primary_key: boolean;
  is_identity: boolean;
  comment?: string | null;
  ordinal: number;
}

export interface IndexDef { name: string; columns: string[]; unique: boolean; primary: boolean; definition?: string | null }
export interface ForeignKeyDef {
  name: string; columns: string[]; ref_schema?: string | null; ref_table: string; ref_columns: string[];
  on_update?: string | null; on_delete?: string | null;
}
export interface ConstraintDef { name: string; kind: string; definition?: string | null }

export interface TableDescription {
  object: ObjectRef;
  columns: ColumnDef[];
  primary_key: string[];
  indexes: IndexDef[];
  foreign_keys: ForeignKeyDef[];
  constraints: ConstraintDef[];
  ddl?: string | null;
  estimated_rows?: number | null;
  comment?: string | null;
}

export interface TableTarget { schema?: string | null; table: string }

export interface Capabilities {
  sql: boolean; transactions: boolean; schemas: boolean; multiple_databases: boolean; explain: boolean;
  explain_analyze: boolean; cancel: boolean; inline_edit: boolean; ddl_editing: boolean; read_only_session: boolean;
  sessions_monitor: boolean; kill_session: boolean; native_backup: boolean; object_kinds: ObjectKind[];
}

/** `tls_version`: negotiated protocol ("TLSv1.3"), "" = plaintext, null/undefined = unknown. */
export interface ServerInfo { engine: Engine; version: string; current_database?: string | null; current_user?: string | null; tls_version?: string | null }

export type Risk = 'read' | 'session' | 'write' | 'schema' | 'unknown' | 'admin' | 'destructive';
export interface Classified { index: number; verb: string; risk: Risk; flags: string[]; start: number; end: number; excerpt: string }
export interface Finding { statement: number; risk: Risk; reason: string }
export type Decision =
  | { decision: 'allow' }
  | { decision: 'confirm'; findings: Finding[]; typed_phrase?: string | null; token: string }
  | { decision: 'block'; findings: Finding[] };
export interface Evaluation { statements: Classified[]; decision: Decision }

export interface SafetyPolicy { name: string; read_only: boolean; confirm_at?: Risk | null; block_at?: Risk | null; typed_confirmation_for_destructive: boolean }

export interface SessionOpened {
  session_id: string;
  server: ServerInfo;
  capabilities: Capabilities;
  policy: SafetyPolicy;
  config: ConnectionConfig;
}

export type SortDir = 'asc' | 'desc';
export type FilterOp =
  | 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'contains' | 'not_contains' | 'starts_with' | 'ends_with' | 'like' | 'not_like'
  | 'is_null' | 'is_not_null' | 'in' | 'not_in' | 'between' | 'raw';
/** `any_columns` non-empty = "Any column" (OR over text casts). `op: 'raw'` = validated SQL expression in `value` (text). */
export interface FilterCondition { column: string; op: FilterOp; value?: Value | null; values: Value[]; any_columns?: string[] }
export interface PageRequest { offset: number; limit: number; order_by: [string, SortDir][]; filters: FilterCondition[] }

export type RowChange =
  | { op: 'insert'; values: [string, Value][] }
  | { op: 'update'; key: [string, Value][]; original: [string, Value][]; changes: [string, Value][] }
  | { op: 'delete'; key: [string, Value][]; original: [string, Value][] };

export interface ApplyReport { applied: number; rows_affected: number; conflicts: number[]; committed: boolean }

export interface DbError { kind: string; message: string; code?: string | null; hint?: string | null }

export interface SessionInfo {
  id: string; user?: string | null; database?: string | null; client?: string | null; state?: string | null;
  query?: string | null; duration_ms?: number | null; blocked_by?: string | null;
}

export type AuditCategory = string;
export interface AuditEntry {
  seq: number; id: string; ts: string; category: AuditCategory; outcome: 'success' | 'failure' | 'denied'; app_version: string;
  engine?: string | null; connection_id?: string | null; environment?: string | null; object?: string | null;
  duration_ms?: number | null; rows_affected?: number | null; session_id?: string | null; error_kind?: string | null;
  statement_kinds?: string[] | null; query?: string | null; detail?: string | null; prev_hash: string; hash: string;
}
export interface AuditFilter { category?: string; outcome?: string; connection_id?: string; text?: string; since?: string; until?: string; limit?: number; before_seq?: number }

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'json_lines' | 'sql_insert' | 'markdown' | 'xml' | 'xlsx';
export interface ExportOptions { format: ExportFormat; header?: boolean; null_text?: string; formula_guard?: boolean; dialect?: string | null; table?: TableTarget | null; rows_per_insert?: number }

export type InferredType = 'integer' | 'decimal' | 'boolean' | 'date' | 'timestamp' | 'json' | 'text';
export interface ImportOptions { format: 'csv' | 'tsv' | 'json' | 'json_lines'; delimiter?: string | null; has_header: boolean; quote: string; null_tokens: string[]; encoding: string; batch_size: number }
export interface ImportPreview { columns: string[]; inferred: InferredType[]; rows: Value[][] }
export interface ColumnMapping { source_index: number; target: string; kind: InferredType }

export interface MigrationStep { change: { op: string } & Record<string, unknown>; sql: string[]; reverse_sql?: string[] | null; destructive: boolean; may_lock: boolean; may_rewrite: boolean; warnings: string[] }
export interface Migration { dialect: string; steps: MigrationStep[] }
export interface DiffResult { changes: unknown[]; migration?: Migration | null; plan_error?: DbError | null; forward_sql?: string | null; reverse_sql?: string | null }

export interface Snippet { id: string; name: string; sql: string; folder?: string | null; favorite: boolean; connection_id?: string | null; updated: string }
export interface HistoryEntry { id: number; connection_id: string; ts: string; sql?: string | null; duration_ms?: number | null; rows?: number | null; ok: boolean; error?: string | null }
export interface Document<T = unknown> { kind: string; id: string; name: string; body: T; updated: string }

export interface AppInfo { version: string; os: string; arch: string; secret_backend: string; supported_engines: Engine[]; all_engines: Engine[] }
export type UpdateChannel = 'stable' | 'beta';
export type UpdateCheck =
  | { status: 'not_configured'; channel: UpdateChannel; current_version: string }
  | { status: 'up_to_date'; channel: UpdateChannel; current_version: string }
  | { status: 'available'; channel: UpdateChannel; current_version: string; version: string; notes?: string | null; date?: string | null };
export type UpdateProgress = { phase: 'downloading'; downloaded: number; total?: number | null } | { phase: 'verifying' } | { phase: 'installing' };
export interface PickedFile { grant: string; name: string; display_path: string }

// Importing connections from other database tools. Rows never carry secrets.
export type ConnImportSource = 'table_plus' | 'dbeaver' | 'sequel_ace' | 'sequel_pro' | 'pg_admin' | 'data_grip' | 'url_list';
export interface ConnImportDetected { source: ConnImportSource; label: string; count: number; error: string | null }
export type ConnImportRequest = { kind: 'detected'; source: ConnImportSource } | { kind: 'file'; grant: string } | { kind: 'urls'; text: string };
export type ConnImportStatus = 'ready' | 'exists' | 'unsupported' | 'invalid';
export interface ConnImportRow {
  key: string;
  name: string;
  source_engine: string;
  engine: Engine | null;
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  environment: EnvironmentKind | null;
  group: string | null;
  ssh: boolean;
  color: string | null;
  status: ConnImportStatus;
  reason: string | null;
  notes: string[];
  password: 'none' | 'included' | 'keychain';
}
export interface ConnImportPreview { preview_id: string; source: ConnImportSource; label: string; passwords_supported: boolean; rows: ConnImportRow[] }
export interface ConnImportOptions { keep_groups: boolean; keep_environment: boolean; import_passwords: boolean }
export interface ConnImportError { key: string; name: string; error: string }
export interface ConnImportResult { imported: { key: string; id: string }[]; failed: ConnImportError[]; passwords_imported: number; password_errors: ConnImportError[]; groups_created: number }

// AI assistant (optional, disabled by default). Prompts are built and redacted in Rust.
export type AiTask = 'explain_sql' | 'generate_sql' | 'optimize_sql' | 'explain_error' | 'explain_plan' | 'suggest_indexes' | 'summarize_schema';
export type AiProvider = 'anthropic' | 'openai_compatible';
export interface AiSettings { enabled: boolean; provider: AiProvider; model: string; base_url: string; redact_literals: boolean }
export interface AiStatus { settings: AiSettings; has_api_key: boolean }
export interface AiPreviewRequest { task: AiTask; input: string; sql?: string | null; session_id?: string | null; include_dialect: boolean; tables: TableTarget[] }
export interface AiPreview { token: string; task: AiTask; system: string; user: string; text: string; bytes: number; provider: AiProvider; model: string; base_url: string }
export interface AiAnswer { text: string; sql?: string | null; truncated: boolean; provider: AiProvider; model: string; duration_ms: number }
export type PluginCapability = 'format_sql' | 'export_format' | 'read_query_results' | 'read_schema';
export type PluginSigner = { kind: 'unsigned' } | { kind: 'verified'; public_key: string; fingerprint: string };
export interface PluginSettingSpec { key: string; label: string; type: 'bool' | 'string' | 'number'; default: unknown }
export interface PluginManifest {
  id: string; name: string; version: string; api_version: number; min_app_version: string; description: string; author: string;
  capabilities: PluginCapability[]; export?: { label: string; extension: string } | null; settings?: PluginSettingSpec[];
}
export interface PluginInfo {
  id: string; version: string; manifest: PluginManifest; signer: PluginSigner; wasm_sha256: string; enabled: boolean;
  grants: PluginCapability[]; settings: Record<string, unknown>; last_error?: string | null; installed: string; updated: string; incompatible?: string | null;
}
export interface PluginPreview { manifest: PluginManifest; signer: PluginSigner; wasm_sha256: string; installed_version?: string | null; signer_changed: boolean; incompatible?: string | null }

// ---- key-value browsing (dbs-core kv.rs)

export interface KeyspaceInfo { name: string; index: number; keys: number; expires: number; current: boolean }
export interface KeyRow {
  key: string;
  kind: string;
  ttl: number;
  size?: number | null;
  length?: number | null;
  preview?: string | null;
  preview_truncated: boolean;
}
export interface KeyPage { keys: KeyRow[]; next: number; done: boolean; total?: number | null }
export interface NamespaceNode { prefix: string; label: string; count: number }
export interface TreeBatch { namespaces: NamespaceNode[]; keys: string[]; cursor: number; done: boolean; scanned: number }
export interface ValueRequest { cursor: string; count: number }
export interface ValuePage {
  key: string;
  kind: string;
  ttl: number;
  size?: number | null;
  length?: number | null;
  columns: string[];
  rows: Value[][];
  text?: string | null;
  next?: string | null;
}
export type KvEdit =
  | { op: 'set_string'; key: string; value: string }
  | { op: 'expire'; key: string; seconds: number }
  | { op: 'rename'; key: string; to: string }
  | { op: 'delete'; key: string }
  | { op: 'hash_set'; key: string; field: string; value: string }
  | { op: 'hash_delete'; key: string; field: string }
  | { op: 'list_push'; key: string; value: string }
  | { op: 'list_set'; key: string; index: number; value: string }
  | { op: 'list_remove'; key: string; value: string }
  | { op: 'set_add'; key: string; member: string }
  | { op: 'set_remove'; key: string; member: string }
  | { op: 'zset_add'; key: string; member: string; score: number }
  | { op: 'zset_remove'; key: string; member: string };

// ---- access providers (dbs-access)

export interface AccessProviderKind { kind: string; label: string; default_name: string }
export interface AccessCapabilities { approvals: boolean; create_database: boolean; cancel: boolean; targets: boolean; decided_history: boolean }
/** One page of a cursor-paged list (`next` = cursor of the next page). */
export interface AccessPage<T> { items: T[]; next?: string | null }
export interface AccessProviderInfo { id: string; kind: string; name: string; base_url: string; capabilities: AccessCapabilities; has_session: boolean }
export interface AccessUser { id: string; email: string; name: string; role: string; can_approve: boolean; /** e.g. 'no_approver' */ request_blocked?: string | null }
export interface AccessStatus { signed_in: boolean; user?: AccessUser | null; signing_in: boolean; error?: DbError | null }
export type AccessLevel = 'read_only' | 'read_write';
export type AccessRequestStatus = 'pending' | 'provisioning' | 'ready' | 'failed' | 'rejected' | 'expired' | 'revoked' | 'cancelled';
export interface AccessPerson { id: string; name: string; email: string }
export interface AccessLogEntry { ts: string; level: string; msg: string }
export interface AccessRequest {
  id: string;
  resource_id: string;
  resource_name: string;
  environment_name: string;
  environment: EnvironmentKind;
  engine?: Engine | null;
  access?: AccessLevel | null;
  reason: string;
  databases: string[];
  create_database: boolean;
  status: AccessRequestStatus;
  /** Failure / rejection reason. */
  status_detail?: string | null;
  requester: AccessPerson;
  /** Who decides (pending) or decided. */
  approver?: AccessPerson | null;
  log: AccessLogEntry[];
  created_at: string;
  /** Unix seconds. */
  expires_at?: number | null;
  lifetime_hours?: number | null;
  /** When it was approved / rejected (RFC 3339). */
  decided_at?: string | null;
}
/** A request of mine plus the saved connection made from it. */
export interface AccessRequestView extends AccessRequest { connection_id?: string | null; connection_expired: boolean }
export interface AccessRequestList { requests: AccessRequestView[]; expired_connections: string[] }
export interface AccessResource {
  id: string;
  name: string;
  environment_name: string;
  environment: EnvironmentKind;
  engine: Engine;
  host?: string | null;
  port?: number | null;
  access_levels: AccessLevel[];
}
export interface AccessTargets { targets: string[]; error?: string | null }
export interface AccessRequestInput { resource_id: string; access: AccessLevel; reason: string; databases: string[]; create_database: boolean }
export interface AccessConnectCheck { reusable: boolean; connection_id?: string | null; reveals_remaining?: number | null }
export interface AccessConnectOutcome { connection_id: string; reused: boolean; reveals_remaining?: number | null; password_in_memory: boolean }
