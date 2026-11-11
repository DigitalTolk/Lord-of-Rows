import { describe, expect, it } from 'vitest';
import * as S from './gridSelection';

describe('grid selection', () => {
  it('click, shift-extend, and row/column sets', () => {
    let s = S.single({ r: 2, c: 1 });
    s = S.extendTo(s, { r: 0, c: 3 });
    expect(S.selectedRows(s)).toEqual([0, 1, 2]);
    expect(S.selectedCols(s)).toEqual([1, 2, 3]);
    expect(S.contains(s, 1, 2)).toBe(true);
    expect(S.contains(s, 1, 0)).toBe(false);
    expect(S.topLeft(s)).toEqual({ r: 0, c: 1 });
  });

  it('cmd-click adds and removes cells (splitting ranges)', () => {
    let s: S.Selection | null = S.single({ r: 0, c: 0 });
    s = S.toggleCell(s, { r: 5, c: 5 });
    expect(S.selectedCells(s)).toEqual([{ r: 0, c: 0 }, { r: 5, c: 5 }]);
    s = S.extendTo(S.single({ r: 0, c: 0 }), { r: 2, c: 2 });
    s = S.toggleCell(s, { r: 1, c: 1 });
    expect(S.selectedCells(s).length).toBe(8);
    expect(S.contains(s, 1, 1)).toBe(false);
    expect(S.toggleCell(S.single({ r: 0, c: 0 }), { r: 0, c: 0 })).toBeNull();
  });

  it('row selection and toggling', () => {
    let s: S.Selection | null = S.selectRows(1, 3, 4);
    expect(S.selectedCells(s).length).toBe(12);
    s = S.toggleRow(s, 2, 4);
    expect(S.selectedRows(s)).toEqual([1, 3]);
    s = S.toggleRow(s, 7, 4);
    expect(S.selectedRows(s)).toEqual([1, 3, 7]);
    expect(S.rowTouched(s, 7)).toBe(true);
  });

  it('select all and clamping after rows disappear', () => {
    const s = S.selectAll(10, 3);
    expect(S.selectedRows(S.clamp(s, 4, 3))).toEqual([0, 1, 2, 3]);
    expect(S.clamp(S.single({ r: 9, c: 0 }), 4, 3)).toBeNull();
    expect(S.selectAll(0, 3)).toBeNull();
  });
});
