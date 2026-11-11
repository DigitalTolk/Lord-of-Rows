import { useTranslation } from 'react-i18next';
import { displayCombo } from '../lib/keys';
import type { IndexDef } from '../lib/types';
import { Icon } from './icons';
import { Spinner } from './ui';

export type TableMode = 'data' | 'structure' | 'index';

export interface RowCount {
  n: number;
  exact: boolean;
}

/** "1 of ~859,591 rows selected" (estimates are marked with ~). */
export function selectionStatus(selected: number, count: RowCount | null, loaded: number): { sel: number; total: string } {
  const total = count ? `${count.exact ? '' : '~'}${count.n.toLocaleString()}` : loaded.toLocaleString();
  return { sel: selected, total };
}

export const PAGE_SIZES = [100, 300, 500, 1000, 5000, 10000, 50000];

export interface TableBottomBarProps {
  mode: TableMode;
  onMode: (m: TableMode) => void;
  canAdd: boolean;
  onAddRow: () => void;
  selected: number;
  count: RowCount | null;
  counting: boolean;
  filtered: boolean;
  onExactCount: () => void;
  loaded: number;
  loading: boolean;
  page: number;
  pageSize: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
  filterOpen: boolean;
  onToggleFilter: () => void;
  detailOpen: boolean;
  onToggleDetail: () => void;
}

/** Bottom bar of a table tab: Data | Structure | Index · + · status · filter/detail toggles · paging. */
export function TableBottomBar(p: TableBottomBarProps) {
  const { t } = useTranslation();
  const { sel, total } = selectionStatus(p.selected, p.count, p.loaded);
  const from = p.page * p.pageSize + (p.loaded ? 1 : 0);
  const to = p.page * p.pageSize + p.loaded;
  const pages = p.count?.exact ? Math.max(1, Math.ceil(p.count.n / p.pageSize)) : null;
  const hasNext = pages != null ? p.page + 1 < pages : p.loaded >= p.pageSize;
  const range = p.count?.exact ? t('tableWs.rangeOf', { from, to, total: p.count.n.toLocaleString() }) : t('tableWs.range', { from, to });
  return (
    <div className="grid h-[30px] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-t border-border bg-panel px-2 text-[0.86rem]">
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="seg" role="tablist" aria-label="View">
          <button role="tab" aria-selected={p.mode === 'data'} onClick={() => p.onMode('data')}>{t('tableWs.data')}</button>
          <button role="tab" aria-selected={p.mode === 'structure'} onClick={() => p.onMode('structure')}>{t('tableWs.structure')}</button>
          <button role="tab" aria-selected={p.mode === 'index'} onClick={() => p.onMode('index')}>{t('tableWs.index')}</button>
        </div>
        {p.mode === 'data' && (
          <button className="icon-btn h-6 w-6" disabled={!p.canAdd} aria-label={t('tableWs.addRow')} title={t('tableWs.addRow')} onClick={p.onAddRow}><Icon name="plus" size={14} /></button>
        )}
      </div>
      <div className="flex items-center justify-center gap-1.5 whitespace-nowrap text-muted" aria-live="polite">
        {p.mode === 'data' && (
          <>
            {p.count && !p.count.exact ? (
              <button className="hover:text-fg hover:underline" title={t('tableWs.estimate')} onClick={p.onExactCount}>{t('tableWs.rowsSelected', { sel, total })}</button>
            ) : (
              <span>{t('tableWs.rowsSelected', { sel, total })}</span>
            )}
            {p.filtered && <span className="rounded bg-accent/15 px-1 text-[0.78rem] text-accent">{t('filter.filtered')}</span>}
            {(p.loading || p.counting) && <Spinner />}
          </>
        )}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-1">
        {p.mode === 'data' && (
          <>
            <button className={`icon-btn h-6 w-6 ${p.filterOpen ? 'bg-accent/15 text-accent' : ''}`} aria-pressed={p.filterOpen} aria-label={t('tableWs.toggleFilter')} title={`${t('tableWs.toggleFilter')} (${displayCombo('Mod+F')})`} onClick={p.onToggleFilter}>
              <Icon name="filter" size={14} />
            </button>
            <button className={`icon-btn h-6 w-6 ${p.detailOpen ? 'bg-accent/15 text-accent' : ''}`} aria-pressed={p.detailOpen} aria-label={t('tableWs.toggleDetail')} title={`${t('tableWs.toggleDetail')} (${displayCombo('Mod+Shift+D')})`} onClick={p.onToggleDetail}>
              <Icon name="panelRight" size={14} />
            </button>
            <span className="mx-1 h-4 border-l border-border" />
            <button className="icon-btn h-6 w-6" disabled={p.page === 0} onClick={() => p.onPage(p.page - 1)} aria-label={t('tableWs.prevPage')} title={t('tableWs.prevPage')}><Icon name="chevronLeft" size={14} /></button>
            <span className="tabular-nums text-muted">{range}</span>
            <button className="icon-btn h-6 w-6" disabled={!hasNext} onClick={() => p.onPage(p.page + 1)} aria-label={t('tableWs.nextPage')} title={t('tableWs.nextPage')}><Icon name="chevronRight" size={14} /></button>
            <select className="input h-6 w-auto py-0 text-[0.82rem]" aria-label={t('grid.pageSize')} value={p.pageSize} onChange={(e) => p.onPageSize(Number(e.target.value))}>
              {[...new Set([...PAGE_SIZES, p.pageSize])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{t('tableWs.pageSize', { n })}</option>)}
            </select>
          </>
        )}
      </div>
    </div>
  );
}

/** Index list of the table (from describe_table, same data as Structure › Indexes). */
export function IndexList({ indexes, loading }: { indexes: IndexDef[] | null; loading?: boolean }) {
  const { t } = useTranslation();
  if (loading && !indexes) return <div className="p-4"><Spinner /></div>;
  if (!indexes?.length) return <p className="p-6 text-center text-muted">{t('tableWs.noIndexes')}</p>;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-[0.9rem]" aria-label={t('tableWs.index')}>
        <thead className="sticky top-0 bg-panel">
          <tr className="border-b border-border text-left">
            {[t('tableWs.idxName'), t('tableWs.idxColumns'), t('tableWs.idxUnique'), t('tableWs.idxPrimary'), t('tableWs.idxDefinition')].map((h) => <th key={h} className="px-2 py-1 font-semibold">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {indexes.map((ix) => (
            <tr key={ix.name} className="border-b border-border/50 hover:bg-hover">
              <td className="px-2 py-1 font-mono">{ix.name}</td>
              <td className="px-2 py-1 font-mono">{ix.columns.join(', ')}</td>
              <td className="px-2 py-1">{ix.unique ? '✓' : ''}</td>
              <td className="px-2 py-1">{ix.primary ? '✓' : ''}</td>
              <td className="max-w-[40vw] truncate px-2 py-1 font-mono text-muted" title={ix.definition ?? ''}>{ix.definition ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
