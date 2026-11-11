// Rebuild tagged Values from the compact wire form (see dbs_core::value::compact).
// Column type names decide the exact type, so precision rules are preserved:
// big integers / decimals arrive as strings and stay strings.
import type { ColumnMeta, ResultSet, Value } from './types';

type Kind = 'int' | 'float' | 'decimal' | 'uuid' | 'date' | 'time' | 'ts' | 'tstz' | 'text';

export function columnKind(typeName: string): Kind {
  const t = typeName.toLowerCase();
  if (/^(int|bigint|smallint|tinyint|mediumint|serial|bigserial|int[248]|long|longlong|short|year|oid|integer)/.test(t)) return 'int';
  if (/^(float|double|real)/.test(t)) return 'float';
  if (/^(numeric|decimal|newdecimal|money)/.test(t)) return 'decimal';
  if (t === 'uuid') return 'uuid';
  if (t === 'date' || t === 'newdate') return 'date';
  if (/^(time|timetz)$/.test(t)) return 'time';
  if (/^timestamptz|with time zone/.test(t)) return 'tstz';
  if (/^(timestamp|datetime)/.test(t)) return 'ts';
  return 'text';
}

function cell(raw: unknown, kind: Kind): Value {
  if (raw === null || raw === undefined) return { t: 'null' };
  if (typeof raw === 'boolean') return { t: 'bool', v: raw };
  if (typeof raw === 'number') return kind === 'float' || kind === 'decimal' || !Number.isInteger(raw) ? { t: 'float', v: raw } : { t: 'int', v: raw };
  if (typeof raw === 'string') {
    switch (kind) {
      case 'int':
        return { t: 'big_int', v: raw };
      case 'decimal':
      case 'float':
        return { t: 'decimal', v: raw };
      case 'uuid':
        return { t: 'uuid', v: raw };
      case 'date':
        return { t: 'date', v: raw };
      case 'time':
        return { t: 'time', v: raw };
      case 'ts':
      case 'tstz':
        return { t: 'timestamp', v: { iso: raw, tz: kind === 'tstz' || raw.endsWith('Z') } };
      default:
        return { t: 'text', v: raw };
    }
  }
  return raw as Value; // already tagged (bytes / json / array / other)
}

export function hydrateRows(columns: ColumnMeta[], rows: unknown[][]): Value[][] {
  const kinds = columns.map((c) => columnKind(c.type_name));
  const out = new Array<Value[]>(rows.length);
  for (let r = 0; r < rows.length; r++) {
    const src = rows[r];
    const row = new Array<Value>(src.length);
    for (let c = 0; c < src.length; c++) row[c] = cell(src[c], kinds[c] ?? 'text');
    out[r] = row;
  }
  return out;
}

export function hydrate<T extends ResultSet | null | undefined>(rs: T): T {
  if (!rs) return rs;
  return { ...rs, rows: hydrateRows(rs.columns, rs.rows as unknown as unknown[][]) } as T;
}
