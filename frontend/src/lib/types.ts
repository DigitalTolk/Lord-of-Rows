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
}

export interface StoredConnection {
  config: ConnectionConfig;
  last_used?: string | null;
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

export interface ServerInfo { engine: Engine; version: string; current_database?: string | null; current_user?: string | null }

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
export type FilterOp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'contains' | 'starts_with' | 'ends_with' | 'is_null' | 'is_not_null' | 'in';
export interface FilterCondition { column: string; op: FilterOp; value?: Value | null; values: Value[] }
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

// AI assistant (optional, disabled by default). Prompts are built and redacted in Rust.
export type AiTask = 'explain_sql' | 'generate_sql' | 'optimize_sql' | 'explain_error' | 'explain_plan' | 'suggest_indexes' | 'summarize_schema';
export type AiProvider = 'anthropic' | 'openai_compatible';
export interface AiSettings { enabled: boolean; provider: AiProvider; model: string; base_url: string; redact_literals: boolean }
export interface AiStatus { settings: AiSettings; has_api_key: boolean }
export interface AiPreviewRequest { task: AiTask; input: string; sql?: string | null; session_id?: string | null; include_dialect: boolean; tables: TableTarget[] }
export interface AiPreview { token: string; task: AiTask; system: string; user: string; text: string; bytes: number; provider: AiProvider; model: string; base_url: string }
export interface AiAnswer { text: string; sql?: string | null; truncated: boolean; provider: AiProvider; model: string; duration_ms: number }
