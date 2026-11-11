// Pure text formatting for grid copies (clipboard) and parsing of pasted
// spreadsheet text. No IPC, no DOM: everything here is unit tested.
//
// Precision: big integers / decimals arrive as strings (see hydrate.ts) and are
// emitted verbatim (SQL literals, JSON number tokens), never through JS numbers.
// SQL text produced here is for the user's clipboard only; the app never runs it.
import type { ColumnMeta, Engine, TableTarget, Value } from './types';
import { family, type DialectFamily } from './sqlgen';

export type CopyFormat = 'tsv' | 'csv' | 'json' | 'sql_insert' | 'sql_update' | 'markdown';

/** A copy that cannot be produced faithfully (e.g. truncated binary into SQL). */
export class CopyFormatError extends Error {}

export interface CopyInput {
  /** Output columns, in order. */
  columns: ColumnMeta[];
  /** Rows aligned with `columns`. */
  rows: Value[][];
  /** Header line for CSV / TSV (JSON, SQL and Markdown always name columns). */
  header?: boolean;
  engine?: Engine;
  table?: TableTarget | null;
  /** Primary-key columns and their values per row (required for sql_update). */
  keys?: { columns: string[]; rows: Value[][] };
  /** Text for NULL in TSV / Markdown / column values (default "NULL"). CSV always uses an empty unquoted field. */
  nullText?: string;
}

const dialectOf = (e?: Engine): DialectFamily => (e ? family(e) : 'generic');

export function quoteIdentifier(name: string, d: DialectFamily): string {
  switch (d) {
    case 'mysql':
      return '`' + name.replace(/`/g, '``') + '`';
    case 'mssql':
      return '[' + name.replace(/]/g, ']]') + ']';
    default:
      return '"' + name.replace(/"/g, '""') + '"';
  }
}

function qualifiedTable(input: CopyInput, d: DialectFamily): string {
  const t = input.table;
  if (t?.table) return t.schema ? `${quoteIdentifier(t.schema, d)}.${quoteIdentifier(t.table, d)}` : quoteIdentifier(t.table, d);
  // Query results: use the source table when every column comes from the same one.
  const src = input.columns.map((c) => c.table ?? '');
  if (src.length && src[0] && src.every((s) => s === src[0])) return quoteIdentifier(src[0], d);
  return quoteIdentifier('table_name', d);
}

function sqlString(s: string, d: DialectFamily): string {
  let body = s.replace(/'/g, "''");
  // MySQL / MariaDB treat backslash as an escape inside strings by default.
  if (d === 'mysql') body = body.replace(/\\/g, '\\\\');
  return (d === 'mssql' ? "N'" : "'") + body + "'";
}

const SQL_NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

/** Postgres array literal text, e.g. {1,"a b",NULL}. */
function pgArrayText(items: Value[]): string {
  const el = (v: Value): string => {
    if (v.t === 'null') return 'NULL';
    if (v.t === 'array') return pgArrayText(v.v);
    const s = plainText(v, 'NULL');
    if (s === '' || /[{},"\\\s]/.test(s) || s.toUpperCase() === 'NULL') return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    return s;
  };
  return '{' + items.map(el).join(',') + '}';
}

/** SQL literal for a value in the given dialect family. */
export function sqlLiteral(v: Value, d: DialectFamily): string {
  switch (v.t) {
    case 'null':
      return 'NULL';
    case 'bool':
      return d === 'pg' ? (v.v ? 'TRUE' : 'FALSE') : v.v ? '1' : '0';
    case 'int':
      return String(v.v);
    case 'big_int':
    case 'decimal':
      return SQL_NUMBER.test(v.v.trim()) ? v.v.trim() : sqlString(v.v, d);
    case 'float':
      return Number.isFinite(v.v) ? (Object.is(v.v, -0) ? '0' : String(v.v)) : sqlString(String(v.v), d);
    case 'bytes':
      if (v.v.truncated) throw new CopyFormatError('A binary value was only partially loaded; it cannot be copied as SQL.');
      if (d === 'pg') return `'\\x${v.v.hex}'::bytea`;
      if (d === 'mssql') return `0x${v.v.hex}`;
      return `X'${v.v.hex}'`;
    case 'json':
      return sqlString(JSON.stringify(v.v), d);
    case 'array':
      return sqlString(d === 'pg' ? pgArrayText(v.v) : jsonValue(v), d);
    case 'timestamp':
      return sqlString(v.v.iso, d);
    case 'other':
      return sqlString(v.v.text, d);
    default:
      return sqlString(v.v, d);
  }
}

/** Plain text of a value (clipboard / TSV / CSV). Full fidelity, unlike the grid's display text. */
export function plainText(v: Value, nullText = 'NULL'): string {
  switch (v.t) {
    case 'null':
      return nullText;
    case 'bool':
      return v.v ? 'true' : 'false';
    case 'int':
    case 'float':
      return String(v.v);
    case 'bytes':
      return `\\x${v.v.hex}${v.v.truncated ? '…' : ''}`;
    case 'json':
      return JSON.stringify(v.v);
    case 'timestamp':
      return v.v.iso;
    case 'array':
      return pgArrayText(v.v);
    case 'other':
      return v.v.text;
    default:
      return v.v;
  }
}

const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/;

/** JSON text of a value. Big integers / decimals are written as exact number tokens. */
export function jsonValue(v: Value): string {
  switch (v.t) {
    case 'null':
      return 'null';
    case 'bool':
      return v.v ? 'true' : 'false';
    case 'int':
      return String(v.v);
    case 'big_int':
    case 'decimal':
      return JSON_NUMBER.test(v.v) ? v.v : JSON.stringify(v.v);
    case 'float':
      return Number.isFinite(v.v) ? JSON.stringify(v.v) : JSON.stringify(String(v.v));
    case 'bytes':
      if (v.v.truncated) throw new CopyFormatError('A binary value was only partially loaded; it cannot be copied as JSON.');
      return JSON.stringify(`\\x${v.v.hex}`);
    case 'json':
      return JSON.stringify(v.v) ?? 'null';
    case 'array':
      return '[' + v.v.map(jsonValue).join(', ') + ']';
    case 'timestamp':
      return JSON.stringify(v.v.iso);
    case 'other':
      return JSON.stringify(v.v.text);
    default:
      return JSON.stringify(v.v);
  }
}

/** One delimited field: quoted (RFC 4180 style, quotes doubled) when it contains the delimiter, a quote or a line break. */
function delimitedField(s: string, delim: string): string {
  return s.includes(delim) || /["\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function delimited(input: CopyInput, delim: ',' | '\t'): string {
  const csv = delim === ',';
  const eol = csv ? '\r\n' : '\n';
  const nullText = input.nullText ?? 'NULL';
  const lines: string[] = [];
  if (input.header) lines.push(input.columns.map((c) => delimitedField(c.name, delim)).join(delim));
  for (const row of input.rows) {
    lines.push(
      row
        .map((v) => {
          // CSV: NULL is an empty unquoted field, the empty string is "" (as PostgreSQL COPY does).
          if (csv && v.t === 'null') return '';
          if (csv && v.t === 'text' && v.v === '') return '""';
          return delimitedField(plainText(v, nullText), delim);
        })
        .join(delim),
    );
  }
  return lines.join(eol);
}

function uniqueKeys(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = seen.get(n) ?? 0;
    seen.set(n, k + 1);
    return k === 0 ? n : `${n}_${k + 1}`;
  });
}

function json(input: CopyInput): string {
  const keys = uniqueKeys(input.columns.map((c) => c.name)).map((k) => JSON.stringify(k));
  if (!input.rows.length) return '[]';
  const objs = input.rows.map((r) => '  {' + r.map((v, i) => `${keys[i]}: ${jsonValue(v)}`).join(', ') + '}');
  return '[\n' + objs.join(',\n') + '\n]';
}

function markdownCell(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
}

function markdown(input: CopyInput): string {
  const nullText = input.nullText ?? 'NULL';
  const head = '| ' + input.columns.map((c) => markdownCell(c.name)).join(' | ') + ' |';
  const sep = '| ' + input.columns.map(() => '---').join(' | ') + ' |';
  const body = input.rows.map((r) => '| ' + r.map((v) => markdownCell(plainText(v, nullText))).join(' | ') + ' |');
  return [head, sep, ...body].join('\n');
}

function sqlInsert(input: CopyInput): string {
  const d = dialectOf(input.engine);
  const table = qualifiedTable(input, d);
  const cols = input.columns.map((c) => quoteIdentifier(c.name, d)).join(', ');
  return input.rows.map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map((v) => sqlLiteral(v, d)).join(', ')});`).join('\n');
}

function sqlUpdate(input: CopyInput): string {
  const d = dialectOf(input.engine);
  const keys = input.keys;
  if (!keys || keys.columns.length === 0) throw new CopyFormatError('UPDATE statements need a primary key, and this result has none.');
  if (keys.rows.length !== input.rows.length) throw new CopyFormatError('Key values do not match the copied rows.');
  const table = qualifiedTable(input, d);
  const setIdx = input.columns.map((c, i) => [c, i] as const).filter(([c]) => !keys.columns.includes(c.name));
  if (!setIdx.length) throw new CopyFormatError('Only primary-key columns are selected; there is nothing to update.');
  return input.rows
    .map((r, ri) => {
      const set = setIdx.map(([c, i]) => `${quoteIdentifier(c.name, d)} = ${sqlLiteral(r[i], d)}`).join(', ');
      const where = keys.columns
        .map((k, ki) => {
          const v = keys.rows[ri][ki];
          return v.t === 'null' ? `${quoteIdentifier(k, d)} IS NULL` : `${quoteIdentifier(k, d)} = ${sqlLiteral(v, d)}`;
        })
        .join(' AND ');
      return `UPDATE ${table} SET ${set} WHERE ${where};`;
    })
    .join('\n');
}

/** Format rows for the clipboard. Throws CopyFormatError when the result would be wrong. */
export function formatRows(format: CopyFormat, input: CopyInput): string {
  switch (format) {
    case 'tsv':
      return delimited(input, '\t');
    case 'csv':
      return delimited(input, ',');
    case 'json':
      return json(input);
    case 'markdown':
      return markdown(input);
    case 'sql_insert':
      return sqlInsert(input);
    case 'sql_update':
      return sqlUpdate(input);
  }
}

/** All values of one column, one per line. */
export function columnValuesText(values: Value[], nullText = 'NULL'): string {
  return values.map((v) => plainText(v, nullText)).join('\n');
}

/**
 * Parse clipboard text into a matrix of cells. Tab-separated text (what
 * spreadsheets and this grid put on the clipboard) is split into rows and
 * columns, honouring "quoted" fields that contain tabs, quotes or line breaks.
 * Text without tabs is one column (one row per line); a single line is one value.
 */
export function parseClipboard(text: string): string[][] {
  let s = text.replace(/\r\n?/g, '\n');
  if (s.endsWith('\n')) s = s.slice(0, -1);
  if (!s.includes('\t') && !s.includes('\n')) return [[s]];
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const n = s.length;
  while (i <= n) {
    let field = '';
    if (s[i] === '"') {
      // Quoted field: find the closing quote that is followed by a delimiter / end.
      let j = i + 1;
      let buf = '';
      let closed = false;
      while (j < n) {
        if (s[j] === '"') {
          if (s[j + 1] === '"') {
            buf += '"';
            j += 2;
            continue;
          }
          closed = j + 1 === n || s[j + 1] === '\t' || s[j + 1] === '\n';
          break;
        }
        buf += s[j++];
      }
      if (closed) {
        field = buf;
        i = j + 1;
      } else {
        // Not a well-formed quoted field: take it literally up to the next delimiter.
        let k = i;
        while (k < n && s[k] !== '\t' && s[k] !== '\n') k++;
        field = s.slice(i, k);
        i = k;
      }
    } else {
      let k = i;
      while (k < n && s[k] !== '\t' && s[k] !== '\n') k++;
      field = s.slice(i, k);
      i = k;
    }
    row.push(field);
    if (i >= n) {
      rows.push(row);
      break;
    }
    if (s[i] === '\n') {
      rows.push(row);
      row = [];
    }
    i++;
  }
  return rows;
}
