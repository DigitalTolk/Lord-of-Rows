import { fmtNumber } from '../lib/format';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ColumnDef, ColumnMeta, Engine, ExportFormat, FilterOp, ForeignKeyDef, SortDir, TableTarget, Value } from '../lib/types';
import { displayValue, editableText, isNull, isNumeric, parseInput } from '../lib/value';
import type { StagedState } from '../lib/changes';
import { columnValuesText, CopyFormatError, formatRows, parseClipboard, type CopyFormat } from '../lib/copyFormats';
import { canSetValue, GRID_KEYS, gridKeyFor, pasteValue, planPaste, quickFilters, setValueFor, type CellContext, type SetValueKind } from '../lib/gridOps';
import * as S from '../lib/gridSelection';
import { isMac } from '../lib/keys';
import { errMsg, useApp } from '../store';
import { CellEditor } from './CellEditor';
import { ContextMenu, type MenuEntry, type MenuItem } from './GridContextMenu';

/** One staged cell change. `value: undefined` = DEFAULT (only for staged new rows: the column is omitted from the INSERT). */
export interface CellEdit {
  row: number;
  col: string;
  value: Value | undefined;
}

export interface GridSelectionInfo {
  rows: number[];
  columns: string[];
  focus: { row: number; col: string } | null;
}

export interface GridProps {
  columns: ColumnMeta[];
  rows: Value[][];
  staged?: StagedState;
  editable?: boolean;
  sort?: [string, SortDir][];
  onSort?: (col: string, additive: boolean) => void;
  onEdit?: (row: number, col: string, v: Value) => void;
  onEditInserted?: (i: number, col: string, v: Value) => void;
  /** Batch edits (paste, Set Value on many cells) as one undo step. Falls back to onEdit/onEditInserted. */
  onEditMany?: (edits: CellEdit[]) => void;
  onSelectRows?: (rows: number[]) => void;
  onSelectionChange?: (s: GridSelectionInfo) => void;
  /** @deprecated copying is handled by the grid itself (see lib/copyFormats). Ignored. */
  onCopy?: (rows: number[], cols: string[]) => void;
  ariaLabel?: string;
  // ---- context-menu integration (all optional; items without a handler are hidden)
  engine?: Engine;
  table?: TableTarget | null;
  /** Primary-key columns (SQL UPDATE copies). */
  keyColumns?: string[];
  columnDefs?: ColumnDef[];
  foreignKeys?: ForeignKeyDef[];
  /** False when loaded rows can't be edited (no primary key); staged new rows stay editable. */
  canEditExisting?: boolean;
  /** Shown next to "Copy All Column Values" when only part of the data is loaded. */
  partialNote?: string;
  onRefresh?: () => void;
  onAddRow?: () => void;
  onDuplicateRows?: (rows: number[]) => void;
  onDeleteRows?: (rows: number[]) => void;
  onQuickFilter?: (f: { column: string; op: FilterOp; value?: Value | null }) => void;
  onOpenForeignKey?: (fk: ForeignKeyDef, values: Value[]) => void;
  onImport?: () => void;
  onExportPage?: (format: ExportFormat) => void;
}

const ROW_H = 23;
const MIN_W = 60;

const COPY_FORMATS: { id: string; fmt: CopyFormat; header: boolean; label: string }[] = [
  { id: 'csv', fmt: 'csv', header: false, label: 'gridMenu.fmtCsv' },
  { id: 'csvh', fmt: 'csv', header: true, label: 'gridMenu.fmtCsvHeader' },
  { id: 'tsv', fmt: 'tsv', header: false, label: 'gridMenu.fmtTsv' },
  { id: 'tsvh', fmt: 'tsv', header: true, label: 'gridMenu.fmtTsvHeader' },
  { id: 'json', fmt: 'json', header: true, label: 'gridMenu.fmtJson' },
  { id: 'ins', fmt: 'sql_insert', header: true, label: 'gridMenu.fmtSqlInsert' },
  { id: 'upd', fmt: 'sql_update', header: true, label: 'gridMenu.fmtSqlUpdate' },
  { id: 'md', fmt: 'markdown', header: true, label: 'gridMenu.fmtMarkdown' },
];
const EXPORT_FORMATS: [ExportFormat, string][] = [
  ['csv', 'CSV'], ['tsv', 'TSV'], ['json', 'JSON'], ['json_lines', 'JSON Lines'], ['sql_insert', 'SQL INSERT'], ['xlsx', 'Excel (XLSX)'], ['markdown', 'Markdown'], ['xml', 'XML'],
];

const truncatedBytes = (v: Value) => v.t === 'bytes' && v.v.truncated;

/**
 * Virtualized spreadsheet grid. Only visible rows are in the DOM, so 100k+
 * rows scroll smoothly. Inserted (staged) rows are appended after `rows`.
 * Selection is a set of cell ranges (lib/gridSelection); the context menu and
 * shortcuts act on it.
 */
export function DataGrid(p: GridProps) {
  const { t } = useTranslation();
  const toast = useApp((s) => s.toast);
  const scroller = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [order, setOrder] = useState<number[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [frozen, setFrozen] = useState(0);
  const [sel, setSel] = useState<S.Selection | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; big?: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'cell' | 'header'; col?: number; openSubmenu?: string; n: number } | null>(null);
  const dragCol = useRef<number | null>(null);
  const dragging = useRef(false);
  const pendingPaste = useRef<{ mode: 'block' | 'selected'; done: boolean } | null>(null);
  const scrollToEnd = useRef(false);

  useEffect(() => {
    setOrder(p.columns.map((_, i) => i));
    setSel(null);
  }, [p.columns]);

  const inserted = useMemo(() => p.staged?.inserted ?? [], [p.staged]);
  const deletedSet = useMemo(() => new Set(p.staged?.deleted ?? []), [p.staged]);
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

  const colIndex = useCallback((name: string) => p.columns.findIndex((c) => c.name === name), [p.columns]);

  const cellValue = useCallback(
    (r: number, ci: number): { v: Value; edited: boolean; isDefault?: boolean } => {
      const col = p.columns[ci].name;
      if (r >= p.rows.length) {
        const v = inserted[r - p.rows.length]?.[col];
        return v === undefined ? { v: { t: 'null' }, edited: false, isDefault: true } : { v, edited: true };
      }
      const e = p.staged?.edits[r]?.[col];
      return e ? { v: e, edited: true } : { v: p.rows[r][ci], edited: false };
    },
    [p.columns, p.rows, p.staged, inserted],
  );

  // Keep the selection inside the grid when rows go away (commit, discard, delete of new rows).
  useEffect(() => {
    setSel((s) => S.clamp(s, total, visibleCols.length));
  }, [total, visibleCols.length]);

  useEffect(() => {
    if (!scrollToEnd.current || total === 0) return;
    scrollToEnd.current = false;
    setSel(S.single({ r: total - 1, c: 0 }));
    virt.scrollToIndex(total - 1);
    scroller.current?.focus();
  }, [total]); // eslint-disable-line react-hooks/exhaustive-deps

  const selRows = useMemo(() => S.selectedRows(sel), [sel]);
  const selVisCols = useMemo(() => S.selectedCols(sel), [sel]);
  useEffect(() => {
    p.onSelectRows?.(selRows);
    if (p.onSelectionChange) {
      const f = sel?.focus;
      const fc = f ? p.columns[visibleCols[f.c]] : undefined;
      p.onSelectionChange({ rows: selRows, columns: selVisCols.map((c) => p.columns[visibleCols[c]]?.name).filter(Boolean), focus: f && fc ? { row: f.r, col: fc.name } : null });
    }
  }, [selRows, selVisCols]); // eslint-disable-line react-hooks/exhaustive-deps

  const isInserted = (r: number) => r >= p.rows.length;
  const canEditRow = (r: number) => !!p.editable && !deletedSet.has(r) && (isInserted(r) || p.canEditExisting !== false);
  // Partially loaded binary values are never editable: saving them would write the truncated bytes.
  const canEditCell = (r: number, ci: number) => canEditRow(r) && !truncatedBytes(cellValue(r, ci).v);
  const defOf = (name: string) => p.columnDefs?.find((d) => d.name === name);
  const ctxOf = (r: number, ci: number): CellContext => ({ col: p.columns[ci], value: cellValue(r, ci).v, inserted: isInserted(r), nullable: defOf(p.columns[ci].name)?.nullable });

  const emitEdits = (edits: CellEdit[]) => {
    if (!edits.length) return;
    if (p.onEditMany) return p.onEditMany(edits);
    for (const e of edits) {
      if (e.value === undefined) continue;
      if (isInserted(e.row)) p.onEditInserted?.(e.row - p.rows.length, e.col, e.value);
      else p.onEdit?.(e.row, e.col, e.value);
    }
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

  // ------------------------------------------------------------ copy

  const writeClipboard = async (text: string, msg: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('info', msg);
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  const copy = (what: 'rows' | 'cells', fmt: CopyFormat = 'tsv', header = false) => {
    if (!sel) return;
    const cis = what === 'rows' ? visibleCols : selVisCols.map((c) => visibleCols[c]);
    let rows = selRows;
    let keys: { columns: string[]; rows: Value[][] } | undefined;
    if (fmt === 'sql_update') {
      rows = rows.filter((r) => !isInserted(r));
      const kc = p.keyColumns ?? [];
      const ki = kc.map(colIndex);
      // WHERE uses the loaded (original) key values, so edited keys still find their row.
      keys = kc.length && ki.every((i) => i >= 0) ? { columns: kc, rows: rows.map((r) => ki.map((i) => p.rows[r][i])) } : undefined;
    }
    try {
      const text = formatRows(fmt, {
        columns: cis.map((ci) => p.columns[ci]),
        rows: rows.map((r) => cis.map((ci) => cellValue(r, ci).v)),
        header,
        engine: p.engine,
        table: p.table,
        keys,
      });
      void writeClipboard(text, t('gridMenu.copied', { count: rows.length, formatted: fmtNumber(rows.length) }));
    } catch (e) {
      toast('error', e instanceof CopyFormatError ? t(e.message, e.params) : errMsg(e));
    }
  };

  const copyColumn = (ci: number) => {
    const values = Array.from({ length: total }, (_, r) => cellValue(r, ci).v);
    void writeClipboard(columnValuesText(values), t('gridMenu.copiedValues', { count: values.length, formatted: fmtNumber(values.length) }));
  };

  // ------------------------------------------------------------ edits from the menu

  const setValue = (kind: SetValueKind) => {
    const edits: CellEdit[] = [];
    for (const { r, c } of S.selectedCells(sel)) {
      const ci = visibleCols[c];
      if (ci === undefined || !canEditCell(r, ci)) continue;
      const ctx = ctxOf(r, ci);
      if (!canSetValue(kind, ctx)) continue;
      edits.push({ row: r, col: p.columns[ci].name, value: setValueFor(kind, ctx) });
    }
    emitEdits(edits);
  };

  const applyPaste = (text: string, mode: 'block' | 'selected') => {
    if (!p.editable || !sel) return;
    const { targets, clipped } = planPaste(parseClipboard(text), sel, mode, total, visibleCols.length);
    const edits: CellEdit[] = [];
    let skipped = 0;
    for (const x of targets) {
      const ci = visibleCols[x.c];
      if (!canEditCell(x.r, ci)) {
        skipped++;
        continue;
      }
      const pv = pasteValue(x.text, p.columns[ci], isInserted(x.r) ? undefined : p.rows[x.r][ci]);
      if ('invalid' in pv) skipped++;
      else edits.push({ row: x.r, col: p.columns[ci].name, value: pv.value });
    }
    emitEdits(edits);
    if (skipped) toast('error', t('gridMenu.pasteSkipped', { count: skipped, formatted: fmtNumber(skipped) }));
    else if (clipped) toast('info', t('gridMenu.pasteClipped'));
  };

  const pasteFromClipboard = async (mode: 'block' | 'selected') => {
    try {
      applyPaste(await navigator.clipboard.readText(), mode);
    } catch {
      toast('error', t('gridMenu.clipboardUnavailable'));
    }
  };

  const onPasteEvent = (e: React.ClipboardEvent) => {
    if (editing) return;
    const text = e.clipboardData.getData('text/plain');
    e.preventDefault();
    const mode = pendingPaste.current?.mode ?? 'block';
    if (pendingPaste.current) pendingPaste.current.done = true;
    applyPaste(text, mode);
  };

  const startPaste = (mode: 'block' | 'selected') => {
    // Prefer the native paste event (no permission prompt); fall back to the async clipboard API.
    const token = { mode, done: false };
    pendingPaste.current = token;
    setTimeout(() => {
      if (!token.done && pendingPaste.current === token) void pasteFromClipboard(mode);
      if (pendingPaste.current === token) pendingPaste.current = null;
    }, 80);
  };

  const addRow = () => {
    scrollToEnd.current = true;
    p.onAddRow?.();
  };

  // ------------------------------------------------------------ menu

  const focusCell = () => {
    const f = sel?.focus;
    if (!f) return null;
    const ci = visibleCols[f.c];
    return ci === undefined || f.r >= total ? null : { r: f.r, ci };
  };

  const openMenuAtFocus = (openSubmenu?: string) => {
    const fc = focusCell();
    if (!fc) return;
    virt.scrollToIndex(fc.r);
    const el = scroller.current?.querySelector(`[data-cell="${fc.r}:${fc.ci}"]`);
    const rect = (el ?? scroller.current)?.getBoundingClientRect();
    setMenu({ x: (rect?.left ?? 0) + 8, y: rect ? (el ? rect.bottom : rect.top + ROW_H) : 0, kind: 'cell', openSubmenu, n: Date.now() });
  };

  const fkFor = (name: string) => p.foreignKeys?.find((fk) => fk.columns.includes(name));
  const fkValues = (fk: ForeignKeyDef, r: number): Value[] | null => {
    const vals = fk.columns.map((c) => {
      const i = colIndex(c);
      return i >= 0 ? cellValue(r, i).v : ({ t: 'null' } as Value);
    });
    return vals.some((v) => v.t === 'null') ? null : vals;
  };

  const cellMenu = (): MenuEntry[] => {
    const fc = focusCell();
    if (!fc) return [];
    const { r, ci } = fc;
    const col = p.columns[ci];
    const v = cellValue(r, ci).v;
    const editableSel = p.editable && S.selectedCells(sel).some((x) => visibleCols[x.c] !== undefined && canEditCell(x.r, visibleCols[x.c]));
    const sep = (id: string): MenuEntry => ({ separator: true, id });
    const items: MenuEntry[] = [
      { id: 'quickLook', label: t('gridMenu.quickLook'), shortcut: GRID_KEYS.quickLook, onSelect: () => setEditing({ r, c: ci, big: true }) },
    ];
    if (p.editable) {
      const ctx = ctxOf(r, ci);
      const choice = (kind: SetValueKind, label: string, hint?: string): MenuItem => ({ id: `set-${kind}`, label, disabled: !canSetValue(kind, ctx), hint, onSelect: () => setValue(kind) });
      const sv: MenuItem[] = [choice('null', 'NULL'), choice('empty', t('gridMenu.setEmpty')), choice('default', 'DEFAULT', isInserted(r) ? undefined : t('gridMenu.defaultHint'))];
      if (canSetValue('true', ctx)) sv.push(choice('true', 'true'), choice('false', 'false'));
      if (canSetValue('now', ctx)) sv.push(choice('now', t('gridMenu.setNow')));
      items.push({ id: 'setValue', label: t('gridMenu.setValue'), shortcut: GRID_KEYS.setValue, disabled: !editableSel, items: sv });
    }
    const fk = fkFor(col.name);
    const fv = fk && fkValues(fk, r);
    if (fk && p.onOpenForeignKey) items.push({ id: 'openFk', label: t('gridMenu.openFk', { table: fk.ref_table }), disabled: !fv, onSelect: () => fv && p.onOpenForeignKey?.(fk, fv) });
    if (p.onRefresh) items.push(sep('s1'), { id: 'refresh', label: t('common.refresh'), shortcut: GRID_KEYS.refresh, onSelect: p.onRefresh });
    if (p.editable) {
      items.push(
        sep('s2'),
        { id: 'paste', label: t('gridMenu.paste'), shortcut: GRID_KEYS.paste, disabled: !editableSel, onSelect: () => void pasteFromClipboard('block') },
        { id: 'pasteSelected', label: t('gridMenu.pasteSelected'), shortcut: GRID_KEYS.pasteSelected, disabled: !editableSel, onSelect: () => void pasteFromClipboard('selected') },
      );
      if (p.onAddRow || p.onDuplicateRows) items.push(sep('s3'));
      if (p.onAddRow) items.push({ id: 'addRow', label: t('gridMenu.addRow'), shortcut: GRID_KEYS.addRow, onSelect: addRow });
      if (p.onDuplicateRows) items.push({ id: 'duplicate', label: t('gridMenu.duplicate'), shortcut: GRID_KEYS.duplicate, disabled: !selRows.length, onSelect: () => p.onDuplicateRows?.(selRows) });
    }
    const hasKey = (p.keyColumns ?? []).length > 0;
    const formats = (what: 'rows' | 'cells'): MenuItem[] =>
      COPY_FORMATS.map((f) => ({
        id: `${what}-${f.id}`,
        label: t(f.label),
        disabled: f.fmt === 'sql_update' && !hasKey,
        hint: f.fmt === 'sql_update' && !hasKey ? t('gridMenu.needsKey') : undefined,
        onSelect: () => copy(what, f.fmt, f.header),
      }));
    items.push(
      sep('s4'),
      { id: 'copyRows', label: t('gridMenu.copyRows'), shortcut: GRID_KEYS.copyRows, onSelect: () => copy('rows') },
      { id: 'copyRowsAs', label: t('gridMenu.copyRowsAs'), items: formats('rows') },
      { id: 'copyCells', label: t('gridMenu.copyCells'), shortcut: GRID_KEYS.copyCells, onSelect: () => copy('cells') },
      { id: 'copyCellsAs', label: t('gridMenu.copyCellsAs'), items: formats('cells') },
      { id: 'copyColumn', label: p.partialNote ? `${t('gridMenu.copyColumn')} (${p.partialNote})` : t('gridMenu.copyColumn'), onSelect: () => copyColumn(ci) },
    );
    if (p.onQuickFilter) {
      items.push(sep('s5'), {
        id: 'quickFilter',
        label: t('gridMenu.quickFilter'),
        items: quickFilters(col, v).map((q) => ({ id: `qf-${q.id}`, label: `${col.name} ${q.label}`, onSelect: () => p.onQuickFilter?.({ column: q.cond.column, op: q.cond.op, value: q.cond.value }) })),
      });
    }
    if (p.onImport || p.onExportPage) items.push(sep('s6'));
    if (p.onImport && p.editable) items.push({ id: 'import', label: t('gridMenu.import'), onSelect: p.onImport });
    if (p.onExportPage) items.push({ id: 'exportPage', label: t('gridMenu.exportPage'), items: EXPORT_FORMATS.map(([f, l]) => ({ id: `export-${f}`, label: `${l}…`, onSelect: () => p.onExportPage?.(f) })) });
    if (p.editable && p.onDeleteRows) {
      const n = selRows.length;
      items.push(sep('s7'), { id: 'delete', label: n > 1 ? t('gridMenu.deleteN', { count: n, formatted: fmtNumber(n) }) : t('gridMenu.delete'), shortcut: GRID_KEYS.delete, danger: true, disabled: !n, onSelect: () => p.onDeleteRows?.(selRows) });
    }
    return items;
  };

  const headerMenu = (ci: number): MenuEntry[] => [
    { id: 'hide', label: t('grid.hideColumn'), onSelect: () => setHidden((h) => new Set([...h, p.columns[ci].name])) },
    { id: 'showAll', label: t('grid.showAll'), disabled: hidden.size === 0, onSelect: () => setHidden(new Set()) },
    { separator: true, id: 'h1' },
    { id: 'freeze', label: t('gridMenu.freeze'), onSelect: () => setFrozen(visibleCols.indexOf(ci) + 1) },
    { id: 'unfreeze', label: t('gridMenu.unfreeze'), disabled: frozen === 0, onSelect: () => setFrozen(0) },
    { separator: true, id: 'h2' },
    { id: 'copyColumn', label: t('gridMenu.copyColumn'), onSelect: () => copyColumn(ci) },
  ];

  // ------------------------------------------------------------ keyboard

  const onKey = (e: React.KeyboardEvent) => {
    if (editing || e.target !== scroller.current) return;
    const action = gridKeyFor(e, isMac);
    const fc = focusCell();
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (action) {
      case 'quickLook':
        if (fc) {
          handled();
          setEditing({ r: fc.r, c: fc.ci, big: true });
        }
        return;
      case 'setValue':
        if (fc && p.editable) {
          handled();
          openMenuAtFocus('setValue');
        }
        return;
      case 'refresh':
        if (p.onRefresh) {
          handled();
          p.onRefresh();
        }
        return;
      case 'paste':
      case 'pasteSelected':
        // Don't preventDefault: the browser's native paste event delivers the text.
        if (p.editable && sel) {
          e.stopPropagation();
          startPaste(action === 'paste' ? 'block' : 'selected');
        }
        return;
      case 'addRow':
        if (p.editable && p.onAddRow) {
          handled();
          addRow();
        }
        return;
      case 'duplicate':
        if (p.editable && p.onDuplicateRows && selRows.length) {
          handled();
          p.onDuplicateRows(selRows);
        }
        return;
      case 'copyRows':
        if (sel) {
          handled();
          copy('rows');
        }
        return;
      case 'copyCells':
        if (sel) {
          handled();
          copy('cells');
        }
        return;
      case 'delete':
        if (p.editable && p.onDeleteRows && selRows.length) {
          handled();
          p.onDeleteRows(selRows);
        }
        return;
    }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      openMenuAtFocus();
      return;
    }
    if (!sel) {
      if (e.key.startsWith('Arrow') && total > 0 && visibleCols.length) setSel(S.single({ r: 0, c: 0 }));
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    const move = (dr: number, dc: number) => {
      const r = Math.max(0, Math.min(total - 1, sel.focus.r + dr));
      const c = Math.max(0, Math.min(visibleCols.length - 1, sel.focus.c + dc));
      setSel(e.shiftKey ? S.extendTo(sel, { r, c }) : S.single({ r, c }));
      virt.scrollToIndex(r);
    };
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); return move(mod ? total : 1, 0);
      case 'ArrowUp': e.preventDefault(); return move(mod ? -total : -1, 0);
      case 'ArrowRight': e.preventDefault(); return move(0, mod ? visibleCols.length : 1);
      case 'ArrowLeft': e.preventDefault(); return move(0, mod ? -visibleCols.length : -1);
      case 'PageDown': e.preventDefault(); return move(20, 0);
      case 'PageUp': e.preventDefault(); return move(-20, 0);
      case 'Tab': {
        // Tab walks cells but lets focus leave the grid at the first/last column (no keyboard trap).
        const c = sel.focus.c + (e.shiftKey ? -1 : 1);
        if (c < 0 || c >= visibleCols.length) return;
        e.preventDefault();
        setSel(S.single({ r: sel.focus.r, c }));
        return;
      }
      case 'Enter':
      case 'F2':
        if (fc && !mod && !e.altKey && canEditCell(fc.r, fc.ci)) {
          e.preventDefault();
          setEditing({ r: fc.r, c: fc.ci });
        }
        return;
      case 'Delete':
      case 'Backspace':
        // Shift+Delete: set the focused cell to NULL (plain Delete stages row deletion, above).
        if (fc && e.shiftKey && !mod && canEditCell(fc.r, fc.ci)) {
          e.preventDefault();
          commitEdit(fc.r, fc.ci, null);
        }
        return;
      case 'Escape':
        setSel(null);
        return;
      case 'a':
      case 'A':
        if (mod) {
          e.preventDefault();
          setSel(S.selectAll(total, visibleCols.length));
        }
        return;
    }
  };

  // ------------------------------------------------------------ mouse

  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mouseup', up);
    };
  }, []);

  const onCellMouseDown = (e: React.MouseEvent, r: number, vc: number) => {
    if (e.button !== 0) return;
    if (editing && editing.r === r && editing.c === visibleCols[vc] && !editing.big) return;
    e.preventDefault(); // no native text selection while range-selecting
    scroller.current?.focus();
    const cell = { r, c: vc };
    if (e.shiftKey) setSel((s) => S.extendTo(s, cell));
    else if (e.metaKey || e.ctrlKey) setSel((s) => S.toggleCell(s, cell));
    else setSel(S.single(cell));
    dragging.current = !(e.metaKey || e.ctrlKey);
  };

  const onRowHeaderMouseDown = (e: React.MouseEvent, r: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    scroller.current?.focus();
    const n = visibleCols.length;
    if (e.shiftKey && sel) setSel(S.selectRows(Math.min(sel.anchor.r, r), Math.max(sel.anchor.r, r), n, sel.anchor.r));
    else if (e.metaKey || e.ctrlKey) setSel((s) => S.toggleRow(s, r, n));
    else setSel(S.selectRows(r, r, n));
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

  return (
    <div dir="ltr" className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        tabIndex={0}
        role="grid"
        aria-label={p.ariaLabel ?? t('grid.label')}
        aria-rowcount={total + 1}
        aria-colcount={visibleCols.length}
        aria-multiselectable="true"
        onKeyDown={onKey}
        onPaste={onPasteEvent}
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
                    setMenu({ x: e.clientX, y: e.clientY, kind: 'header', col: ci, n: Date.now() });
                  }}
                  title={`${c.name} : ${c.type_name}`}
                  className={`relative flex shrink-0 cursor-default select-none items-center gap-1 truncate border-r border-border px-2 font-sans text-[0.92rem] font-semibold hover:bg-hover ${isFrozen ? 'sticky z-20 bg-panel' : ''} ${selVisCols.includes(vc) ? 'text-accent' : ''}`}
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
            const deleted = deletedSet.has(r);
            const isNew = r >= p.rows.length;
            const rowSel = S.rowTouched(sel, r);
            return (
              <div
                key={vr.key}
                role="row"
                aria-rowindex={r + 2}
                aria-selected={rowSel || undefined}
                className={`group/row absolute left-0 flex border-b border-border/40 ${deleted ? 'bg-danger/10 line-through' : isNew ? 'bg-ok/10' : rowSel ? 'bg-select/[0.07]' : r % 2 ? 'bg-panel/60' : 'bg-bg'}`}
                style={{ top: vr.start + ROW_H, height: ROW_H, width: totalWidth }}
              >
                <div
                  role="rowheader"
                  className={`sticky left-0 z-10 w-12 shrink-0 cursor-default select-none border-r border-border pr-2 text-right text-[0.85em] leading-[23px] ${rowSel ? 'bg-select/25 font-semibold text-fg' : 'bg-panel text-muted'}`}
                  onMouseDown={(e) => onRowHeaderMouseDown(e, r)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!S.rowTouched(sel, r)) setSel(S.selectRows(r, r, visibleCols.length));
                    setMenu({ x: e.clientX, y: e.clientY, kind: 'cell', n: Date.now() });
                  }}
                >
                  {isNew ? '+' : r + 1}
                </div>
                {visibleCols.map((ci, vc) => {
                  const { v, edited, isDefault } = cellValue(r, ci);
                  const isFrozen = vc < frozen;
                  const selected = S.contains(sel, r, vc);
                  const isFocus = sel?.focus.r === r && sel.focus.c === vc;
                  const isEditing = editing?.r === r && editing.c === ci && !editing.big;
                  const fk = p.onOpenForeignKey && !isNull(v) ? fkFor(p.columns[ci].name) : undefined;
                  return (
                    <div
                      key={ci}
                      role="gridcell"
                      data-cell={`${r}:${ci}`}
                      aria-selected={selected}
                      className={`relative shrink-0 truncate border-r border-border/40 px-2 leading-[23px] ${isNumeric(v) ? 'text-right tabular-nums' : ''} ${edited ? 'bg-warn/20' : ''} ${selected ? '!bg-select/25' : ''} ${isFocus ? 'outline outline-1 -outline-offset-1 outline-select' : ''} ${isFrozen ? 'sticky z-[5] bg-inherit' : ''}`}
                      style={{ width: width(ci), left: isFrozen ? left[vc] : undefined }}
                      onMouseDown={(e) => onCellMouseDown(e, r, vc)}
                      onMouseEnter={() => {
                        if (dragging.current) setSel((s) => S.extendTo(s, { r, c: vc }));
                      }}
                      onDoubleClick={() => canEditCell(r, ci) && setEditing({ r, c: ci, big: v.t === 'json' || (v.t === 'text' && (v.v.length > 200 || v.v.includes('\n'))) })}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (!S.contains(sel, r, vc)) setSel(S.single({ r, c: vc }));
                        else setSel((s) => (s ? { ...s, focus: { r, c: vc } } : s));
                        setMenu({ x: e.clientX, y: e.clientY, kind: 'cell', n: Date.now() });
                      }}
                      title={isNull(v) ? 'NULL' : displayValue(v).slice(0, 500)}
                    >
                      {isEditing ? (
                        <InlineEditor label={t('grid.editCell')} initial={editableText(v)} onDone={(text) => commitEdit(r, ci, text)} onCancel={() => setEditing(null)} />
                      ) : isDefault ? (
                        <span className="italic text-muted">DEFAULT</span>
                      ) : isNull(v) ? (
                        <span className="cell-null">NULL</span>
                      ) : v.t === 'text' && v.v === '' ? (
                        <span className="text-muted/60" aria-label={t('grid.emptyString')}>''</span>
                      ) : (
                        displayValue(v)
                      )}
                      {fk && !isEditing && (
                        <button
                          type="button"
                          tabIndex={-1}
                          className="absolute right-0.5 top-1/2 hidden h-[17px] -translate-y-1/2 items-center rounded border border-border bg-raised px-1 font-sans text-[0.8em] leading-none text-accent hover:bg-accent-solid hover:text-on-solid group-hover/row:flex"
                          aria-label={t('gridMenu.fkLink', { table: fk.ref_table })}
                          title={t('gridMenu.fkLink', { table: fk.ref_table })}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            const vals = fkValues(fk, r);
                            if (vals) p.onOpenForeignKey?.(fk, vals);
                          }}
                        >
                          →
                        </button>
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
          readOnly={!canEditCell(editing.r, editing.c)}
          onSave={(v) => {
            emitEdits([{ row: editing.r, col: p.columns[editing.c].name, value: v }]);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {menu && (
        <ContextMenu
          key={menu.n}
          x={menu.x}
          y={menu.y}
          label={menu.kind === 'header' ? t('gridMenu.headerMenuLabel') : t('gridMenu.menuLabel')}
          items={menu.kind === 'header' && menu.col !== undefined ? headerMenu(menu.col) : cellMenu()}
          openSubmenu={menu.openSubmenu}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function InlineEditor({ label, initial, onDone, onCancel }: { label: string; initial: string; onDone: (t: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  return (
    <input
      className="h-full w-full bg-raised px-0 font-mono outline outline-2 outline-accent"
      autoFocus
      aria-label={label}
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
