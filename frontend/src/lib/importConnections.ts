// Pure helpers for the "Import connections" dialog.
import type { ConnImportRow } from './types';

/** Rows that can be imported at all (unsupported / invalid ones are listed but disabled). */
export const importable = (r: ConnImportRow) => r.status === 'ready' || r.status === 'exists';

/** Initial selection: everything ready; rows that already exist start unchecked. */
export function defaultSelection(rows: ConnImportRow[]): Set<string> {
  return new Set(rows.filter((r) => r.status === 'ready').map((r) => r.key));
}

/** `host : database` (or the file name for file databases), like the launcher subtitle. */
export function rowTarget(r: ConnImportRow): string {
  if (r.engine === 'sqlite' || r.engine === 'duck_db') return r.database?.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const host = r.host ? (r.port ? `${r.host}:${r.port}` : r.host) : '';
  return [host, r.database].filter(Boolean).join(' : ');
}

/** Select-all checkbox state over the importable rows. */
export function allState(rows: ConnImportRow[], sel: ReadonlySet<string>): 'all' | 'some' | 'none' {
  const keys = rows.filter(importable).map((r) => r.key);
  const n = keys.filter((k) => sel.has(k)).length;
  return n === 0 ? 'none' : n === keys.length ? 'all' : 'some';
}

/** Toggles every importable row on or off. */
export function toggleAll(rows: ConnImportRow[], sel: ReadonlySet<string>): Set<string> {
  return allState(rows, sel) === 'all' ? new Set() : new Set(rows.filter(importable).map((r) => r.key));
}
