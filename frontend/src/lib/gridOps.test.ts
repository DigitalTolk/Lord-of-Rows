import { describe, expect, it } from 'vitest';
import { canSetValue, comboOf, gridKeyFor, nowValue, pasteValue, planPaste, quickFilters, setValueFor, shortcutLabel, type CellContext } from './gridOps';
import * as S from './gridSelection';
import type { ColumnMeta, Value } from './types';

const col = (name: string, type_name: string, nullable?: boolean): ColumnMeta => ({ name, type_name, nullable });
const ctx = (c: ColumnMeta, value: Value, inserted = false, nullable?: boolean): CellContext => ({ col: c, value, inserted, nullable });

describe('Set Value', () => {
  it('offers choices that fit the column', () => {
    const text = ctx(col('name', 'text'), { t: 'text', v: 'x' });
    expect(canSetValue('null', text)).toBe(true);
    expect(canSetValue('empty', text)).toBe(true);
    expect(canSetValue('default', text)).toBe(false);
    expect(canSetValue('true', text)).toBe(false);
    expect(canSetValue('now', text)).toBe(false);
    const n = ctx(col('n', 'int4'), { t: 'int', v: 1 }, true, false);
    expect(canSetValue('null', n)).toBe(false); // NOT NULL
    expect(canSetValue('empty', n)).toBe(false);
    expect(canSetValue('default', n)).toBe(true); // new row
    expect(canSetValue('true', ctx(col('b', 'boolean'), { t: 'null' }))).toBe(true);
    expect(canSetValue('now', ctx(col('d', 'timestamptz'), { t: 'null' }))).toBe(true);
  });

  it('DEFAULT is "omit the column", NULL and empty string differ', () => {
    const c = ctx(col('a', 'text'), { t: 'null' }, true);
    expect(setValueFor('default', c)).toBeUndefined();
    expect(setValueFor('null', c)).toEqual({ t: 'null' });
    expect(setValueFor('empty', c)).toEqual({ t: 'text', v: '' });
  });

  it('now() per temporal kind', () => {
    const d = new Date(2024, 0, 2, 3, 4, 5);
    expect(nowValue('date', d)).toEqual({ t: 'date', v: '2024-01-02' });
    expect(nowValue('time', d)).toEqual({ t: 'time', v: '03:04:05' });
    expect(nowValue('ts', d)).toEqual({ t: 'timestamp', v: { iso: '2024-01-02T03:04:05', tz: false } });
    const tz = nowValue('tstz', new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 678)));
    expect(tz).toEqual({ t: 'timestamp', v: { iso: '2024-01-02T03:04:05Z', tz: true } });
  });
});

describe('Quick Filter', () => {
  it('NULL cells only offer IS NULL / IS NOT NULL', () => {
    expect(quickFilters(col('a', 'text'), { t: 'null' }).map((q) => q.cond.op)).toEqual(['is_null', 'is_not_null']);
  });
  it('values travel as typed parameters, not SQL text', () => {
    const qs = quickFilters(col('name', 'text'), { t: 'text', v: "O'Brien" });
    expect(qs.map((q) => q.cond.op)).toEqual(['eq', 'ne', 'gt', 'lt', 'contains', 'is_not_null', 'is_null']);
    expect(qs[0].cond).toEqual({ column: 'name', op: 'eq', value: { t: 'text', v: "O'Brien" }, values: [] });
    expect(qs[0].label).toBe("= 'O'Brien'");
    expect(qs[4].cond.value).toEqual({ t: 'text', v: "O'Brien" });
    expect(qs[4].label).toBe("LIKE '%O'Brien%'");
  });
  it('big integers keep their exact value', () => {
    const [eq] = quickFilters(col('id', 'int8'), { t: 'big_int', v: '9007199254740993' });
    expect(eq.cond.value).toEqual({ t: 'big_int', v: '9007199254740993' });
    expect(eq.label).toBe('= 9007199254740993');
  });
  it('JSON has no equality filters; booleans no ranges', () => {
    expect(quickFilters(col('j', 'json'), { t: 'json', v: {} }).map((q) => q.cond.op)).toEqual(['is_not_null', 'is_null']);
    expect(quickFilters(col('b', 'bool'), { t: 'bool', v: true }).map((q) => q.cond.op)).toEqual(['eq', 'ne', 'is_not_null', 'is_null']);
  });
});

describe('paste', () => {
  const sel = (r0: number, c0: number, r1: number, c1: number) => S.extendTo(S.single({ r: r0, c: c0 }), { r: r1, c: c1 });

  it('a block is placed at the top-left of the selection and clipped to the grid', () => {
    const p = planPaste([['a', 'b'], ['c', 'd']], S.single({ r: 4, c: 2 }), 'block', 5, 3);
    expect(p.targets).toEqual([{ r: 4, c: 2, text: 'a' }]);
    expect(p.clipped).toBe(true);
  });
  it('a single value fills every selected cell', () => {
    const p = planPaste([['x']], sel(0, 0, 1, 1), 'block', 10, 10);
    expect(p.targets.map((t) => `${t.r}:${t.c}=${t.text}`)).toEqual(['0:0=x', '0:1=x', '1:0=x', '1:1=x']);
  });
  it('paste to selected cells tiles the block over the selection only', () => {
    const p = planPaste([['1', '2']], sel(0, 0, 1, 2), 'selected', 10, 10);
    expect(p.targets.map((t) => t.text)).toEqual(['1', '2', '1', '1', '2', '1']);
  });
  it('converts per column type; refuses text that does not fit', () => {
    expect(pasteValue('NULL', col('a', 'text'))).toEqual({ value: { t: 'null' } });
    expect(pasteValue('', col('a', 'text'))).toEqual({ value: { t: 'text', v: '' } });
    expect(pasteValue('', col('n', 'int4'))).toEqual({ value: { t: 'null' } });
    expect(pasteValue('12345678901234567890', col('n', 'int8'))).toEqual({ value: { t: 'big_int', v: '12345678901234567890' } });
    expect(pasteValue('abc', col('n', 'int4'))).toEqual({ invalid: true });
    expect(pasteValue('yes', col('b', 'boolean'))).toEqual({ value: { t: 'bool', v: true } });
    expect(pasteValue('maybe', col('b', 'boolean'))).toEqual({ invalid: true });
    expect(pasteValue('1.50', col('p', 'numeric(10,2)'))).toEqual({ value: { t: 'decimal', v: '1.50' } });
  });
});

describe('shortcuts', () => {
  const ev = (key: string, code: string, m: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });
  it('uses the physical key so ⌥⌘R works on macOS', () => {
    expect(gridKeyFor(ev('®', 'KeyR', { metaKey: true, altKey: true }), true)).toBe('refresh');
    expect(gridKeyFor(ev('r', 'KeyR', { ctrlKey: true, altKey: true }), false)).toBe('refresh');
    expect(gridKeyFor(ev('r', 'KeyR', { metaKey: true }), true)).toBeNull();
  });
  it('maps the menu shortcuts', () => {
    expect(gridKeyFor(ev('Enter', 'Enter', { metaKey: true }), true)).toBe('quickLook');
    expect(gridKeyFor(ev('Enter', 'Enter', { altKey: true }), true)).toBe('setValue');
    expect(gridKeyFor(ev('C', 'KeyC', { metaKey: true, shiftKey: true }), true)).toBe('copyCells');
    expect(gridKeyFor(ev('c', 'KeyC', { ctrlKey: true }), false)).toBe('copyRows');
    expect(gridKeyFor(ev('Delete', 'Delete'), true)).toBe('delete');
    expect(gridKeyFor(ev('Backspace', 'Backspace', { shiftKey: true }), true)).toBeNull();
    expect(comboOf(ev('v', 'KeyV', { metaKey: true, shiftKey: true }), true)).toBe('Mod+Shift+V');
  });
  it('labels per platform', () => {
    expect(shortcutLabel('Mod+Alt+R', true)).toBe('⌥⌘R');
    expect(shortcutLabel('Mod+Shift+C', true)).toBe('⇧⌘C');
    expect(shortcutLabel('Mod+Enter', true)).toBe('⌘↩');
    expect(shortcutLabel('Mod+Alt+R', false)).toBe('Ctrl+Alt+R');
  });
});
