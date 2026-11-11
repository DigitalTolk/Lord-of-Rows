// Pure cell-range selection model for the data grid. Rows are data row indices
// (inserted rows follow loaded rows); columns are *visual* column positions.
// A selection is a list of rectangles plus an anchor (where Shift-extension
// starts) and a focus (the active cell, moved by the arrow keys).

export interface Cell {
  r: number;
  c: number;
}
export interface Range {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}
export interface Selection {
  ranges: Range[];
  anchor: Cell;
  focus: Cell;
}

const norm = (g: Range): Range => ({ r0: Math.min(g.r0, g.r1), r1: Math.max(g.r0, g.r1), c0: Math.min(g.c0, g.c1), c1: Math.max(g.c0, g.c1) });
const inRange = (g: Range, r: number, c: number) => {
  const n = norm(g);
  return r >= n.r0 && r <= n.r1 && c >= n.c0 && c <= n.c1;
};

export function single(cell: Cell): Selection {
  return { ranges: [{ r0: cell.r, c0: cell.c, r1: cell.r, c1: cell.c }], anchor: cell, focus: cell };
}

/** Shift+click / Shift+arrow / drag: the last range spans anchor → cell. */
export function extendTo(sel: Selection | null, cell: Cell): Selection {
  if (!sel) return single(cell);
  const last: Range = { r0: sel.anchor.r, c0: sel.anchor.c, r1: cell.r, c1: cell.c };
  return { ranges: [...sel.ranges.slice(0, -1), last], anchor: sel.anchor, focus: cell };
}

/** Cmd/Ctrl+click: add the cell, or remove it when it is already selected. */
export function toggleCell(sel: Selection | null, cell: Cell): Selection | null {
  if (!sel) return single(cell);
  if (!contains(sel, cell.r, cell.c)) {
    return { ranges: [...sel.ranges, { r0: cell.r, c0: cell.c, r1: cell.r, c1: cell.c }], anchor: cell, focus: cell };
  }
  const ranges = sel.ranges.flatMap((g) => (inRange(g, cell.r, cell.c) ? subtract(norm(g), cell) : [g]));
  return ranges.length ? { ranges, anchor: cell, focus: cell } : null;
}

/** A rectangle minus one cell inside it, as up to four rectangles. */
export function subtract(g: Range, cell: Cell): Range[] {
  const out: Range[] = [];
  if (cell.r > g.r0) out.push({ r0: g.r0, r1: cell.r - 1, c0: g.c0, c1: g.c1 });
  if (cell.r < g.r1) out.push({ r0: cell.r + 1, r1: g.r1, c0: g.c0, c1: g.c1 });
  if (cell.c > g.c0) out.push({ r0: cell.r, r1: cell.r, c0: g.c0, c1: cell.c - 1 });
  if (cell.c < g.c1) out.push({ r0: cell.r, r1: cell.r, c0: cell.c + 1, c1: g.c1 });
  return out;
}

/** Whole rows r0..r1 (row-number click / Shift+click). */
export function selectRows(r0: number, r1: number, ncols: number, anchorRow = r0): Selection {
  const last = Math.max(0, ncols - 1);
  return { ranges: [{ r0, r1, c0: 0, c1: last }], anchor: { r: anchorRow, c: 0 }, focus: { r: r1, c: 0 } };
}

/** Cmd/Ctrl+click on a row number: add or remove a whole row. */
export function toggleRow(sel: Selection | null, r: number, ncols: number): Selection | null {
  if (!sel) return selectRows(r, r, ncols);
  const full = rowFullySelected(sel, r, ncols);
  if (!full) return { ranges: [...sel.ranges, { r0: r, r1: r, c0: 0, c1: Math.max(0, ncols - 1) }], anchor: { r, c: 0 }, focus: { r, c: 0 } };
  const ranges = sel.ranges.flatMap((g) => {
    const n = norm(g);
    if (r < n.r0 || r > n.r1) return [g];
    const out: Range[] = [];
    if (r > n.r0) out.push({ ...n, r1: r - 1 });
    if (r < n.r1) out.push({ ...n, r0: r + 1 });
    return out;
  });
  return ranges.length ? { ranges, anchor: { r, c: 0 }, focus: { r, c: 0 } } : null;
}

export function selectAll(nrows: number, ncols: number): Selection | null {
  if (nrows <= 0 || ncols <= 0) return null;
  return { ranges: [{ r0: 0, c0: 0, r1: nrows - 1, c1: ncols - 1 }], anchor: { r: 0, c: 0 }, focus: { r: nrows - 1, c: ncols - 1 } };
}

export function contains(sel: Selection | null, r: number, c: number): boolean {
  return !!sel && sel.ranges.some((g) => inRange(g, r, c));
}

export function rowTouched(sel: Selection | null, r: number): boolean {
  return !!sel && sel.ranges.some((g) => r >= Math.min(g.r0, g.r1) && r <= Math.max(g.r0, g.r1));
}

function rowFullySelected(sel: Selection, r: number, ncols: number): boolean {
  for (let c = 0; c < ncols; c++) if (!contains(sel, r, c)) return false;
  return true;
}

/** Sorted, de-duplicated rows that have at least one selected cell. */
export function selectedRows(sel: Selection | null): number[] {
  if (!sel) return [];
  const set = new Set<number>();
  for (const g of sel.ranges) {
    const n = norm(g);
    for (let r = n.r0; r <= n.r1; r++) set.add(r);
  }
  return [...set].sort((a, b) => a - b);
}

/** Sorted, de-duplicated visual columns that have at least one selected cell. */
export function selectedCols(sel: Selection | null): number[] {
  if (!sel) return [];
  const set = new Set<number>();
  for (const g of sel.ranges) {
    const n = norm(g);
    for (let c = n.c0; c <= n.c1; c++) set.add(c);
  }
  return [...set].sort((a, b) => a - b);
}

/** Every selected cell once, row-major. */
export function selectedCells(sel: Selection | null): Cell[] {
  if (!sel) return [];
  const seen = new Set<string>();
  const out: Cell[] = [];
  for (const g of sel.ranges) {
    const n = norm(g);
    for (let r = n.r0; r <= n.r1; r++)
      for (let c = n.c0; c <= n.c1; c++) {
        const k = `${r}:${c}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push({ r, c });
        }
      }
  }
  return out.sort((a, b) => a.r - b.r || a.c - b.c);
}

/** Top-left of the selection's bounding box. */
export function topLeft(sel: Selection | null): Cell | null {
  if (!sel || !sel.ranges.length) return null;
  let r = Infinity;
  let c = Infinity;
  for (const g of sel.ranges) {
    const n = norm(g);
    r = Math.min(r, n.r0);
    c = Math.min(c, n.c0);
  }
  return { r, c };
}

/** Clamp a selection to a (possibly smaller) grid; null when nothing remains. */
export function clamp(sel: Selection | null, nrows: number, ncols: number): Selection | null {
  if (!sel || nrows <= 0 || ncols <= 0) return null;
  const cl = (x: number, n: number) => Math.max(0, Math.min(n - 1, x));
  const ranges = sel.ranges
    .map(norm)
    .filter((g) => g.r0 < nrows && g.c0 < ncols)
    .map((g) => ({ r0: g.r0, c0: g.c0, r1: cl(g.r1, nrows), c1: cl(g.c1, ncols) }));
  if (!ranges.length) return null;
  const fix = (p: Cell) => ({ r: cl(p.r, nrows), c: cl(p.c, ncols) });
  return { ranges, anchor: fix(sel.anchor), focus: fix(sel.focus) };
}
