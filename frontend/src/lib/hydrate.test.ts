import { describe, expect, it } from 'vitest';
import { hydrateRows } from './hydrate';

const col = (type_name: string) => ({ name: 'c', type_name });

describe('hydrate compact rows', () => {
  it('restores exact types from column metadata', () => {
    const cols = ['int8', 'int8', 'numeric', 'float8', 'text', 'text', 'uuid', 'timestamptz', 'timestamp', 'date', 'bool', 'jsonb'].map(col);
    const rows = [[1, '9223372036854775807', '0.10', 1.5, '', null, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00', '2024-02-29', true, { t: 'json', v: { a: 1 } }]];
    expect(hydrateRows(cols, rows)[0]).toEqual([
      { t: 'int', v: 1 },
      { t: 'big_int', v: '9223372036854775807' },
      { t: 'decimal', v: '0.10' },
      { t: 'float', v: 1.5 },
      { t: 'text', v: '' },
      { t: 'null' },
      { t: 'uuid', v: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' },
      { t: 'timestamp', v: { iso: '2024-01-01T00:00:00Z', tz: true } },
      { t: 'timestamp', v: { iso: '2024-01-01T00:00:00', tz: false } },
      { t: 'date', v: '2024-02-29' },
      { t: 'bool', v: true },
      { t: 'json', v: { a: 1 } },
    ]);
  });
  it('dynamodb type names keep N exact', () => {
    const cols = ['S', 'N', 'N', 'BOOL', 'M', 'NS', 'mixed', 'mixed'].map(col);
    const ns = { t: 'array', v: [{ t: 'int', v: 1 }, { t: 'decimal', v: '2.5' }] };
    const row = ['pk', 42, '12345678901234567890.123456789', false, { t: 'json', v: { a: 1 } }, ns, { t: 'other', v: { type_name: 'N', text: '0.10' } }, 'x'];
    expect(hydrateRows(cols, [row])[0]).toEqual([
      { t: 'text', v: 'pk' },
      { t: 'int', v: 42 },
      { t: 'decimal', v: '12345678901234567890.123456789' },
      { t: 'bool', v: false },
      { t: 'json', v: { a: 1 } },
      ns,
      { t: 'other', v: { type_name: 'N', text: '0.10' } },
      { t: 'text', v: 'x' },
    ]);
  });
  it('mysql type names', () => {
    const cols = ['longlong', 'newdecimal', 'datetime', 'var_string'].map(col);
    expect(hydrateRows(cols, [['18446744073709551615', '1.50', '2024-03-01T12:34:56.789', 'x']])[0]).toEqual([
      { t: 'big_int', v: '18446744073709551615' },
      { t: 'decimal', v: '1.50' },
      { t: 'timestamp', v: { iso: '2024-03-01T12:34:56.789', tz: false } },
      { t: 'text', v: 'x' },
    ]);
  });
});
