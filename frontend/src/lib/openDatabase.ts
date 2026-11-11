// Pure helpers for the "Open database" picker (components/OpenDatabaseDialog.tsx):
// which names are system schemas, list order, filtering and keyboard movement.

/** Built-in schemas/databases of MySQL-family and Postgres-family servers. */
const SYSTEM = new Set(['information_schema', 'performance_schema', 'mysql', 'sys', 'pg_catalog', 'pg_toast', 'crdb_internal', 'pg_extension']);

export function isSystemSchema(name: string): boolean {
  const n = name.toLowerCase();
  return SYSTEM.has(n) || n.startsWith('pg_toast') || n.startsWith('pg_temp_');
}

/** `schema`: a schema/database of this session; `other`: another database on the server (opens a new session). */
export type PickerSection = 'user' | 'system' | 'other';
export interface PickerItem {
  name: string;
  section: PickerSection;
  current: boolean;
}

/**
 * Items in display order: user schemas (server order), then system schemas, then
 * (Postgres) the other databases on the server, without the connected one.
 */
export function buildItems(schemas: string[], current: string | null | undefined, otherDatabases: string[] = [], currentDatabase?: string | null): PickerItem[] {
  const mk = (section: PickerSection) => (name: string): PickerItem => ({ name, section, current: section !== 'other' && name === current });
  return [
    ...schemas.filter((x) => !isSystemSchema(x)).map(mk('user')),
    ...schemas.filter(isSystemSchema).map(mk('system')),
    ...otherDatabases.filter((x) => x !== currentDatabase).map(mk('other')),
  ];
}

/** Case-insensitive substring filter; keeps the display order. */
export function filterItems(items: PickerItem[], q: string): PickerItem[] {
  const ql = q.trim().toLowerCase();
  return ql ? items.filter((x) => x.name.toLowerCase().includes(ql)) : items;
}

/** New active index for a navigation key, or null when the key does not move. */
export function moveIndex(i: number, key: string, len: number): number | null {
  if (!len) return null;
  switch (key) {
    case 'ArrowDown': return Math.min(len - 1, i + 1);
    case 'ArrowUp': return Math.max(0, i - 1);
    case 'PageDown': return Math.min(len - 1, i + 10);
    case 'PageUp': return Math.max(0, i - 10);
    default: return null;
  }
}
