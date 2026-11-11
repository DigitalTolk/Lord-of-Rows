// Per-table-tab UI state shared between the table view, the top toolbar
// (pending changes) and the grid context menu (Quick Filter). Keyed by tab id;
// lives as long as the tab (TableView drops it on unmount).
import { create } from 'zustand';
import { fromQuickFilter, insertRowAfter, type FilterRow, type QuickFilter } from './filters';
import type { FilterCondition } from './types';

/** Registered by the table view so the top toolbar can drive its staged changes. */
export interface PendingActions {
  discard(): void;
  /** Exactly the statements Commit would run (generated in Rust). */
  statements(): Promise<string[]>;
  /** Commit through the normal safety policy (confirmation dialog when required). */
  commit(): Promise<void>;
  /** Open SQL in a new query tab. */
  openInQueryTab(sql: string): void;
}

export interface TableTabState {
  rows: FilterRow[];
  /** Conditions the grid is currently filtered by. */
  applied: FilterCondition[];
  filterOpen: boolean;
  detailOpen: boolean;
  /** Bumped to ask the table view to apply all enabled rows (it owns column metadata). */
  applySeq: number;
  /** Row to focus in the filter bar after a structural change. */
  focusRow?: string;
  pending: number;
  actions?: PendingActions;
}

export const EMPTY_TAB_STATE: TableTabState = { rows: [], applied: [], filterOpen: false, detailOpen: false, applySeq: 0, pending: 0 };

interface WS {
  tabs: Record<string, TableTabState>;
  patch(tabId: string, p: Partial<TableTabState>): void;
  setRows(tabId: string, rows: FilterRow[], focusRow?: string): void;
  /**
   * Public filter API (used by the grid's Quick Filter menu):
   * adds a filter row, opens the filter bar and, unless `apply: false`, applies
   * all enabled rows. `replace: true` replaces existing rows. Returns the new row id.
   */
  addFilter(tabId: string, f: QuickFilter, opts?: { apply?: boolean; replace?: boolean }): string;
  /** Apply all enabled filter rows of the tab. */
  requestApply(tabId: string): void;
  /** Remove all filters and show the unfiltered table. */
  clearFilters(tabId: string): void;
  toggleFilterBar(tabId: string, open?: boolean): void;
  toggleDetail(tabId: string, open?: boolean): void;
  drop(tabId: string): void;
}

export const useTableWs = create<WS>((set, get) => {
  const cur = (id: string) => get().tabs[id] ?? EMPTY_TAB_STATE;
  const patch = (id: string, p: Partial<TableTabState>) => set({ tabs: { ...get().tabs, [id]: { ...cur(id), ...p } } });
  return {
    tabs: {},
    patch,
    setRows(tabId, rows, focusRow) {
      patch(tabId, { rows, focusRow });
    },
    addFilter(tabId, f, opts = {}) {
      const row = fromQuickFilter(f);
      const rows = opts.replace ? [row] : [...cur(tabId).rows.filter((r) => r.value !== '' || r.op === 'is_null' || r.op === 'is_not_null'), row];
      const s = cur(tabId);
      patch(tabId, { rows, filterOpen: true, focusRow: row.id, applySeq: opts.apply === false ? s.applySeq : s.applySeq + 1 });
      return row.id;
    },
    requestApply(tabId) {
      patch(tabId, { applySeq: cur(tabId).applySeq + 1 });
    },
    clearFilters(tabId) {
      patch(tabId, { rows: [], applied: [] });
    },
    toggleFilterBar(tabId, open) {
      const s = cur(tabId);
      const next = open ?? !s.filterOpen;
      // Opening an empty bar starts with one row, like a search box.
      if (next && s.rows.length === 0) {
        const { rows, id } = insertRowAfter([]);
        patch(tabId, { filterOpen: true, rows, focusRow: id });
      } else patch(tabId, { filterOpen: next, focusRow: next ? s.rows[0]?.id : undefined });
    },
    toggleDetail(tabId, open) {
      patch(tabId, { detailOpen: open ?? !cur(tabId).detailOpen });
    },
    drop(tabId) {
      const tabs = { ...get().tabs };
      delete tabs[tabId];
      set({ tabs });
    },
  };
});

/** Selector helper: state of one tab (stable EMPTY object when absent). */
export const selectTab = (tabId: string | undefined) => (s: WS) => (tabId ? s.tabs[tabId] : undefined) ?? EMPTY_TAB_STATE;
