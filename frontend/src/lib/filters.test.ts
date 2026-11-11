import { beforeEach, describe, expect, it } from 'vitest';
import { ANY_COLUMN, insertRowAfter, newFilterRow, RAW_SQL, removeRow, rowIsComplete, splitList, toCondition, toConditions, updateRow, type FilterRow } from './filters';
import { selectTab, useTableWs } from './tableWorkspace';
import type { ColumnMeta } from './types';

const cols: ColumnMeta[] = [
  { name: 'id', type_name: 'int4' },
  { name: 'name', type_name: 'text' },
  { name: 'total', type_name: 'numeric' },
];
const row = (p: Partial<FilterRow>): FilterRow => ({ ...newFilterRow('id'), ...p });

describe('filter rows → conditions', () => {
  it('parses typed values for a column', () => {
    expect(toCondition(row({ column: 'id', op: 'eq', value: '4' }), cols)).toEqual({ column: 'id', op: 'eq', value: { t: 'int', v: 4 }, values: [] });
    expect(toCondition(row({ column: 'total', op: 'gt', value: '10.50' }), cols).value).toEqual({ t: 'decimal', v: '10.50' });
  });

  it('keeps text operators as text and lists for IN / NOT IN', () => {
    expect(toCondition(row({ column: 'id', op: 'contains', value: '12' }), cols).value).toEqual({ t: 'text', v: '12' });
    expect(toCondition(row({ column: 'id', op: 'not_in', value: "1, 2 ,3" }), cols).values).toEqual([{ t: 'int', v: 1 }, { t: 'int', v: 2 }, { t: 'int', v: 3 }]);
    expect(splitList("'a', 'it''s', b ,")).toEqual(['a', "it's", 'b']);
  });

  it('BETWEEN sends both bounds; null operators send no value', () => {
    expect(toCondition(row({ column: 'id', op: 'between', value: '1', value2: '9' }), cols).values).toEqual([{ t: 'int', v: 1 }, { t: 'int', v: 9 }]);
    expect(toCondition(row({ column: 'name', op: 'is_null' }), cols)).toEqual({ column: 'name', op: 'is_null', values: [] });
  });

  it('Any column searches every column as text', () => {
    const c = toCondition(row({ column: ANY_COLUMN, op: 'contains', value: 'ada' }), cols);
    expect(c).toEqual({ column: '', any_columns: ['id', 'name', 'total'], op: 'contains', value: { t: 'text', v: 'ada' }, values: [] });
    expect(toCondition(row({ column: ANY_COLUMN, op: 'eq', value: '4' }), cols).value).toEqual({ t: 'text', v: '4' });
  });

  it('Raw SQL becomes a raw condition with the trimmed expression', () => {
    expect(toCondition(row({ column: RAW_SQL, value: '  age > 3 ' }), cols)).toEqual({ column: '', op: 'raw', value: { t: 'text', v: 'age > 3' }, values: [] });
  });

  it('only enabled, complete rows are applied', () => {
    const rows = [
      row({ column: 'id', op: 'eq', value: '1' }),
      row({ column: 'id', op: 'eq', value: '2', enabled: false }),
      row({ column: 'id', op: 'between', value: '1', value2: '' }),
      row({ column: RAW_SQL, value: '   ' }),
      row({ column: 'name', op: 'is_not_null' }),
    ];
    expect(rows.map(rowIsComplete)).toEqual([true, true, false, false, true]);
    expect(toConditions(rows, cols).map((c) => c.op)).toEqual(['eq', 'is_not_null']);
  });

  it('throws for unknown columns instead of sending them', () => {
    expect(() => toCondition(row({ column: 'nope', value: 'x' }), cols)).toThrow(/Unknown column/);
  });

  it('insert/remove/update rows', () => {
    const a = row({ column: 'name' });
    const { rows, id } = insertRowAfter([a]);
    expect(rows).toHaveLength(2);
    expect(rows[1].id).toBe(id);
    expect(rows[1].column).toBe('name');
    expect(removeRow(rows, a.id).map((r) => r.id)).toEqual([id]);
    const any = updateRow(rows, a.id, { column: ANY_COLUMN });
    expect(any[0].op).toBe('contains');
    const raw = updateRow([{ ...a, column: RAW_SQL, value: 'x = 1' }], a.id, { column: 'id' });
    expect(raw[0].value).toBe('');
  });
});

describe('table workspace store (filter API)', () => {
  beforeEach(() => {
    useTableWs.setState({ tabs: {} });
  });

  it('addFilter opens the bar, adds a row and requests apply', () => {
    const ws = useTableWs.getState();
    const id = ws.addFilter('t1', { column: 'name', op: 'eq', value: 'Ada' });
    const st = selectTab('t1')(useTableWs.getState());
    expect(st.filterOpen).toBe(true);
    expect(st.rows).toHaveLength(1);
    expect(st.rows[0]).toMatchObject({ id, column: 'name', op: 'eq', value: 'Ada', enabled: true });
    expect(st.applySeq).toBe(1);
    ws.addFilter('t1', { column: 'id', op: 'is_null' }, { apply: false });
    expect(selectTab('t1')(useTableWs.getState()).applySeq).toBe(1);
    expect(selectTab('t1')(useTableWs.getState()).rows).toHaveLength(2);
    ws.addFilter('t1', { column: 'id', op: 'raw', value: 'id > 3' }, { replace: true });
    expect(selectTab('t1')(useTableWs.getState()).rows.map((r) => r.column)).toEqual([RAW_SQL]);
  });

  it('filters are per tab and dropped with the tab', () => {
    const ws = useTableWs.getState();
    ws.addFilter('a', { column: 'x', op: 'eq', value: '1' });
    ws.toggleFilterBar('b');
    expect(selectTab('b')(useTableWs.getState()).rows).toHaveLength(1);
    expect(selectTab('a')(useTableWs.getState()).rows[0].column).toBe('x');
    ws.drop('a');
    expect(selectTab('a')(useTableWs.getState()).rows).toEqual([]);
  });

  it('quick filter replaces empty placeholder rows', () => {
    const ws = useTableWs.getState();
    ws.toggleFilterBar('t');
    ws.addFilter('t', { column: 'name', op: 'contains', value: 'a' });
    expect(selectTab('t')(useTableWs.getState()).rows).toHaveLength(1);
  });
});
