import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirmDecision } from '../components/confirm';
import { DataGrid } from '../components/DataGrid';
import { copyAs } from '../components/Results';
import { Dialog, ErrorBox, Spinner, Toolbar } from '../components/ui';
import { addRow, buildChanges, emptyStaged, History, pendingCount, setCell, setInsertedCell, toggleDelete, type StagedState } from '../lib/changes';
import { api } from '../lib/ipc';
import type { ExportFormat, FilterCondition, FilterOp, ResultSet, SortDir, TableDescription, Value } from '../lib/types';
import { parseInput } from '../lib/value';
import { errMsg, useApp, type Tab } from '../store';

const OPS: [FilterOp, string][] = [['eq', '='], ['ne', '≠'], ['lt', '<'], ['le', '≤'], ['gt', '>'], ['ge', '≥'], ['contains', 'contains'], ['starts_with', 'starts with'], ['ends_with', 'ends with'], ['is_null', 'is NULL'], ['is_not_null', 'is not NULL'], ['in', 'in (a,b,c)']];

interface FilterDraft { column: string; op: FilterOp; text: string }

export function TableView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const { sessions, toast, settings } = useApp();
  const s = tab.sessionId ? sessions[tab.sessionId] : undefined;
  const target = tab.target!;
  const [desc, setDesc] = useState<TableDescription | null>(null);
  const [rs, setRs] = useState<ResultSet | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(Number(settings['grid.pageSize'] ?? 500));
  const [sort, setSort] = useState<[string, SortDir][]>([]);
  const [filters, setFilters] = useState<FilterDraft[]>([]);
  const [applied, setApplied] = useState<FilterCondition[]>([]);
  const [staged, setStaged] = useState<StagedState>(emptyStaged());
  const [selRows, setSelRows] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<{ statements: string[] } | null>(null);
  const hist = useRef(new History<StagedState>());
  const isKeyValue = s?.config.engine === 'redis';
  const editable = !!s?.capabilities.inline_edit && !s.config.read_only && !isKeyValue;
  const keyCols = desc?.primary_key ?? [];
  const pending = pendingCount(staged);

  const load = useCallback(async () => {
    if (!s) return;
    setLoading(true);
    setError(null);
    try {
      const [d, r, c] = await Promise.all([
        desc ? Promise.resolve(desc) : api.describeTable(s.session_id, target),
        api.fetchTable(s.session_id, target, { offset: page * pageSize, limit: pageSize, order_by: sort, filters: applied }),
        api.countRows(s.session_id, target, applied).catch(() => null),
      ]);
      setDesc(d);
      setRs(r);
      setCount(c);
      setStaged(emptyStaged());
      hist.current.clear();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [s, target, page, pageSize, sort, applied, desc]);

  useEffect(() => {
    void load();
  }, [page, pageSize, sort, applied, s?.session_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (next: StagedState) => {
    hist.current.push(staged);
    setStaged(next);
  };

  const columns = rs?.columns ?? [];
  const onEdit = (row: number, col: string, v: Value) => {
    if (!rs) return;
    if (keyCols.length === 0) {
      toast('error', t('grid.noKey'));
      return;
    }
    change(setCell(staged, row, col, v, rs.rows[row][columns.findIndex((c) => c.name === col)]));
  };

  const applyFilters = () => {
    try {
      setApplied(
        filters.filter((f) => f.column).map((f) => {
          const col = columns.find((c) => c.name === f.column);
          if (f.op === 'in') return { column: f.column, op: f.op, values: f.text.split(',').map((x) => parseInput(x.trim(), col)) };
          if (f.op === 'is_null' || f.op === 'is_not_null') return { column: f.column, op: f.op, values: [] };
          return { column: f.column, op: f.op, value: ['contains', 'starts_with', 'ends_with'].includes(f.op) ? { t: 'text', v: f.text } : parseInput(f.text, col), values: [] };
        }),
      );
      setPage(0);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const startReview = async () => {
    if (!s || !rs) return;
    try {
      const changes = buildChanges(staged, columns, rs.rows, keyCols);
      const p = await api.previewChanges(s.session_id, target, changes);
      setReview({ statements: p.statements });
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const commit = async () => {
    if (!s || !rs) return;
    setReview(null);
    try {
      const changes = buildChanges(staged, columns, rs.rows, keyCols);
      const p = await api.previewChanges(s.session_id, target, changes);
      let token: string | null = null;
      if (p.decision.decision !== 'allow') {
        const c = await confirmDecision(p.decision, { production: s.config.environment === 'production', sqlPreview: p.statements.join(';\n') + ';' });
        if (!c) return;
        token = c.token;
      }
      const r = await api.applyChanges(s.session_id, target, changes, token);
      if (!r.committed) {
        setError(t('grid.conflict', { n: r.conflicts.length }));
        return;
      }
      toast('ok', t('grid.committed', { n: r.rows_affected }));
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const copy = async (rows: number[], cols: string[], fmt: ExportFormat = 'tsv') => {
    if (!rs) return;
    const ci = cols.length ? cols.map((c) => columns.findIndex((x) => x.name === c)) : columns.map((_, i) => i);
    const data = (rows.length ? rows.filter((r) => r < rs.rows.length).map((r) => rs.rows[r]) : rs.rows).map((r) => ci.map((i) => r[i]));
    try {
      await copyAs(ci.map((i) => columns[i]), data, fmt, target.table);
      toast('info', `Copied ${data.length} row(s)`);
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  const exportAll = async (format: ExportFormat) => {
    if (!s) return;
    const ext = format === 'json_lines' ? 'jsonl' : format === 'sql_insert' ? 'sql' : format === 'markdown' ? 'md' : format;
    const f = await api.pickFile(true, `${target.table}.${ext}`, [ext]);
    if (!f) return;
    try {
      const r = await api.exportTable(s.session_id, target, applied, f.grant, { format, header: true, formula_guard: true }, false);
      toast('ok', t('io.exported', { n: r.rows, path: r.path }));
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  // Keyboard: undo/redo/commit
  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'z' && !e.shiftKey) {
      const p = hist.current.undo(staged);
      if (p) setStaged(p);
      e.preventDefault();
    } else if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      const n = hist.current.redo(staged);
      if (n) setStaged(n);
      e.preventDefault();
    } else if (mod && e.key === 's' && pending) {
      e.preventDefault();
      void startReview();
    } else if (mod && e.key === 'r') {
      e.preventDefault();
      void load();
    }
  };

  const pages = count != null ? Math.max(1, Math.ceil(count / pageSize)) : null;
  const duplicateSelected = () => {
    if (!rs || !selRows.length) return;
    let next = staged;
    for (const r of selRows.filter((x) => x < rs.rows.length)) {
      const vals: Record<string, Value> = {};
      columns.forEach((c, i) => {
        const d = desc?.columns.find((x) => x.name === c.name);
        if (!d?.is_identity) vals[c.name] = rs.rows[r][i];
      });
      next = addRow(next, vals);
    }
    change(next);
  };

  const sortBy = (col: string, additive: boolean) => {
    const cur = sort.find(([c]) => c === col)?.[1];
    const nextDir: SortDir | null = cur === undefined ? 'asc' : cur === 'asc' ? 'desc' : null;
    const rest = additive ? sort.filter(([c]) => c !== col) : [];
    setSort(nextDir ? [...rest, [col, nextDir]] : rest);
  };

  const header = useMemo(() => `${target.schema ? target.schema + '.' : ''}${target.table}`, [target]);

  if (!s) return <div className="p-4 text-muted">{t('status.disconnected')}</div>;
  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <Toolbar>
        <span className="mr-2 font-semibold">{header}</span>
        <button className="btn" onClick={() => load()} title="⌘/Ctrl+R">⟳ {t('common.refresh')}</button>
        {editable && (
          <>
            <button className="btn" onClick={() => change(addRow(staged))}>＋ {t('grid.addRow')}</button>
            <button className="btn" onClick={duplicateSelected} disabled={!selRows.length}>{t('grid.duplicateRow')}</button>
            <button className="btn" onClick={() => change(toggleDelete(staged, selRows.filter((r) => r < (rs?.rows.length ?? 0))))} disabled={!selRows.length || keyCols.length === 0}>🗑 {t('grid.deleteRows')}</button>
            <button className="btn" onClick={() => { const p = hist.current.undo(staged); if (p) setStaged(p); }} title="⌘/Ctrl+Z">↶</button>
            <button className="btn" onClick={() => { const n = hist.current.redo(staged); if (n) setStaged(n); }} title="⌘/Ctrl+Shift+Z">↷</button>
          </>
        )}
        {pending > 0 && (
          <>
            <span className="ml-2 rounded bg-warn/20 px-2 text-warn" aria-live="polite">{t('grid.pending', { n: pending })}</span>
            <button className="btn btn-primary" onClick={startReview} title="⌘/Ctrl+S">{t('grid.review')}</button>
            <button className="btn" onClick={() => change(emptyStaged())}>{t('grid.discard')}</button>
          </>
        )}
        <select className="input ml-auto w-auto" aria-label={t('common.export')} value="" onChange={(e) => e.target.value && exportAll(e.target.value as ExportFormat)}>
          <option value="">{t('common.export')}…</option>
          <option value="csv">CSV</option><option value="tsv">TSV</option><option value="json">JSON</option><option value="json_lines">JSON Lines</option>
          <option value="sql_insert">SQL INSERT</option><option value="xlsx">Excel (XLSX)</option><option value="markdown">Markdown</option><option value="xml">XML</option>
        </select>
        <button className="btn" onClick={() => setFilters([...filters, { column: columns[0]?.name ?? '', op: 'eq', text: '' }])}>{t('grid.filterAdd')}</button>
      </Toolbar>
      {editable && desc && keyCols.length === 0 && <div className="border-b border-border bg-warn/10 px-2 py-1 text-sm text-warn">{t('grid.noKey')}</div>}
      {filters.length > 0 && (
        <div className="space-y-1 border-b border-border bg-panel p-2">
          {filters.map((f, i) => (
            <div key={i} className="flex gap-1">
              <select className="input w-48" aria-label="Column" value={f.column} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))}>
                {columns.map((c) => <option key={c.name}>{c.name}</option>)}
              </select>
              <select className="input w-36" aria-label="Operator" value={f.op} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, op: e.target.value as FilterOp } : x)))}>
                {OPS.map(([o, l]) => <option key={o} value={o}>{l}</option>)}
              </select>
              {!['is_null', 'is_not_null'].includes(f.op) && (
                <input className="input" aria-label={t('grid.filterValue')} placeholder={t('grid.filterValue')} value={f.text} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} onKeyDown={(e) => e.key === 'Enter' && applyFilters()} />
              )}
              <button className="btn" aria-label="Remove filter" onClick={() => setFilters(filters.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div className="flex gap-1">
            <button className="btn btn-primary" onClick={applyFilters}>{t('common.apply')}</button>
            <button className="btn" onClick={() => { setFilters([]); setApplied([]); }}>Clear</button>
          </div>
        </div>
      )}
      <ErrorBox error={error} />
      {loading && !rs ? (
        <div className="p-4"><Spinner label={t('common.loading')} /></div>
      ) : rs ? (
        <DataGrid
          columns={columns}
          rows={rs.rows}
          staged={staged}
          editable={editable}
          sort={sort}
          onSort={sortBy}
          onEdit={onEdit}
          onEditInserted={(i, c, v) => change(setInsertedCell(staged, i, c, v))}
          onSelectRows={setSelRows}
          onCopy={(r, c) => copy(r, c)}
          ariaLabel={`Table ${header}`}
        />
      ) : null}
      <div className="flex items-center gap-2 border-t border-border bg-panel px-2 py-1 text-sm">
        <button className="btn" disabled={page === 0} onClick={() => setPage(0)} aria-label="First page">⏮</button>
        <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous page">◀</button>
        <span>{t('grid.page', { p: page + 1 })} {pages != null && t('grid.of', { n: pages })}</span>
        <button className="btn" disabled={pages != null ? page + 1 >= pages : (rs?.rows.length ?? 0) < pageSize} onClick={() => setPage(page + 1)} aria-label="Next page">▶</button>
        <label className="ml-2 flex items-center gap-1">{t('grid.pageSize')}
          <select className="input w-auto" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}>
            {[100, 500, 1000, 5000, 10000, 50000].map((n) => <option key={n}>{n}</option>)}
          </select>
        </label>
        <span className="ml-auto text-muted">{count != null ? `${count.toLocaleString()} ${t('common.rows')}` : ''}</span>
        {loading && <Spinner />}
      </div>
      {review && (
        <Dialog
          title={t('grid.review')}
          wide
          onClose={() => setReview(null)}
          footer={
            <>
              <button className="btn" onClick={() => setReview(null)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" onClick={commit}>{t('grid.commit')}</button>
            </>
          }
        >
          <p className="mb-2 text-sm text-muted">These statements run in one transaction. Updates and deletes include the originally loaded values, so rows changed by someone else are not overwritten.</p>
          <pre className="max-h-[60vh] overflow-auto rounded border border-border bg-panel p-2 font-mono text-xs">{review.statements.map((x) => x + ';').join('\n')}</pre>
        </Dialog>
      )}
    </div>
  );
}
