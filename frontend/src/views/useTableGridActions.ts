import { fmtNumber } from '../lib/format';
// Table-tab side of the grid context menu: turns grid actions into staged
// changes, filters, tabs and exports. Kept out of TableView so the view only
// needs a couple of hook-up lines. Commits still go through TableView's commit
// path and the backend safety policy; nothing here writes to the database.
// Filters (Quick Filter, foreign-key links) go through the tab's workspace store
// (lib/tableWorkspace.ts `setFilters`), the same state the filter bar edits.
import { useTranslation } from 'react-i18next';
import { ask } from '../components/ask';
import type { CellEdit, GridProps } from '../components/DataGrid';
import { addRow, removeInserted, setCell, setInsertedCell, toggleDelete, unsetInsertedCell, type StagedState } from '../lib/changes';
import { api } from '../lib/ipc';
import { useTableWs, type TypedFilter } from '../lib/tableWorkspace';
import type { ExportFormat, ResultSet, TableDescription, TableTarget, Value } from '../lib/types';
import { errMsg, useApp, type OpenSession, type Tab } from '../store';

/** @deprecated use TypedFilter from lib/tableWorkspace. */
export type GridFilter = TypedFilter;

/** Replace a table tab's filters (also for a tab that has not mounted yet, e.g. a foreign-key target). */
export function requestTableFilters(tabId: string, filters: TypedFilter[]) {
  useTableWs.getState().setFilters(tabId, filters);
}

interface Opts {
  tab: Tab;
  session?: OpenSession;
  target: TableTarget;
  desc: TableDescription | null;
  rs: ResultSet | null;
  staged: StagedState;
  change: (next: StagedState) => void;
  count: number | null;
  editable: boolean;
  reload: () => void;
}

const EXT: Partial<Record<ExportFormat, string>> = { json_lines: 'jsonl', sql_insert: 'sql', markdown: 'md' };

export function useTableGridActions(o: Opts): Partial<GridProps> {
  const { t } = useTranslation();
  const { toast, openTab } = useApp();
  const { rs, staged, desc, session: s, target } = o;
  const keyCols = desc?.primary_key ?? [];
  const columns = rs?.columns ?? [];
  const loaded = rs?.rows.length ?? 0;
  const idx = (name: string) => columns.findIndex((c) => c.name === name);
  const identity = new Set((desc?.columns ?? []).filter((c) => c.is_identity).map((c) => c.name));

  const pending = Object.keys(staged.edits).length + staged.deleted.length + staged.inserted.length;
  // Reloading drops staged changes; ask first.
  const okToDiscard = async () => pending === 0 || (await ask.confirm(t('gridMenu.discardTitle'), t('gridMenu.discardMessage', { count: pending, formatted: fmtNumber(pending) }), true));

  const onEditMany = (edits: CellEdit[]) => {
    if (!rs) return;
    let next = staged;
    let blocked = 0;
    for (const e of edits) {
      if (e.row < loaded) {
        if (!keyCols.length) {
          blocked++;
          continue;
        }
        if (e.value === undefined) continue; // DEFAULT exists only for new rows
        next = setCell(next, e.row, e.col, e.value, rs.rows[e.row][idx(e.col)]);
      } else {
        const i = e.row - loaded;
        next = e.value === undefined ? unsetInsertedCell(next, i, e.col) : setInsertedCell(next, i, e.col, e.value);
      }
    }
    if (blocked) toast('error', t('grid.noKey'));
    if (next !== staged) o.change(next);
  };

  // Duplicates become staged inserts; identity / auto-increment columns are left out so the database assigns them.
  const onDuplicateRows = (rows: number[]) => {
    if (!rs || !rows.length) return;
    let next = staged;
    for (const r of rows) {
      if (staged.deleted.includes(r)) continue;
      const vals: Record<string, Value> = {};
      if (r < loaded) {
        columns.forEach((c, i) => {
          if (!identity.has(c.name)) vals[c.name] = staged.edits[r]?.[c.name] ?? rs.rows[r][i];
        });
      } else {
        for (const [k, v] of Object.entries(staged.inserted[r - loaded] ?? {})) if (!identity.has(k)) vals[k] = v;
      }
      next = addRow(next, vals);
    }
    o.change(next);
  };

  const onDeleteRows = (rows: number[]) => {
    if (!rs) return;
    const existing = rows.filter((r) => r < loaded);
    const fresh = rows.filter((r) => r >= loaded).map((r) => r - loaded).sort((a, b) => b - a);
    if (existing.length && !keyCols.length) {
      toast('error', t('grid.noKey'));
      if (!fresh.length) return;
    }
    let next = keyCols.length && existing.length ? toggleDelete(staged, existing) : staged;
    for (const i of fresh) next = removeInserted(next, i);
    if (next !== staged) o.change(next);
  };

  const onExportPage = async (format: ExportFormat) => {
    if (!s || !rs) return;
    const ext = EXT[format] ?? format;
    try {
      const f = await api.pickFile(true, `${target.table}.${ext}`, [ext]);
      if (!f) return;
      const r = await api.exportRows(s.session_id, target, rs.columns, rs.rows, f.grant, { format, header: true, formula_guard: true });
      toast('ok', t('io.exported', { count: r.rows, formatted: fmtNumber(r.rows), path: r.path }));
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  return {
    engine: s?.config.engine,
    table: target,
    keyColumns: keyCols,
    columnDefs: desc?.columns,
    foreignKeys: desc?.foreign_keys,
    canEditExisting: keyCols.length > 0,
    partialNote: o.count != null && o.count > loaded ? t('gridMenu.pageOnly', { count: loaded, formatted: fmtNumber(loaded) }) : undefined,
    onEditMany,
    onRefresh: () => {
      void okToDiscard().then((ok) => {
        if (ok) o.reload();
      });
    },
    onAddRow: o.editable ? () => o.change(addRow(staged)) : undefined,
    onDuplicateRows: o.editable ? onDuplicateRows : undefined,
    onDeleteRows: o.editable ? onDeleteRows : undefined,
    onQuickFilter: (f) => {
      void okToDiscard().then((ok) => {
        if (ok) requestTableFilters(o.tab.id, [f]);
      });
    },
    onOpenForeignKey: s
      ? (fk, values) => {
          const id = openTab({ kind: 'table', title: fk.ref_table, sessionId: s.session_id, target: { schema: fk.ref_schema ?? target.schema ?? null, table: fk.ref_table } });
          requestTableFilters(
            id,
            fk.ref_columns.map((c, i) => ({ column: c, op: 'eq' as const, value: values[i] })),
          );
        }
      : undefined,
    onImport: s && o.editable ? () => openTab({ kind: 'import', title: `${t('common.import')} → ${target.table}`, sessionId: s.session_id, target }) : undefined,
    onExportPage: (f) => void onExportPage(f),
  };
}
