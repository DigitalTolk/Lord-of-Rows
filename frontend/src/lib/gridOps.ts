// Pure helpers behind the grid context menu: Set Value choices, Quick Filter
// conditions, paste planning and shortcut matching. Unit tested.
import type { ColumnMeta, FilterCondition, FilterOp, Value } from './types';
import { columnKind } from './hydrate';
import { parseInput } from './value';
import { plainText } from './copyFormats';
import { selectedCells, topLeft, type Selection } from './gridSelection';

// ---------------------------------------------------------------- column traits

const typeOf = (col?: ColumnMeta) => (col?.type_name ?? '').toLowerCase();
export const isBoolColumn = (col?: ColumnMeta, v?: Value) => v?.t === 'bool' || /^bool/.test(typeOf(col));
const isJsonColumn = (col?: ColumnMeta, v?: Value) => v?.t === 'json' || /json/.test(typeOf(col));
const isBinaryColumn = (col?: ColumnMeta, v?: Value) => v?.t === 'bytes' || /bytea|blob|binary/.test(typeOf(col));

/** Text-like column (where the empty string is a meaningful value). */
export function isTextColumn(col?: ColumnMeta, v?: Value): boolean {
  if (v && v.t !== 'null') return v.t === 'text' || v.t === 'other';
  const t = typeOf(col);
  if (!t) return true;
  return columnKind(t) === 'text' && !isBoolColumn(col) && !isJsonColumn(col) && !isBinaryColumn(col) && !/^(bit|enum|set|interval|inet|cidr|point|geometry)/.test(t);
}

export type TemporalKind = 'date' | 'time' | 'ts' | 'tstz';
export function temporalKind(col?: ColumnMeta, v?: Value): TemporalKind | null {
  const k = columnKind(typeOf(col));
  if (k === 'date' || k === 'time' || k === 'ts' || k === 'tstz') return k;
  if (v?.t === 'date') return 'date';
  if (v?.t === 'time') return 'time';
  if (v?.t === 'timestamp') return v.v.tz ? 'tstz' : 'ts';
  return null;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** "Now" for a temporal column: local date/time for zone-less types, UTC instant for tz-aware ones. */
export function nowValue(kind: TemporalKind, d = new Date()): Value {
  const date = `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  switch (kind) {
    case 'date':
      return { t: 'date', v: date };
    case 'time':
      return { t: 'time', v: time };
    case 'ts':
      return { t: 'timestamp', v: { iso: `${date}T${time}`, tz: false } };
    case 'tstz':
      return { t: 'timestamp', v: { iso: d.toISOString().replace(/\.\d{3}Z$/, 'Z'), tz: true } };
  }
}

// ---------------------------------------------------------------- Set Value

export type SetValueKind = 'null' | 'empty' | 'default' | 'true' | 'false' | 'now';

export interface CellContext {
  col: ColumnMeta;
  value: Value;
  /** A staged new row (DEFAULT only exists for those). */
  inserted: boolean;
  /** From describeTable when known; NOT NULL columns refuse NULL. */
  nullable?: boolean | null;
}

/** Whether a Set Value choice makes sense for this cell. */
export function canSetValue(kind: SetValueKind, c: CellContext): boolean {
  switch (kind) {
    case 'null':
      return (c.nullable ?? c.col.nullable) !== false;
    case 'empty':
      return isTextColumn(c.col, c.value);
    case 'default':
      return c.inserted;
    case 'true':
    case 'false':
      return isBoolColumn(c.col, c.value);
    case 'now':
      return temporalKind(c.col, c.value) !== null;
  }
}

/** The staged value for a choice; `undefined` means "omit the column" (DEFAULT on insert). */
export function setValueFor(kind: SetValueKind, c: CellContext, now = new Date()): Value | undefined {
  switch (kind) {
    case 'null':
      return { t: 'null' };
    case 'empty':
      return { t: 'text', v: '' };
    case 'default':
      return undefined;
    case 'true':
      return { t: 'bool', v: true };
    case 'false':
      return { t: 'bool', v: false };
    case 'now':
      return nowValue(temporalKind(c.col, c.value) ?? 'ts', now);
  }
}

// ---------------------------------------------------------------- Quick Filter

export interface QuickFilter {
  id: string;
  /** SQL-ish label, e.g. `= 'Ada'`. */
  label: string;
  cond: FilterCondition;
}

function short(v: Value): string {
  const s = plainText(v);
  const one = s.replace(/\s+/g, ' ');
  const cut = one.length > 32 ? one.slice(0, 31) + '…' : one;
  return v.t === 'int' || v.t === 'float' || v.t === 'big_int' || v.t === 'decimal' || v.t === 'bool' ? cut : `'${cut}'`;
}

/**
 * Filters built from a cell. Values travel as typed Values in FilterCondition
 * and are bound as parameters by the backend; nothing is concatenated into SQL.
 */
export function quickFilters(col: ColumnMeta, v: Value): QuickFilter[] {
  const c = col.name;
  const mk = (op: FilterOp, label: string, value?: Value): QuickFilter => ({ id: op, label, cond: { column: c, op, value: value ?? null, values: [] } });
  const nulls = [mk('is_null', 'IS NULL'), mk('is_not_null', 'IS NOT NULL')];
  if (v.t === 'null') return nulls;
  if (v.t === 'json' || v.t === 'array') return [...nulls.reverse()];
  if (v.t === 'bytes' && v.v.truncated) return [...nulls.reverse()];
  const out: QuickFilter[] = [mk('eq', `= ${short(v)}`, v), mk('ne', `<> ${short(v)}`, v)];
  if (v.t !== 'bool' && v.t !== 'bytes') {
    out.push(mk('gt', `> ${short(v)}`, v), mk('lt', `< ${short(v)}`, v));
    const text = plainText(v);
    out.push(mk('contains', `LIKE '%${short({ t: 'text', v: text }).slice(1, -1)}%'`, { t: 'text', v: text }));
  }
  out.push(mk('is_not_null', 'IS NOT NULL'), mk('is_null', 'IS NULL'));
  return out;
}

// ---------------------------------------------------------------- paste

export interface PasteTarget {
  r: number;
  c: number;
  text: string;
}

/**
 * Where pasted cells go. `block`: the clipboard block is placed at the top-left
 * of the selection (clipped to the grid). `selected`: only selected cells are
 * filled, tiling the clipboard block over them. In both modes a single value
 * with several cells selected fills every selected cell.
 */
export function planPaste(matrix: string[][], sel: Selection | null, mode: 'block' | 'selected', nrows: number, ncols: number): { targets: PasteTarget[]; clipped: boolean } {
  const tl = topLeft(sel);
  if (!sel || !tl || !matrix.length) return { targets: [], clipped: false };
  const cells = selectedCells(sel);
  const single = matrix.length === 1 && matrix[0].length === 1;
  if (single && (mode === 'selected' || cells.length > 1)) {
    return { targets: cells.filter((x) => x.r < nrows && x.c < ncols).map((x) => ({ ...x, text: matrix[0][0] })), clipped: false };
  }
  if (mode === 'selected') {
    const h = matrix.length;
    return {
      targets: cells
        .filter((x) => x.r < nrows && x.c < ncols)
        .flatMap((x) => {
          const row = matrix[(x.r - tl.r) % h];
          const w = row.length;
          return w ? [{ ...x, text: row[(x.c - tl.c) % w] }] : [];
        }),
      clipped: false,
    };
  }
  const targets: PasteTarget[] = [];
  let clipped = false;
  matrix.forEach((row, dr) =>
    row.forEach((text, dc) => {
      const r = tl.r + dr;
      const c = tl.c + dc;
      if (r < nrows && c < ncols) targets.push({ r, c, text });
      else clipped = true;
    }),
  );
  return { targets, clipped };
}

/**
 * Convert pasted text for a column. `NULL` (exactly) becomes NULL; an empty
 * field becomes NULL for non-text columns. Text that does not fit a typed
 * column (e.g. "abc" into an integer) is reported as invalid instead of staged.
 */
export function pasteValue(text: string, col: ColumnMeta | undefined, original?: Value): { value: Value } | { invalid: true } {
  if (text === 'NULL') return { value: { t: 'null' } };
  const textual = isTextColumn(col, original);
  if (text === '' && !textual) return { value: { t: 'null' } };
  const v = parseInput(text, col, original);
  if (v.t === 'text' && !textual) {
    const k = columnKind(typeOf(col));
    const strict = ['int', 'float', 'decimal'].includes(k) || isBoolColumn(col, original) || isBinaryColumn(col, original) || isJsonColumn(col, original);
    if (strict || (original && original.t !== 'null' && ['int', 'big_int', 'float', 'decimal', 'bool', 'bytes', 'json'].includes(original.t))) return { invalid: true };
  }
  return { value: v };
}

// ---------------------------------------------------------------- shortcuts

/** Grid shortcuts. "Mod" = ⌘ on macOS, Ctrl elsewhere; "Alt" = ⌥. */
export const GRID_KEYS = {
  quickLook: 'Mod+Enter',
  setValue: 'Alt+Enter',
  refresh: 'Mod+Alt+R',
  paste: 'Mod+V',
  pasteSelected: 'Mod+Shift+V',
  addRow: 'Mod+I',
  duplicate: 'Mod+D',
  copyRows: 'Mod+C',
  copyCells: 'Mod+Shift+C',
  delete: 'Backspace',
} as const;
export type GridKey = keyof typeof GRID_KEYS;

interface KeyLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Normalised combo using the physical key for letters (on macOS ⌥R types "®",
 * so `key` alone is not enough).
 */
export function comboOf(e: KeyLike, mac: boolean): string {
  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (mac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.code && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (k === 'Delete') k = 'Backspace';
  parts.push(k);
  return parts.join('+');
}

export function gridKeyFor(e: KeyLike, mac: boolean): GridKey | null {
  const combo = comboOf(e, mac);
  for (const [k, b] of Object.entries(GRID_KEYS) as [GridKey, string][]) if (b === combo) return k;
  return null;
}

/** Menu display: ⌥⌘R on macOS, Ctrl+Alt+R elsewhere. */
export function shortcutLabel(binding: string, mac: boolean): string {
  const parts = binding.split('+');
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (mac) {
    const sym: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };
    const keySym: Record<string, string> = { Enter: '↩', Backspace: '⌫', Delete: '⌦' };
    const order = ['Ctrl', 'Alt', 'Shift', 'Mod'];
    return order.filter((m) => mods.includes(m)).map((m) => sym[m]).join('') + (keySym[key] ?? key);
  }
  const names: Record<string, string> = { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Ctrl: 'Ctrl' };
  const order = ['Mod', 'Ctrl', 'Alt', 'Shift'];
  return [...order.filter((m) => mods.includes(m)).map((m) => names[m]), key].join('+');
}

/** aria-keyshortcuts value (e.g. "Meta+Alt+R"). */
export function ariaShortcut(binding: string, mac: boolean): string {
  return binding.replace('Mod', mac ? 'Meta' : 'Control');
}
