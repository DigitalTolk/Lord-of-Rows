import { describe, expect, it } from 'vitest';
import { addRow, buildChanges, emptyStaged, pendingCount, setCell, toggleDelete } from './changes';
import { fieldStates, isJsonField, stageDefault, stageField, typeLabel } from './rowDetail';
import type { ColumnMeta, Value } from './types';

const cols: ColumnMeta[] = [
  { name: 'id', type_name: 'int4' },
  { name: 'name', type_name: 'varchar' },
  { name: 'meta', type_name: 'jsonb' },
];
const rows: Value[][] = [
  [{ t: 'int', v: 1 }, { t: 'text', v: 'a' }, { t: 'json', v: { k: 1 } }],
  [{ t: 'int', v: 2 }, { t: 'text', v: 'a' }, { t: 'null' }],
  [{ t: 'int', v: 3 }, { t: 'text', v: 'b' }, { t: 'null' }],
];

describe('row detail fields', () => {
  it('shows one row, multiple values, and staged edits', () => {
    const f = fieldStates(cols, rows, emptyStaged(), [0]);
    expect(f.map((x) => x.value)).toEqual(rows[0]);
    const multi = fieldStates(cols, rows, emptyStaged(), [0, 1]);
    expect(multi[0]).toMatchObject({ multiple: true, value: null });
    expect(multi[1]).toMatchObject({ multiple: false, value: { t: 'text', v: 'a' } });
    const staged = setCell(emptyStaged(), 1, 'name', { t: 'text', v: 'z' }, rows[1][1]);
    const after = fieldStates(cols, rows, staged, [1]);
    expect(after[1]).toMatchObject({ value: { t: 'text', v: 'z' }, edited: true });
    expect(fieldStates(cols, rows, emptyStaged(), [])[0].value).toBeNull();
  });

  it('stages exactly like a grid cell edit (same store, same SQL)', () => {
    const viaPanel = stageField(emptyStaged(), rows, [2], cols[1], 1, { t: 'text', v: 'new' });
    const viaGrid = setCell(emptyStaged(), 2, 'name', { t: 'text', v: 'new' }, rows[2][1]);
    expect(viaPanel).toEqual(viaGrid);
    expect(pendingCount(viaPanel)).toBe(1);
    expect(buildChanges(viaPanel, cols, rows, ['id'])).toEqual([
      { op: 'update', key: [['id', { t: 'int', v: 3 }]], original: [['name', { t: 'text', v: 'b' }]], changes: [['name', { t: 'text', v: 'new' }]] },
    ]);
    // Setting the original value back removes the pending change.
    expect(pendingCount(stageField(viaPanel, rows, [2], cols[1], 1, { t: 'text', v: 'b' }))).toBe(0);
  });

  it('multi-row edits stage every selected row and skip deleted ones', () => {
    const base = toggleDelete(emptyStaged(), [1]);
    const s = stageField(base, rows, [0, 1, 2], cols[1], 1, { t: 'null' });
    expect(Object.keys(s.edits).map(Number)).toEqual([0, 2]);
    expect(pendingCount(s)).toBe(3); // 2 updates + 1 delete
  });

  it('edits inserted rows and can reset them to the column default', () => {
    let s = addRow(emptyStaged(), { name: { t: 'text', v: 'x' } });
    s = stageField(s, rows, [3], cols[0], 0, { t: 'int', v: 9 });
    expect(s.inserted[0]).toEqual({ name: { t: 'text', v: 'x' }, id: { t: 'int', v: 9 } });
    expect(fieldStates(cols, rows, s, [3])[0]).toMatchObject({ value: { t: 'int', v: 9 }, edited: true });
    s = stageDefault(s, rows, [3], 'id');
    expect(s.inserted[0]).toEqual({ name: { t: 'text', v: 'x' } });
  });

  it('derives type labels', () => {
    expect(['int', 'INT(11) UNSIGNED', 'bigint', 'varchar(255)', 'json', 'jsonb', 'datetime', 'timestamp with time zone', 'tinyint(1)', 'text', 'bytea', 'int4', '_int4', 'geometry'].map(typeLabel)).toEqual([
      'long', 'long', 'longlong', 'var_string', 'json', 'json', 'datetime', 'timestamp', 'tiny', 'text', 'blob', 'long', 'array', 'geometry',
    ]);
    expect(isJsonField(cols[2], null)).toBe(true);
    expect(isJsonField(cols[1], { t: 'json', v: [] })).toBe(true);
    expect(isJsonField(cols[1], { t: 'text', v: '{}' })).toBe(false);
  });
});
