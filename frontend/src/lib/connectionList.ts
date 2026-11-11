// Pure helpers for the launcher's connection list: subtitle formatting, search,
// environment filter, and grouping into sections / keyboard-navigable items.
import type { ConnectionConfig, ConnectionGroup, EnvironmentKind, StoredConnection } from './types';

/** Environments offered as filter chips (custom is only reachable through "All"). */
export const ENV_FILTERS: EnvironmentKind[] = ['local', 'development', 'testing', 'staging', 'production'];

/** Engines whose `database` is a local file path. */
const FILE_ENGINES = new Set(['sqlite', 'duck_db']);

/** Last path segment of a file path (either separator). */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * second line: `host : database`, `SSH : database` when tunnelled,
 * the file name for SQLite/DuckDB, and `endpoint or region` for DynamoDB.
 */
export function connectionSubtitle(cfg: ConnectionConfig): string {
  const db = cfg.database?.trim() ?? '';
  const host = cfg.host?.trim() || cfg.socket_path?.trim() || '';
  if (FILE_ENGINES.has(cfg.engine)) return db ? baseName(db) : '';
  if (cfg.engine === 'dynamo_db') return host || db;
  const left = cfg.ssh ? 'SSH' : host;
  const right = db || (cfg.ssh ? host : '');
  return [left, right].filter(Boolean).join(' : ');
}

/** Full, untruncated value for the subtitle tooltip (includes the SSH and file paths). */
export function connectionSubtitleTitle(cfg: ConnectionConfig): string {
  if (FILE_ENGINES.has(cfg.engine)) return cfg.database ?? '';
  if (cfg.ssh) {
    const via = `SSH ${cfg.ssh.user ? cfg.ssh.user + '@' : ''}${cfg.ssh.host}:${cfg.ssh.port}`;
    return [via, cfg.host, cfg.database].filter(Boolean).join(' : ');
  }
  return connectionSubtitle(cfg);
}

/**
 * Case-insensitive match on name, host, database, group, environment (key and
 * display label), the tags field, user and SSH host. Every whitespace-separated
 * term must match some field.
 */
export function matchesSearch(cfg: ConnectionConfig, q: string, envLabel: (e: EnvironmentKind) => string = (e) => e): boolean {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const fields = [cfg.name, cfg.host, cfg.database, cfg.group, cfg.environment, envLabel(cfg.environment), cfg.username, cfg.ssh?.host, ...(cfg.tags ?? [])]
    .filter((x): x is string => !!x)
    .map((x) => x.toLowerCase());
  return terms.every((t) => fields.some((f) => f.includes(t)));
}

export function matchesEnv(cfg: ConnectionConfig, envs: ReadonlySet<EnvironmentKind>): boolean {
  return envs.size === 0 || envs.has(cfg.environment);
}

export interface Section {
  /** null = ungrouped connections. */
  group: ConnectionGroup | null;
  items: StoredConnection[];
}

export interface ListOptions {
  q?: string;
  envs?: ReadonlySet<EnvironmentKind>;
  envLabel?: (e: EnvironmentKind) => string;
}

export const isFiltering = (o: ListOptions) => !!o.q?.trim() || (o.envs?.size ?? 0) > 0;

/**
 * Groups first (stored order; groups only named on a connection follow,
 * alphabetically), then ungrouped. Favorites lead within a section, otherwise
 * the stored connection order is kept. While filtering, groups without a match
 * are hidden; otherwise empty groups stay visible as drop targets.
 */
export function buildSections(connections: StoredConnection[], groups: ConnectionGroup[], o: ListOptions = {}): Section[] {
  const envs = o.envs ?? new Set<EnvironmentKind>();
  const list = connections.filter((c) => matchesEnv(c.config, envs) && matchesSearch(c.config, o.q ?? '', o.envLabel));
  const byGroup = new Map<string, StoredConnection[]>();
  const ungrouped: StoredConnection[] = [];
  for (const c of list) {
    const g = c.config.group?.trim();
    if (g) byGroup.set(g, [...(byGroup.get(g) ?? []), c]);
    else ungrouped.push(c);
  }
  const ordered = [...groups].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const known = new Set(ordered.map((g) => g.name));
  const implicit = connections
    .map((c) => c.config.group?.trim())
    .filter((g): g is string => !!g && !known.has(g))
    .filter((g, i, a) => a.indexOf(g) === i)
    .sort((a, b) => a.localeCompare(b))
    .map((name, i): ConnectionGroup => ({ name, color: null, collapsed: false, sort: ordered.length + i }));
  const favFirst = (xs: StoredConnection[]) => [...xs.filter((c) => c.config.favorite), ...xs.filter((c) => !c.config.favorite)];
  const filtering = isFiltering(o);
  const out: Section[] = [];
  for (const g of [...ordered, ...implicit]) {
    const items = byGroup.get(g.name) ?? [];
    if (filtering && !items.length) continue;
    out.push({ group: g, items: favFirst(items) });
  }
  if (ungrouped.length) out.push({ group: null, items: favFirst(ungrouped) });
  return out;
}

export type NavItem = { kind: 'group'; name: string } | { kind: 'conn'; id: string; group: string | null };

/** Keyboard-navigable items in display order; rows of collapsed groups are skipped. */
export function navItems(sections: Section[], expanded: (g: ConnectionGroup) => boolean): NavItem[] {
  const out: NavItem[] = [];
  for (const s of sections) {
    if (s.group) out.push({ kind: 'group', name: s.group.name });
    if (s.group && !expanded(s.group)) continue;
    for (const c of s.items) out.push({ kind: 'conn', id: c.config.id, group: s.group?.name ?? null });
  }
  return out;
}

export const navKey = (n: NavItem) => (n.kind === 'group' ? `g:${n.name}` : `c:${n.id}`);
