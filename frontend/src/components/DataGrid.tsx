import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ColumnMeta, SortDir, Value } from '../lib/types';
import { displayValue, editableText, isNull, isNumeric, parseInput } from '../lib/value';
import type { StagedState } from '../lib/changes';
import type { QuickFilter } from '../lib/filters';
import { CellEditor } from './CellEditor';

export interface GridProps {
  columns: ColumnMeta[];
  rows: Value[][];
  staged?: StagedState;
  editable?: boolean;
  sort?: [string, SortDir][];
  onSort?: (col: string, additive: boolean) => void;
  onEdit?: (row: number, col: string, v: Value) => void;
  onEditInserted?: (i: number, col: string, v: Value) => void;
  onSelectRows?: (rows: number[]) => void;
  onCopy?: (rows: number[], cols: string[]) => void;
  /**
   * Quick Filter hook for the context menu: adds a filter row to the table tab's
   * filter bar and applies it (see lib/tableWorkspace.ts `addFilter`).
   */
  onQuickFilter?: (f: QuickFilter) => void;
  ariaLabel?: string;
}

const ROW_H = 23;
const MIN_W = 60;

interface Sel {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

/**
 * Virtualized spreadsheet grid. Only visible rows are in the DOM, so 100k+
 * rows scroll smoothly. Inserted (staged) rows are appended after `rows`.
 */
export function DataGrid(p: GridProps) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [order, setOrder] = useState<number[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [frozen, setFrozen] = useState(0);
  const [sel, setSel] = useState<Sel | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; big?: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; col?: number } | null>(null);
  const dragCol = useRef<number | null>(null);

  useEffect(() => {
    setOrder(p.columns.map((_, i) => i));
    setSel(null);
  }, [p.columns]);

  const inserted = useMemo(() => p.staged?.inserted ?? [], [p.staged]);
  const total = p.rows.length + inserted.length;
  const visibleCols = useMemo(() => order.filter((i) => p.columns[i] && !hidden.has(p.columns[i].name)), [order, hidden, p.columns]);
  // Auto-size from header + a sample of cell contents (monospace ~7.2px/char).
  const autoWidths = useMemo(() => {
    const sample = p.rows.slice(0, 60);
    return p.columns.map((c, i) => {
      let len = c.name.length + 2;
      for (const r of sample) len = Math.max(len, Math.min(60, displayValue(r[i] ?? { t: 'null' }).length));
      return Math.min(420, Math.max(MIN_W, Math.round(len * 7.4 + 22)));
    });
  }, [p.columns, p.rows]);
  const width = (i: number) => widths[p.columns[i].name] ?? autoWidths[i];
  const left = useMemo(() => {
    const l: number[] = [];
    let x = 48;
    for (const c of visibleCols) {
      l.push(x);
      x += width(c);
    }
    return l;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleCols, widths]);

  const virt = useVirtualizer({ count: total, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 20 });

  const cellValue = useCallback(
    (r: number, ci: number): { v: Value; edited: boolean } => {
      const col = p.columns[ci].name;
      if (r >= p.rows.length) {
        const v = inserted[r - p.rows.length]?.[col];
        return { v: v ?? { t: 'null' }, edited: v !== undefined };
      }
      const e = p.staged?.edits[r]?.[col];
      return e ? { v: e, edited: true } : { v: p.rows[r][ci], edited: false };
    },
    [p.columns, p.rows, p.staged, inserted],
  );

  const selectedRows = useMemo(() => {
    if (!sel) return [];
    const a = Math.min(sel.r0, sel.r1);
    const b = Math.max(sel.r0, sel.r1);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }, [sel]);
  useEffect(() => {
    p.onSelectRows?.(selectedRows);
  }, [selectedRows]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedCols = () => {
    if (!sel) return [];
    const a = Math.min(sel.c0, sel.c1);
    const b = Math.max(sel.c0, sel.c1);
    return visibleCols.slice(a, b + 1).map((i) => p.columns[i].name);
  };

  const commitEdit = (r: number, ci: number, text: string | null) => {
    const col = p.columns[ci];
    const orig = r < p.rows.length ? p.rows[r][ci] : undefined;
    const v: Value = text === null ? { t: 'null' } : parseInput(text, col, orig);
    if (r >= p.rows.length) p.onEditInserted?.(r - p.rows.length, col.name, v);
    else p.onEdit?.(r, col.name, v);
    setEditing(null);
    scroller.current?.focus();
  };

  const canEditRow = (r: number) => p.editable && !(p.staged?.deleted ?? []).includes(r);

  const onKey = (e: React.KeyboardEvent) => {
    if (editing) return;
    if (!sel) {
      if (e.key.startsWith('Arrow') && total > 0) setSel({ r0: 0, c0: 0, r1: 0, c1: 0 });
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    const move = (dr: number, dc: number) => {
      const r = Math.max(0, Math.min(total - 1, sel.r1 + dr));
      const c = Math.max(0, Math.min(visibleCols.length - 1, sel.c1 + dc));
      setSel(e.shiftKey ? { ...sel, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c });
      virt.scrollToIndex(r);
    };
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); return move(mod ? total : 1, 0);
      case 'ArrowUp': e.preventDefault(); return move(mod ? -total : -1, 0);
      case 'ArrowRight': e.preventDefault(); return move(0, mod ? visibleCols.length : 1);
      case 'ArrowLeft': e.preventDefault(); return move(0, mod ? -visibleCols.length : -1);
      case 'PageDown': e.preventDefault(); return move(20, 0);
      case 'PageUp': e.preventDefault(); return move(-20, 0);
      case 'Tab': e.preventDefault(); return move(0, e.shiftKey ? -1 : 1);
      case 'Enter':
      case 'F2':
        if (canEditRow(sel.r1)) {
          e.preventDefault();
          setEditing({ r: sel.r1, c: visibleCols[sel.c1] });
        }
        return;
      case 'Delete':
      case 'Backspace':
        if (canEditRow(sel.r1) && e.shiftKey) {
          e.preventDefault();
          commitEdit(sel.r1, visibleCols[sel.c1], null);
        }
        return;
      case 'c':
        if (mod) {
          e.preventDefault();
          p.onCopy?.(selectedRows, selectedCols());
        }
        return;
      case 'a':
        if (mod) {
          e.preventDefault();
          setSel({ r0: 0, c0: 0, r1: total - 1, c1: visibleCols.length - 1 });
        }
        return;
    }
  };

  const startResize = (e: React.MouseEvent, ci: number) => {
    e.preventDefault();
    e.stopPropagation();
    const name = p.columns[ci].name;
    const startX = e.clientX;
    const startW = width(ci);
    const onMove = (m: MouseEvent) => setWidths((w) => ({ ...w, [name]: Math.max(MIN_W, startW + m.clientX - startX) }));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const totalWidth = (left[left.length - 1] ?? 48) + (visibleCols.length ? width(visibleCols[visibleCols.length - 1]) : 0);
  const sortOf = (name: string) => p.sort?.find(([c]) => c === name)?.[1];
  const inSel = (r: number, vc: number) =>
    sel && r >= Math.min(sel.r0, sel.r1) && r <= Math.max(sel.r0, sel.r1) && vc >= Math.min(sel.c0, sel.c1) && vc <= Math.max(sel.c0, sel.c1);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        tabIndex={0}
        role="grid"
        aria-label={p.ariaLabel ?? 'Data grid'}
        aria-rowcount={total + 1}
        aria-colcount={visibleCols.length}
        onKeyDown={onKey}
        className="min-h-0 flex-1 overflow-auto bg-bg font-mono text-[0.9em] outline-none"
      >
        <div style={{ width: totalWidth, height: virt.getTotalSize() + ROW_H, position: 'relative' }}>
          {/* header */}
          <div role="row" aria-rowindex={1} className="sticky top-0 z-20 flex border-b border-border bg-panel" style={{ height: ROW_H, width: totalWidth }}>
            <div className="sticky left-0 z-30 w-12 shrink-0 border-r border-border bg-panel" />
            {visibleCols.map((ci, vc) => {
              const c = p.columns[ci];
              const s = sortOf(c.name);
              const isFrozen = vc < frozen;
              return (
                <div
                  key={c.name + ci}
                  role="columnheader"
                  aria-sort={s === 'asc' ? 'ascending' : s === 'desc' ? 'descending' : 'none'}
                  draggable
                  onDragStart={() => (dragCol.current = vc)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragCol.current === null) return;
                    const vis = [...visibleCols];
                    const [m] = vis.splice(dragCol.current, 1);
                    vis.splice(vc, 0, m);
                    setOrder([...vis, ...order.filter((o) => !vis.includes(o))]);
                    dragCol.current = null;
                  }}
                  onClick={(e) => p.onSort?.(c.name, e.shiftKey)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, col: ci });
                  }}
                  title={`${c.name} : ${c.type_name}`}
                  className={`relative flex shrink-0 cursor-default select-none items-center gap-1 truncate border-r border-border px-2 font-sans text-[0.92rem] font-semibold hover:bg-hover ${isFrozen ? 'sticky z-20 bg-panel' : ''}`}
                  style={{ width: width(ci), left: isFrozen ? left[vc] : undefined }}
                >
                  <span className="truncate">{c.name}</span>
                  {s && <span aria-hidden className="ml-auto text-[0.7em] text-accent">{s === 'asc' ? '▲' : '▼'}</span>}
                  <span className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize" onMouseDown={(e) => startResize(e, ci)} onClick={(e) => e.stopPropagation()} aria-hidden />
                </div>
              );
            })}
          </div>
          {virt.getVirtualItems().map((vr) => {
            const r = vr.index;
            const deleted = (p.staged?.deleted ?? []).includes(r);
            const isNew = r >= p.rows.length;
            return (
              <div
                key={vr.key}
                role="row"
                aria-rowindex={r + 2}
                className={`absolute left-0 flex border-b border-border/40 ${deleted ? 'bg-danger/10 line-through' : isNew ? 'bg-ok/10' : r % 2 ? 'bg-panel/60' : 'bg-bg'}`}
                style={{ top: vr.start + ROW_H, height: ROW_H, width: totalWidth }}
              >
                <div role="rowheader" className="sticky left-0 z-10 w-12 shrink-0 border-r border-border bg-panel pr-2 text-right text-[0.85em] leading-[23px] text-muted" onClick={() => setSel({ r0: r, c0: 0, r1: r, c1: visibleCols.length - 1 })}>
                  {isNew ? '+' : r + 1}
                </div>
                {visibleCols.map((ci, vc) => {
                  const { v, edited } = cellValue(r, ci);
                  const isFrozen = vc < frozen;
                  const selected = inSel(r, vc);
                  const isEditing = editing?.r === r && editing.c === ci && !editing.big;
                  return (
                    <div
                      key={ci}
                      role="gridcell"
                      aria-selected={!!selected}
                      className={`shrink-0 truncate border-r border-border/40 px-2 leading-[23px] ${isNumeric(v) ? 'text-right tabular-nums' : ''} ${edited ? 'bg-warn/20' : ''} ${selected ? '!bg-select/20' : ''} ${isFrozen ? 'sticky z-[5] bg-inherit' : ''}`}
                      style={{ width: width(ci), left: isFrozen ? left[vc] : undefined }}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        setSel(e.shiftKey && sel ? { ...sel, r1: r, c1: vc } : { r0: r, c0: vc, r1: r, c1: vc });
                      }}
                      onDoubleClick={() => canEditRow(r) && setEditing({ r, c: ci, big: v.t === 'json' || (v.t === 'text' && (v.v.length > 200 || v.v.includes('\n'))) })}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (!inSel(r, vc)) setSel({ r0: r, c0: vc, r1: r, c1: vc });
                        setMenu({ x: e.clientX, y: e.clientY });
                      }}
                      title={isNull(v) ? 'NULL' : displayValue(v).slice(0, 500)}
                    >
                      {isEditing ? (
                        <InlineEditor initial={editableText(v)} onDone={(text) => commitEdit(r, ci, text)} onCancel={() => setEditing(null)} />
                      ) : isNull(v) ? (
                        <span className="cell-null">NULL</span>
                      ) : v.t === 'text' && v.v === '' ? (
                        <span className="text-muted/60" aria-label="empty string">''</span>
                      ) : (
                        displayValue(v)
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {editing?.big && (
        <CellEditor
          column={p.columns[editing.c]}
          value={cellValue(editing.r, editing.c).v}
          readOnly={!canEditRow(editing.r)}
          onSave={(v) => {
            if (editing.r >= p.rows.length) p.onEditInserted?.(editing.r - p.rows.length, p.columns[editing.c].name, v);
            else p.onEdit?.(editing.r, p.columns[editing.c].name, v);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {menu && (
        <div role="menu" className="fixed z-50 w-56 rounded-lg border border-border bg-raised p-1 font-sans shadow-xl" style={{ left: menu.x, top: menu.y }} onMouseLeave={() => setMenu(null)}>
          {menu.col !== undefined ? (
            <>
              <MenuItem onClick={() => { setHidden((h) => new Set([...h, p.columns[menu.col!].name])); setMenu(null); }}>{t('grid.hideColumn')}</MenuItem>
              <MenuItem onClick={() => { setHidden(new Set()); setMenu(null); }}>{t('grid.showAll')}</MenuItem>
              <MenuItem onClick={() => { setFrozen(visibleCols.indexOf(menu.col!) + 1); setMenu(null); }}>Freeze up to here</MenuItem>
              <MenuItem onClick={() => { setFrozen(0); setMenu(null); }}>Unfreeze columns</MenuItem>
            </>
          ) : (
            <>
              <MenuItem onClick={() => { p.onCopy?.(selectedRows, selectedCols()); setMenu(null); }}>{t('common.copy')}</MenuItem>
              {sel && canEditRow(sel.r1) && (
                <>
                  <MenuItem onClick={() => { setEditing({ r: sel.r1, c: visibleCols[sel.c1], big: true }); setMenu(null); }}>{t('grid.editCell')}</MenuItem>
                  <MenuItem onClick={() => { commitEdit(sel.r1, visibleCols[sel.c1], null); setMenu(null); }}>{t('grid.setNull')}</MenuItem>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return <button role="menuitem" className="menu-item" onClick={onClick}>{children}</button>;
}

function InlineEditor({ initial, onDone, onCancel }: { initial: string; onDone: (t: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  return (
    <input
      className="h-full w-full bg-raised px-0 font-mono outline outline-2 outline-accent"
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onDone(v)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onDone(v);
        if (e.key === 'Escape') onCancel();
      }}
    />
  );
}
