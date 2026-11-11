// Pure helpers for the key browser (Redis sessions): glob escaping, the
// namespace tree (merging bounded SCAN batches, flattening for the tree view),
// key-grid rows and value previews. Components: RedisTree, RedisKeysView,
// RedisValuePanel.
import type { ColumnMeta, ConnectionConfig, KeyRow, KeyspaceInfo, KvEdit, NamespaceNode, TreeBatch, Value } from './types';

export const DEFAULT_SEPARATOR = ':';
/** Keys examined per namespace expand ("Load more…" continues). */
export const TREE_BATCH = 2000;
export const KEY_PAGE_SIZES = [100, 200, 500, 1000];
export const DEFAULT_KEY_PAGE = 200;
/** Elements per value page in the detail panel. */
export const VALUE_PAGE = 200;

export const separatorOf = (cfg: Pick<ConnectionConfig, 'key_separator'>) => cfg.key_separator || DEFAULT_SEPARATOR;

/** Escape glob metacharacters so `s` matches literally in a key pattern. */
export const escapeGlob = (s: string) => s.replace(/[*?[\]\\]/g, '\\$&');
/** Pattern matching every key under a namespace prefix. */
export const prefixPattern = (prefix: string) => `${escapeGlob(prefix)}*`;
/** True when the pattern matches exactly one literal key (no live wildcards). */
export function isLiteralPattern(p: string): boolean {
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '\\') i++;
    else if ('*?['.includes(p[i])) return false;
  }
  return true;
}

// ---------------------------------------------------------------- namespace tree

export interface NodeState {
  namespaces: NamespaceNode[];
  keys: string[];
  cursor: number;
  done: boolean;
}

/** Children id for a database + prefix ("" = the database root). */
export const nodeId = (db: string, prefix: string) => `${db}\u0000${prefix}`;

/** Add one SCAN batch to what an expanded node already shows (counts add up, keys dedupe, sorted). */
export function mergeBatch(prev: NodeState | undefined, b: TreeBatch): NodeState {
  const ns = new Map<string, NamespaceNode>((prev?.namespaces ?? []).map((n) => [n.prefix, { ...n }]));
  for (const n of b.namespaces) {
    const cur = ns.get(n.prefix);
    if (cur) cur.count += n.count;
    else ns.set(n.prefix, { ...n });
  }
  const keys = [...new Set([...(prev?.keys ?? []), ...b.keys])].sort();
  return { namespaces: [...ns.values()].sort((a, b2) => (a.label < b2.label ? -1 : a.label > b2.label ? 1 : 0)), keys, cursor: b.cursor, done: b.done };
}

export type TreeRow =
  | { id: string; level: number; kind: 'db'; db: string; info: KeyspaceInfo }
  | { id: string; level: number; kind: 'ns'; db: string; prefix: string; label: string; count: number }
  | { id: string; level: number; kind: 'key'; db: string; key: string; label: string; parent: string }
  | { id: string; level: number; kind: 'more'; db: string; prefix: string }
  | { id: string; level: number; kind: 'loading'; db: string; prefix: string };

/**
 * Visible rows in display order: databases (level 1), and under each expanded node its
 * child namespaces, then its keys, then "Load more…" while the scan is not done.
 * `q` filters namespaces and keys by name (databases always show).
 */
export function flattenTree(dbs: KeyspaceInfo[], expanded: ReadonlySet<string>, nodes: Readonly<Record<string, NodeState | undefined>>, q = ''): TreeRow[] {
  const ql = q.trim().toLowerCase();
  const out: TreeRow[] = [];
  const walk = (db: string, prefix: string, level: number) => {
    const id = nodeId(db, prefix);
    const n = nodes[id];
    if (!n) {
      out.push({ id: `loading:${id}`, level, kind: 'loading', db, prefix });
      return;
    }
    for (const c of n.namespaces) {
      const cid = nodeId(db, c.prefix);
      const open = expanded.has(cid);
      if (ql && !open && !c.prefix.toLowerCase().includes(ql)) continue;
      out.push({ id: `ns:${cid}`, level, kind: 'ns', db, prefix: c.prefix, label: c.label, count: c.count });
      if (open) walk(db, c.prefix, level + 1);
    }
    for (const k of n.keys) {
      if (ql && !k.toLowerCase().includes(ql)) continue;
      out.push({ id: `key:${nodeId(db, k)}`, level, kind: 'key', db, key: k, label: k.slice(prefix.length) || k, parent: prefix });
    }
    if (!n.done) out.push({ id: `more:${id}`, level, kind: 'more', db, prefix });
  };
  for (const info of dbs) {
    const id = nodeId(info.name, '');
    out.push({ id: `db:${info.name}`, level: 1, kind: 'db', db: info.name, info });
    if (expanded.has(id)) walk(info.name, '', 2);
  }
  return out;
}

/** Id of the row's parent (for Left-arrow navigation), or null at the top. */
export function parentRowId(row: TreeRow, sep: string): string | null {
  if (row.kind === 'db') return null;
  const prefix = row.kind === 'key' ? row.parent : row.kind === 'ns' ? parentPrefix(row.prefix, sep) : row.prefix;
  return prefix ? `ns:${nodeId(row.db, prefix)}` : `db:${row.db}`;
}

/** `a:b:` → `a:`; `a:` → "". */
export function parentPrefix(prefix: string, sep: string): string {
  const body = prefix.endsWith(sep) ? prefix.slice(0, -sep.length) : prefix;
  const i = body.lastIndexOf(sep);
  return i < 0 ? '' : body.slice(0, i + sep.length);
}

// ---------------------------------------------------------------- key grid

const col = (name: string, type_name: string): ColumnMeta => ({ name, type_name, nullable: true, table: null });
export const KEY_COLUMNS: ColumnMeta[] = [col('key', 'text'), col('type', 'text'), col('ttl', 'int'), col('size', 'int'), col('value', 'text')];

/** Grid rows (key, type, ttl, size, value preview); `summary` renders non-string previews. */
export function keyGridRows(rows: KeyRow[], summary: (r: KeyRow) => string): Value[][] {
  return rows.map((r) => [
    { t: 'text', v: r.key },
    { t: 'text', v: r.kind },
    { t: 'int', v: r.ttl },
    r.size == null ? { t: 'null' } : { t: 'int', v: r.size },
    r.kind === 'string' && r.preview != null ? { t: 'text', v: r.preview + (r.preview_truncated ? '…' : '') } : { t: 'text', v: summary(r) },
  ]);
}

/** Pretty-printed JSON when `text` is a JSON object or array, else null. */
export function prettyJson(text: string): string | null {
  const s = text.trim();
  if (!(s.startsWith('{') && s.endsWith('}')) && !(s.startsWith('[') && s.endsWith(']'))) return null;
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return null;
  }
}

/** Plain text of a value cell (field, member, list item). */
export function cellText(v: Value | undefined): string {
  if (!v) return '';
  switch (v.t) {
    case 'null': return '';
    case 'text': case 'big_int': case 'decimal': case 'uuid': case 'date': case 'time': return v.v;
    case 'int': case 'float': case 'bool': return String(v.v);
    case 'json': return JSON.stringify(v.v);
    case 'bytes': return `0x${v.v.hex}${v.v.truncated ? '…' : ''}`;
    case 'timestamp': return v.v.iso;
    case 'array': return JSON.stringify(v.v.map(cellText));
    case 'other': return v.v.text;
  }
}

/** Staged edits per key (detail panel badge, pending list). */
export function editsFor(edits: KvEdit[], key: string): KvEdit[] {
  return edits.filter((e) => e.key === key);
}
