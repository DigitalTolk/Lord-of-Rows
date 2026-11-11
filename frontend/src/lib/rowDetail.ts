// Row detail panel model: the selected row(s) as a vertical list of fields.
// Edits go through the same staged-edit functions as grid cells.
import { setCell, setInsertedCell, type StagedState } from './changes';
import type { ColumnMeta, Value } from './types';
import { valuesEqual } from './value';

export interface FieldState {
  column: ColumnMeta;
  index: number;
  /** Current (staged or loaded) value; `null` when the selected rows differ. */
  value: Value | null;
  multiple: boolean;
  /** At least one selected row has a staged edit for this field. */
  edited: boolean;
}

/** Value currently shown for row `r` (staged edit wins), inserted rows follow loaded ones. */
export function currentValue(staged: StagedState, rows: Value[][], r: number, col: ColumnMeta, index: number): Value {
  if (r >= rows.length) return staged.inserted[r - rows.length]?.[col.name] ?? { t: 'null' };
  return staged.edits[r]?.[col.name] ?? rows[r][index];
}

function isEdited(staged: StagedState, rows: Value[][], r: number, name: string): boolean {
  if (r >= rows.length) return staged.inserted[r - rows.length]?.[name] !== undefined;
  return staged.edits[r]?.[name] !== undefined;
}

export function fieldStates(columns: ColumnMeta[], rows: Value[][], staged: StagedState, sel: number[]): FieldState[] {
  const valid = sel.filter((r) => r >= 0 && r < rows.length + staged.inserted.length);
  return columns.map((column, index) => {
    const vals = valid.map((r) => currentValue(staged, rows, r, column, index));
    const multiple = vals.some((v) => !valuesEqual(v, vals[0]));
    return { column, index, value: multiple || vals.length === 0 ? null : vals[0], multiple, edited: valid.some((r) => isEdited(staged, rows, r, column.name)) };
  });
}

/** Stage `v` for one column across all selected rows (deleted rows are skipped). */
export function stageField(staged: StagedState, rows: Value[][], sel: number[], col: ColumnMeta, index: number, v: Value): StagedState {
  let next = staged;
  for (const r of sel) {
    if (r >= rows.length) {
      if (r - rows.length < staged.inserted.length) next = setInsertedCell(next, r - rows.length, col.name, v);
    } else if (r >= 0 && !staged.deleted.includes(r)) {
      next = setCell(next, r, col.name, v, rows[r][index]);
    }
  }
  return next;
}

/** For inserted rows: drop the column so the database default applies. */
export function stageDefault(staged: StagedState, rows: Value[][], sel: number[], name: string): StagedState {
  const targets = new Set(sel.filter((r) => r >= rows.length).map((r) => r - rows.length));
  return { ...staged, inserted: staged.inserted.map((row, i) => (targets.has(i) ? Object.fromEntries(Object.entries(row).filter(([k]) => k !== name)) : row)) };
}

/**
 * Short type label shown next to a field name, derived from the column's
 * declared type (wire-protocol style names, e.g. `long`, `var_string`, `json`).
 */
export function typeLabel(typeName: string): string {
  const t = typeName.toLowerCase().replace(/\(.*$/, '').replace(/\s+unsigned|\s+zerofill/g, '').trim();
  if (t.endsWith('[]') || t.startsWith('_')) return 'array';
  const map: [RegExp, string][] = [
    [/^(tinyint|int1)$/, 'tiny'],
    [/^(smallint|int2|smallserial|short)$/, 'short'],
    [/^(mediumint|int3|int24)$/, 'int24'],
    [/^(bigint|int8|bigserial|longlong)$/, 'longlong'],
    [/^(int|integer|int4|serial|long)$/, 'long'],
    [/^(float|float4|real)$/, 'float'],
    [/^(double|double precision|float8)$/, 'double'],
    [/^(decimal|numeric|newdecimal|money|dec|fixed)$/, 'decimal'],
    [/^(varchar|character varying|nvarchar|varchar2|var_string|citext)$/, 'var_string'],
    [/^(char|character|bpchar|nchar|string)$/, 'string'],
    [/^(text|tinytext|mediumtext|longtext|clob)$/, 'text'],
    [/^(json|jsonb)$/, 'json'],
    [/^(bool|boolean)$/, 'bool'],
    [/^date$/, 'date'],
    [/^datetime\d?$/, 'datetime'],
    [/^(timestamp|timestamptz|timestamp with(out)? time zone)$/, 'timestamp'],
    [/^(time|timetz|time with(out)? time zone)$/, 'time'],
    [/^year$/, 'year'],
    [/^uuid$/, 'uuid'],
    [/^(blob|tinyblob|mediumblob|longblob|bytea|binary|varbinary|image)$/, 'blob'],
    [/^enum$/, 'enum'],
    [/^set$/, 'set'],
    [/^(bit|varbit|bit varying)$/, 'bit'],
  ];
  for (const [re, label] of map) if (re.test(t)) return label;
  return t || 'unknown';
}

/** JSON-ish columns/values get the pretty-printed, highlighted editor. */
export const isJsonField = (col: ColumnMeta, v: Value | null) => v?.t === 'json' || /json/i.test(col.type_name);

/** Long or multi-line text uses a textarea. */
export function isMultiline(col: ColumnMeta, text: string): boolean {
  return text.length > 60 || text.includes('\n') || /text|clob|blob/i.test(col.type_name);
}
