import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ANY_COLUMN, insertRowAfter, opNeedsValue, RAW_SQL, removeRow, rowIsComplete, UI_OPS, updateRow, type FilterRow, type UiOp } from '../lib/filters';
import { displayCombo } from '../lib/keys';
import { selectTab, useTableWs } from '../lib/tableWorkspace';
import type { ColumnMeta, ExportFormat } from '../lib/types';
import { Icon } from './icons';
import { SqlPopover } from './SqlPopover';

const EXPORTS: [ExportFormat, string][] = [['csv', 'CSV'], ['tsv', 'TSV'], ['json', 'JSON'], ['json_lines', 'JSON Lines'], ['sql_insert', 'SQL INSERT'], ['xlsx', 'Excel (XLSX)'], ['markdown', 'Markdown'], ['xml', 'XML']];

export interface FilterBarProps {
  tabId: string;
  columns: ColumnMeta[];
  /** Apply exactly these rows (AND). Resolves false when rejected (e.g. raw SQL refused). */
  onApply: (rows: FilterRow[]) => Promise<boolean>;
  onClear: () => void;
  onExport: (f: ExportFormat) => void;
  /** Generated SELECT for the given rows (built in Rust). */
  sqlFor: (rows: FilterRow[]) => Promise<string>;
  onOpenSql: (sql: string) => void;
}

/** Filter bar above the table grid (⌘F). State lives in the per-tab workspace store. */
export function FilterBar({ tabId, columns, onApply, onClear, onExport, sqlFor, onOpenSql }: FilterBarProps) {
  const { t } = useTranslation();
  const st = useTableWs(selectTab(tabId));
  const { setRows, patch } = useTableWs.getState();
  const rows = st.rows;
  const root = useRef<HTMLDivElement>(null);
  const focused = useRef<string | undefined>(undefined);
  const [menu, setMenu] = useState(false);
  const [sql, setSql] = useState<{ text: string; error?: string; loading: boolean } | null>(null);

  // Move keyboard focus to a requested row (after insert/remove/quick filter).
  useEffect(() => {
    if (!st.focusRow) return;
    const el = root.current?.querySelector<HTMLElement>(`[data-row-id="${st.focusRow}"] [data-focus]`);
    el?.focus();
    patch(tabId, { focusRow: undefined });
  }, [st.focusRow, tabId, patch]);

  const set = (id: string, p: Partial<FilterRow>) => setRows(tabId, updateRow(rows, id, p));
  const insertAfter = (id?: string) => {
    const r = insertRowAfter(rows, id);
    setRows(tabId, r.rows, r.id);
  };
  const remove = (id: string) => {
    const i = rows.findIndex((r) => r.id === id);
    const next = removeRow(rows, id);
    setRows(tabId, next, next[Math.max(0, i - 1)]?.id);
    if (next.length === 0) {
      patch(tabId, { filterOpen: false });
      onClear();
    }
  };
  const applyRow = (id: string) => {
    const next = rows.map((r) => ({ ...r, enabled: r.id === id }));
    setRows(tabId, next);
    void onApply(next.filter((r) => r.id === id));
  };
  const applyAll = () => {
    const next = rows.map((r) => ({ ...r, enabled: rowIsComplete(r) }));
    setRows(tabId, next);
    void onApply(next.filter((r) => r.enabled));
  };
  const applyEnabled = () => void onApply(rows.filter((r) => r.enabled));
  const move = (dir: 1 | -1) => {
    const i = rows.findIndex((r) => r.id === focused.current);
    const target = rows[Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i) + dir))];
    if (target) patch(tabId, { focusRow: target.id });
  };
  const showSql = async () => {
    setSql({ text: '', loading: true });
    try {
      setSql({ text: await sqlFor(rows.filter((r) => r.enabled)), loading: false });
    } catch (e) {
      setSql({ text: '', loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    let handled = true;
    if (e.key === 'Enter') applyAll();
    else if (k === 'i' && e.shiftKey) {
      if (focused.current) remove(focused.current);
    } else if (k === 'i') insertAfter(focused.current);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'ArrowDown') move(1);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const hint = (label: string, combo: string) => (
    <span className="whitespace-nowrap">{label}: <span className="kbd">{displayCombo(combo)}</span></span>
  );

  return (
    <div ref={root} role="search" aria-label={t('filter.title')} className="shrink-0 border-b border-border bg-panel px-2 py-1.5 text-[0.9rem]" onKeyDown={onKeyDown}>
      <div className="space-y-1">
        {rows.map((r) => {
          const raw = r.column === RAW_SQL;
          return (
            <div key={r.id} data-row-id={r.id} className="flex items-center gap-1" onFocus={() => (focused.current = r.id)}>
              <input type="checkbox" className="h-3.5 w-3.5 shrink-0 accent-[rgb(var(--accent))]" aria-label={t('filter.enable')} checked={r.enabled} onChange={(e) => set(r.id, { enabled: e.target.checked })} />
              <select className="input h-7 w-44 shrink-0 py-0" aria-label={t('filter.column')} value={r.column} onChange={(e) => set(r.id, { column: e.target.value })}>
                {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                <option disabled>──────────</option>
                <option value={ANY_COLUMN}>{t('filter.anyColumn')}</option>
                <option value={RAW_SQL}>{t('filter.rawSql')}</option>
              </select>
              {!raw && (
                <select className="input h-7 w-32 shrink-0 py-0" aria-label={t('filter.operator')} value={r.op} onChange={(e) => set(r.id, { op: e.target.value as UiOp })}>
                  {UI_OPS.map((o) => <option key={o.op} value={o.op}>{o.key ? t(o.key) : o.label}</option>)}
                </select>
              )}
              {raw || opNeedsValue(r.op) ? (
                <input
                  data-focus
                  className={`input h-7 min-w-0 flex-1 ${raw ? 'font-mono' : ''}`}
                  aria-label={raw ? t('filter.rawSql') : t('filter.value')}
                  placeholder={raw ? t('filter.rawPlaceholder') : r.op === 'in' || r.op === 'not_in' ? t('filter.listPlaceholder') : t('filter.value')}
                  spellCheck={false}
                  value={r.value}
                  onChange={(e) => set(r.id, { value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) applyRow(r.id);
                  }}
                />
              ) : (
                <span data-focus tabIndex={-1} className="flex-1" />
              )}
              {!raw && r.op === 'between' && (
                <>
                  <span className="text-muted">{t('filter.and')}</span>
                  <input className="input h-7 min-w-0 flex-1" aria-label={`${t('filter.value')} 2`} value={r.value2} onChange={(e) => set(r.id, { value2: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) applyRow(r.id);
                    }} />
                </>
              )}
              <button className="btn h-7 shrink-0" onClick={() => applyRow(r.id)} disabled={!rowIsComplete(r)}>{t('filter.apply')}</button>
              <button className="icon-btn shrink-0" aria-label={t('filter.remove')} title={`${t('filter.remove')} (${displayCombo('Mod+Shift+I')})`} onClick={() => remove(r.id)}><Icon name="minus" size={14} /></button>
              <button className="icon-btn shrink-0" aria-label={t('filter.add')} title={`${t('filter.add')} (${displayCombo('Mod+I')})`} onClick={() => insertAfter(r.id)}><Icon name="plus" size={14} /></button>
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <select className="input h-7 w-auto py-0" aria-label={t('filter.export')} value="" onChange={(e) => e.target.value && onExport(e.target.value as ExportFormat)}>
          <option value="">{t('filter.export')}…</option>
          {EXPORTS.map(([f, l]) => <option key={f} value={f}>{l}</option>)}
        </select>
        <div className="relative">
          <button className="btn h-7" onClick={() => (sql ? setSql(null) : void showSql())} aria-expanded={!!sql}>{t('filter.sql')}</button>
          {sql && (
            <SqlPopover
              title={t('filter.sqlTitle')}
              sql={sql.text}
              loading={sql.loading}
              error={sql.error}
              align="left"
              onClose={() => setSql(null)}
              actions={
                <>
                  <button className="btn h-7" disabled={!sql.text} onClick={() => void navigator.clipboard?.writeText(sql.text)}>{t('filter.copy')}</button>
                  <button className="btn btn-primary h-7" disabled={!sql.text} onClick={() => { onOpenSql(sql.text); setSql(null); }}>{t('filter.openInQuery')}</button>
                </>
              }
            />
          )}
        </div>
        <div className="mx-auto hidden min-w-0 items-center gap-3 overflow-hidden text-[0.8rem] text-muted lg:flex" aria-hidden>
          {hint(t('filter.show'), 'Mod+F')}
          {hint(t('filter.insert'), 'Mod+I')}
          {hint(t('filter.removeHint'), 'Mod+Shift+I')}
          {hint(t('filter.applyAll'), 'Mod+Return')}
          {hint(t('filter.up'), 'Mod+↑')}
          {hint(t('filter.down'), 'Mod+↓')}
        </div>
        <button className="btn ms-auto h-7 lg:ms-0" onClick={() => { const r = insertRowAfter([]); setRows(tabId, r.rows, r.id); onClear(); }}>{t('filter.clear')}</button>
        <div className="relative flex">
          <button className="btn btn-primary h-7 rounded-e-none" onClick={applyAll} title={displayCombo('Mod+Return')}>{t('filter.applyAll')}</button>
          <button className="btn btn-primary h-7 rounded-s-none border-s border-s-on-solid/30 px-1" aria-label={t('filter.applyMenu')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <Icon name="chevronDown" size={12} />
          </button>
          {menu && (
            <div role="menu" className="absolute bottom-full end-0 z-50 mb-1 w-48 rounded-lg border border-border bg-raised p-1 shadow-xl" onMouseLeave={() => setMenu(false)}>
              <button role="menuitem" className="menu-item" onClick={() => { setMenu(false); applyEnabled(); }}>{t('filter.applyEnabled')}</button>
              <button role="menuitem" className="menu-item" onClick={() => { setMenu(false); setRows(tabId, rows.map((r) => ({ ...r, enabled: true }))); }}>{t('filter.enableAll')}</button>
              <button role="menuitem" className="menu-item" onClick={() => { setMenu(false); setRows(tabId, rows.map((r) => ({ ...r, enabled: false }))); }}>{t('filter.disableAll')}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Filter bar for key-value tabs: one "Key pattern" glob input. The pattern is
 * matched server-side (`SCAN … MATCH`), so the column/operator rows of the SQL
 * filter bar do not apply here.
 */
export function KeyPatternBar({ value, onApply }: { value: string; onApply: (pattern: string) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const apply = () => onApply(draft.trim() || '*');
  return (
    <div role="search" aria-label={t('filter.title')} className="flex shrink-0 items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5 text-[0.9rem]">
      <label className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 text-muted">{t('redis.patternLabel')}</span>
        <input
          className="input h-7 min-w-0 flex-1 font-mono"
          dir="ltr"
          spellCheck={false}
          autoComplete="off"
          placeholder={t('redis.patternPlaceholder')}
          title={t('redis.patternHint')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply();
            if (e.key === 'Escape') setDraft(value);
          }}
        />
      </label>
      <button className="btn h-7" onClick={() => { setDraft('*'); onApply('*'); }}>{t('filter.clear')}</button>
      <button className="btn btn-primary h-7" onClick={apply}>{t('filter.apply')}</button>
    </div>
  );
}
