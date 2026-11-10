import type { ColumnMeta, Value } from './types';

/** Display text for a cell. NULL is rendered by the grid separately. */
export function displayValue(v: Value): string {
  switch (v.t) {
    case 'null':
      return 'NULL';
    case 'bool':
      return v.v ? 'true' : 'false';
    case 'int':
    case 'float':
      return String(v.v);
    case 'big_int':
    case 'decimal':
    case 'text':
    case 'uuid':
    case 'date':
    case 'time':
      return v.v;
    case 'timestamp':
      return v.v.iso;
    case 'bytes':
      return `\\x${v.v.hex.slice(0, 64)}${v.v.hex.length > 64 || v.v.truncated ? '…' : ''} (${v.v.len} B)`;
    case 'json':
      return JSON.stringify(v.v);
    case 'array':
      return `{${v.v.map(displayValue).join(',')}}`;
    case 'other':
      return v.v.text;
  }
}

export const isNull = (v: Value) => v.t === 'null';

export function valuesEqual(a: Value, b: Value): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Parse user-entered text into a Value appropriate for the column type, without
 * ever passing large integers or decimals through JS numbers.
 */
export function parseInput(text: string, col: ColumnMeta | undefined, original?: Value): Value {
  const type = (col?.type_name ?? '').toLowerCase();
  const kind = original?.t;
  if (kind === 'json' || /json/.test(type)) {
    try {
      return { t: 'json', v: JSON.parse(text) };
    } catch {
      return { t: 'text', v: text };
    }
  }
  if (kind === 'bool' || /^bool/.test(type)) {
    const l = text.trim().toLowerCase();
    if (['true', 't', '1', 'yes'].includes(l)) return { t: 'bool', v: true };
    if (['false', 'f', '0', 'no'].includes(l)) return { t: 'bool', v: false };
  }
  if (kind === 'int' || kind === 'big_int' || /^(int|bigint|smallint|tinyint|mediumint|serial|bigserial|long|longlong|short|int[248])/.test(type)) {
    const t = text.trim();
    if (/^-?\d+$/.test(t)) {
      const n = Number(t);
      return Number.isSafeInteger(n) ? { t: 'int', v: n } : { t: 'big_int', v: t };
    }
  }
  if (kind === 'decimal' || /^(numeric|decimal|newdecimal|money)/.test(type)) {
    if (/^-?\d+(\.\d+)?$/.test(text.trim())) return { t: 'decimal', v: text.trim() };
  }
  if (kind === 'float' || /^(float|double|real)/.test(type)) {
    const n = Number(text);
    if (text.trim() !== '' && Number.isFinite(n)) return { t: 'float', v: n };
  }
  if (kind === 'uuid' || type === 'uuid') return { t: 'uuid', v: text.trim() };
  if (kind === 'date' || type === 'date') return { t: 'date', v: text.trim() };
  if (kind === 'timestamp' || /^(timestamp|datetime)/.test(type)) {
    const tz = /tz|with time zone/.test(type) || (original?.t === 'timestamp' && original.v.tz);
    return { t: 'timestamp', v: { iso: text.trim(), tz: !!tz } };
  }
  if (kind === 'bytes' || /bytea|blob|binary/.test(type)) {
    const h = text.trim().replace(/^\\x|^0x/i, '');
    if (/^([0-9a-f]{2})*$/i.test(h)) return { t: 'bytes', v: { hex: h.toLowerCase(), len: h.length / 2, truncated: false } };
  }
  return { t: 'text', v: text };
}

export function editableText(v: Value): string {
  if (v.t === 'null') return '';
  if (v.t === 'json') return JSON.stringify(v.v, null, 2);
  if (v.t === 'bytes') return `\\x${v.v.hex}`;
  return displayValue(v);
}

export function isNumeric(v: Value) {
  return v.t === 'int' || v.t === 'float' || v.t === 'big_int' || v.t === 'decimal';
}
