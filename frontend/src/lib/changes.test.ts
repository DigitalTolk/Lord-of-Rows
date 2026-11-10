import { describe, expect, it } from 'vitest';
import { addRow, buildChanges, emptyStaged, History, pendingCount, setCell, toggleDelete } from './changes';
import { parseInput, displayValue } from './value';
import type { ColumnMeta, Value } from './types';

const cols: ColumnMeta[] = [
  { name: 'id', type_name: 'int4' },
  { name: 'name', type_name: 'text' },
];
const rows: Value[][] = [
  [{ t: 'int', v: 1 }, { t: 'text', v: 'a' }],
  [{ t: 'int', v: 2 }, { t: 'null' }],
];

describe('staged changes', () => {
  it('tracks edits and reverts to original', () => {
    let s = setCell(emptyStaged(), 0, 'name', { t: 'text', v: 'b' }, rows[0][1]);
    expect(pendingCount(s)).toBe(1);
    s = setCell(s, 0, 'name', { t: 'text', v: 'a' }, rows[0][1]);
    expect(pendingCount(s)).toBe(0);
  });

  it('builds update with original values for concurrency checks', () => {
    const s = setCell(emptyStaged(), 1, 'name', { t: 'text', v: '' }, rows[1][1]);
    const ch = buildChanges(s, cols, rows, ['id']);
    expect(ch).toEqual([
      { op: 'update', key: [['id', { t: 'int', v: 2 }]], original: [['name', { t: 'null' }]], changes: [['name', { t: 'text', v: '' }]] },
    ]);
  });

  it('deleted rows skip their edits; inserts are appended', () => {
    let s = setCell(emptyStaged(), 0, 'name', { t: 'text', v: 'x' }, rows[0][1]);
    s = toggleDelete(s, [0]);
    s = addRow(s, { id: { t: 'int', v: 3 } });
    const ch = buildChanges(s, cols, rows, ['id']);
    expect(ch.map((c) => c.op)).toEqual(['delete', 'insert']);
  });

  it('refuses keyless updates', () => {
    const s = toggleDelete(emptyStaged(), [0]);
    expect(() => buildChanges(s, cols, rows, [])).toThrow(/primary key/);
    expect(buildChanges(addRow(emptyStaged()), cols, rows, [])).toHaveLength(1);
  });

  it('undo/redo', () => {
    const h = new History<number>();
    h.push(1);
    h.push(2);
    expect(h.undo(3)).toBe(2);
    expect(h.redo(2)).toBe(3);
  });
});

describe('value parsing', () => {
  it('keeps big integers and decimals exact', () => {
    expect(parseInput('9007199254740993', { name: 'x', type_name: 'int8' })).toEqual({ t: 'big_int', v: '9007199254740993' });
    expect(parseInput('42', { name: 'x', type_name: 'int4' })).toEqual({ t: 'int', v: 42 });
    expect(parseInput('0.1000000000000000055511151231257827', { name: 'x', type_name: 'numeric' })).toEqual({ t: 'decimal', v: '0.1000000000000000055511151231257827' });
  });
  it('empty string stays text, not null', () => {
    expect(parseInput('', { name: 'x', type_name: 'text' })).toEqual({ t: 'text', v: '' });
  });
  it('timestamps keep tz flag', () => {
    expect(parseInput('2024-01-01T00:00:00Z', { name: 'x', type_name: 'timestamptz' })).toEqual({ t: 'timestamp', v: { iso: '2024-01-01T00:00:00Z', tz: true } });
  });
  it('displays values', () => {
    expect(displayValue({ t: 'bytes', v: { hex: 'dead', len: 2, truncated: false } })).toBe('\\xdead (2 B)');
    expect(displayValue({ t: 'array', v: [{ t: 'int', v: 1 }, { t: 'null' }] })).toBe('{1,NULL}');
  });
});
