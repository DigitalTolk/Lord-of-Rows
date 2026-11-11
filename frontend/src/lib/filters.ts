import i18n from '../i18n';
// Filter-bar model for table tabs. Pure functions; the per-tab state lives in
// tableWorkspace.ts. Conditions are sent to Rust, which parameterises every
// value (and validates "Raw SQL" expressions with the safety classifier).
import type { ColumnMeta, FilterCondition, FilterOp, Value } from './types';
import { parseInput } from './value';

/** Column-picker sentinels (cannot collide with real column names: they contain NUL). */
export const ANY_COLUMN = '\u0000any';
export const RAW_SQL = '\u0000raw';

export type UiOp = Exclude<FilterOp, 'raw'>;

/** Operator picker order and labels (labels are SQL, not translated). */
export const UI_OPS: { op: UiOp; label: string; key?: string }[] = [
  { op: 'eq', label: '=' },
  { op: 'ne', label: '<>' },
  { op: 'lt', label: '<' },
  { op: 'gt', label: '>' },
  { op: 'le', label: '<=' },
  { op: 'ge', label: '>=' },
  { op: 'in', label: 'IN' },
  { op: 'not_in', label: 'NOT IN' },
  { op: 'is_null', label: 'IS NULL' },
  { op: 'is_not_null', label: 'IS NOT NULL' },
  { op: 'between', label: 'BETWEEN' },
  { op: 'like', label: 'LIKE' },
  { op: 'not_like', label: 'NOT LIKE' },
  { op: 'contains', label: 'Contains', key: 'filter.opContains' },
  { op: 'not_contains', label: 'Not contains', key: 'filter.opNotContains' },
  { op: 'starts_with', label: 'Begins with', key: 'filter.opBeginsWith' },
  { op: 'ends_with', label: 'Ends with', key: 'filter.opEndsWith' },
];

export interface FilterRow {
  id: string;
  enabled: boolean;
  /** A column name, ANY_COLUMN or RAW_SQL. */
  column: string;
  op: UiOp;
  value: string;
  /** Upper bound for BETWEEN. */
  value2: string;
}

/** What the grid's Quick Filter (context menu) passes to `addFilter`. */
export interface QuickFilter {
  column: string;
  op: UiOp | 'raw';
  /** Text as the user would type it; for IN/NOT IN a comma-separated list. Omit for IS [NOT] NULL. */
  value?: string | null;
  value2?: string | null;
}

let seq = 0;
export const newRowId = () => `f${Date.now().toString(36)}${(++seq).toString(36)}`;

export function newFilterRow(column: string = ANY_COLUMN, op: UiOp = column === ANY_COLUMN ? 'contains' : 'eq'): FilterRow {
  return { id: newRowId(), enabled: true, column, op, value: '', value2: '' };
}

export function fromQuickFilter(q: QuickFilter): FilterRow {
  if (q.op === 'raw') return { ...newFilterRow(RAW_SQL), value: q.value ?? '' };
  return { ...newFilterRow(q.column, q.op), value: q.value ?? '', value2: q.value2 ?? '' };
}

export const opNeedsValue = (op: UiOp) => op !== 'is_null' && op !== 'is_not_null';
const TEXT_OPS: UiOp[] = ['contains', 'not_contains', 'starts_with', 'ends_with', 'like', 'not_like'];

/** Comma-separated list; surrounding single quotes on an item are stripped (`'a', 'b'`). */
export function splitList(text: string): string[] {
  return text
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .map((x) => (x.length >= 2 && x.startsWith("'") && x.endsWith("'") ? x.slice(1, -1).replace(/''/g, "'") : x));
}

/** Whether a row has enough input to become a condition. */
export function rowIsComplete(r: FilterRow): boolean {
  if (!r.column) return false;
  if (r.column === RAW_SQL) return r.value.trim() !== '';
  if (!opNeedsValue(r.op)) return true;
  if (r.op === 'in' || r.op === 'not_in') return splitList(r.value).length > 0;
  if (r.op === 'between') return r.value.trim() !== '' && r.value2.trim() !== '';
  return true;
}

/** Convert one UI row to a backend condition. `columns` supplies types (and the Any-column list). */
export function toCondition(r: FilterRow, columns: ColumnMeta[]): FilterCondition {
  if (r.column === RAW_SQL) return { column: '', op: 'raw', value: { t: 'text', v: r.value.trim() }, values: [] };
  const any = r.column === ANY_COLUMN;
  const col = any ? undefined : columns.find((c) => c.name === r.column);
  if (!any && !col) throw new Error(i18n.t('filter.unknownColumn', { column: r.column }));
  const text = (s: string): Value => ({ t: 'text', v: s });
  const parse = (s: string): Value => (any ? text(s) : parseInput(s, col));
  const base = any ? { column: '', any_columns: columns.map((c) => c.name) } : { column: r.column };
  if (!opNeedsValue(r.op)) return { ...base, op: r.op, values: [] };
  if (r.op === 'in' || r.op === 'not_in') return { ...base, op: r.op, values: splitList(r.value).map(parse) };
  if (r.op === 'between') return { ...base, op: r.op, values: [parse(r.value.trim()), parse(r.value2.trim())] };
  if (TEXT_OPS.includes(r.op)) return { ...base, op: r.op, value: text(r.value), values: [] };
  return { ...base, op: r.op, value: parse(r.value), values: [] };
}

/** Enabled, complete rows → conditions (combined with AND by the backend). */
export function toConditions(rows: FilterRow[], columns: ColumnMeta[]): FilterCondition[] {
  return rows.filter((r) => r.enabled && rowIsComplete(r)).map((r) => toCondition(r, columns));
}

/** Insert a fresh row after `afterId` (or at the end), inheriting its column. */
export function insertRowAfter(rows: FilterRow[], afterId?: string): { rows: FilterRow[]; id: string } {
  const i = afterId ? rows.findIndex((r) => r.id === afterId) : -1;
  const at = i < 0 ? rows.length : i + 1;
  const prev = rows[at - 1];
  const row = prev && prev.column !== RAW_SQL ? newFilterRow(prev.column, prev.column === ANY_COLUMN ? 'contains' : 'eq') : newFilterRow();
  return { rows: [...rows.slice(0, at), row, ...rows.slice(at)], id: row.id };
}

export function removeRow(rows: FilterRow[], id: string): FilterRow[] {
  return rows.filter((r) => r.id !== id);
}

export function updateRow(rows: FilterRow[], id: string, patch: Partial<FilterRow>): FilterRow[] {
  return rows.map((r) => {
    if (r.id !== id) return r;
    const next = { ...r, ...patch };
    // Switching to Any column defaults to a text search; leaving Raw SQL clears its text.
    if (patch.column === ANY_COLUMN && r.column !== ANY_COLUMN && !patch.op) next.op = 'contains';
    if (patch.column && r.column === RAW_SQL && patch.column !== RAW_SQL) next.value = '';
    return next;
  });
}
