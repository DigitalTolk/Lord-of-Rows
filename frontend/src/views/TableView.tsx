import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirmDecision } from '../components/confirm';
import { DataGrid } from '../components/DataGrid';
import { FilterBar } from '../components/FilterBar';
import { RowDetailPanel } from '../components/RowDetailPanel';
import { IndexList, TableBottomBar, type RowCount, type TableMode } from '../components/TableBottomBar';
import { ErrorBox, Spinner } from '../components/ui';
import { Icon } from '../components/icons';
import { StructureView } from './StructureView';
import { addRow, buildChanges, emptyStaged, History, pendingCount, setCell, setInsertedCell, toggleDelete, type StagedState } from '../lib/changes';
import { RAW_SQL, toConditions, type FilterRow } from '../lib/filters';
import { api } from '../lib/ipc';
import { displayCombo } from '../lib/keys';
import { selectTab, useTableWs, type PendingActions } from '../lib/tableWorkspace';
import type { ExportFormat, FilterCondition, ResultSet, SortDir, TableDescription, Value } from '../lib/types';
import { useTableGridActions } from './useTableGridActions';
import { errMsg, useApp, type Tab } from '../store';

/** Above this estimated size the exact COUNT(*) is only run on request. */
const AUTO_COUNT_LIMIT = 1_000_000;

export function TableView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const { sessions, toast, settings, openTab } = useApp();
  const s = tab.sessionId ? sessions[tab.sessionId] : undefined;
  const target = tab.target!;
  const ws = useTableWs(selectTab(tab.id));
  const wsApi = useTableWs.getState();
  const applied = ws.applied;
  const [desc, setDesc] = useState<TableDescription | null>(null);
  const [rs, setRs] = useState<ResultSet | null>(null);
  const [count, setCount] = useState<RowCount | null>(null);
  const [counting, setCounting] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(Number(settings['grid.pageSize'] ?? 500));
  const [sort, setSort] = useState<[string, SortDir][]>([]);
  const [staged, setStaged] = useState<StagedState>(emptyStaged());
  const [selRows, setSelRows] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailW, setDetailW] = useState(320);
  const hist = useRef(new History<StagedState>());
  const countKey = useRef<string | null>(null);
  const [mode, setMode] = useState<TableMode>('data');
  const isKeyValue = s?.config.engine === 'redis';
  // DynamoDB browses with Scan: no server-side ordering, and the count may only be an estimate.
  const isDynamo = s?.config.engine === 'dynamo_db';
  const editable = !!s?.capabilities.inline_edit && !s.config.read_only && !isKeyValue;
  const keyCols = desc?.primary_key ?? [];
  const pending = pendingCount(staged);
  const columns = rs?.columns ?? [];

  const runCount = useCallback(
    async (filters: FilterCondition[]) => {
      if (!s) return;
      setCounting(true);
      try {
        setCount({ n: await api.countRows(s.session_id, target, filters), exact: true });
      } catch {
        /* keep the estimate */
      } finally {
        setCounting(false);
      }
    },
    [s, target],
  );

  const load = useCallback(async () => {
    if (!s) return;
    setLoading(true);
    setError(null);
    try {
      const d = desc ?? (await api.describeTable(s.session_id, target).catch(() => null));
      // Without an explicit sort, order by primary key so paging is stable.
      // DynamoDB browses with Scan: no server-side ordering.
      const order: [string, SortDir][] = isDynamo ? [] : sort.length ? sort : (d?.primary_key ?? []).map((c) => [c, 'asc']);
      const r = await api.fetchTable(s.session_id, target, { offset: page * pageSize, limit: pageSize, order_by: order, filters: applied });
      setDesc(d);
      setRs(r);
      setStaged(emptyStaged());
      hist.current.clear();
      // Row count: once per filter set (not per page). Unfiltered tables show the
      // statistics estimate first (~); the exact COUNT(*) runs lazily, and only on
      // request for very large tables.
      const key = JSON.stringify(applied);
      if (countKey.current !== key) {
        countKey.current = key;
        const est = !applied.length && d?.estimated_rows != null && d.estimated_rows >= 0 ? d.estimated_rows : null;
        setCount(est != null ? { n: est, exact: false } : null);
        if (est == null || est <= AUTO_COUNT_LIMIT) void runCount(applied);
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [s, target, page, pageSize, sort, applied, desc, isDynamo, runCount]);

  useEffect(() => {
    void load();
  }, [page, pageSize, sort, applied, s?.session_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drop this tab's workspace state when the tab closes.
  useEffect(() => {
    const id = tab.id;
    return () => {
      useTableWs.getState().drop(id);
    };
  }, [tab.id]);

  const change = (next: StagedState) => {
    hist.current.push(staged);
    setStaged(next);
  };

  const onEdit = (row: number, col: string, v: Value) => {
    if (!rs) return;
    if (keyCols.length === 0) {
      toast('error', t('grid.noKey'));
      return;
    }
    change(setCell(staged, row, col, v, rs.rows[row][columns.findIndex((c) => c.name === col)]));
  };

  // ---------------------------------------------------------------- filters

  /** Convert + validate rows, then make them the applied filter set. */
  const applyRows = async (rows: FilterRow[]): Promise<boolean> => {
    if (!s) return false;
    try {
      for (const r of rows.filter((x) => x.column === RAW_SQL && x.value.trim())) {
        try {
          await api.validateFilterSql(s.session_id, r.value);
        } catch (e) {
          setError(t('filter.rawRejected', { msg: errMsg(e) }));
          return false;
        }
      }
      const conds = toConditions(rows, columns);
      wsApi.patch(tab.id, { applied: conds });
      setPage(0);
      setError(null);
      return true;
    } catch (e) {
      setError(errMsg(e));
      return false;
    }
  };

  // Quick Filter / external `addFilter(..., { apply: true })` requests.
  const lastApply = useRef(ws.applySeq);
  useEffect(() => {
    if (ws.applySeq === lastApply.current) return;
    lastApply.current = ws.applySeq;
    void applyRows(useTableWs.getState().tabs[tab.id]?.rows.filter((r) => r.enabled) ?? []);
  }, [ws.applySeq]); // eslint-disable-line react-hooks/exhaustive-deps

  const order = (): [string, SortDir][] => (isDynamo ? [] : sort.length ? sort : keyCols.map((c) => [c, 'asc']));
  const sqlFor = async (rows: FilterRow[]) => {
    if (!s) return '';
    return api.tableSelectSql(s.session_id, target, { offset: page * pageSize, limit: pageSize, order_by: order(), filters: toConditions(rows, columns) });
  };
  const openSql = (sql: string, title = target.table) => openTab({ kind: 'query', title, sessionId: s?.session_id, sql });

  // ---------------------------------------------------------------- commit

  const commit = async () => {
    if (!s || !rs) return;
    try {
      const changes = buildChanges(staged, columns, rs.rows, keyCols);
      if (!changes.length) return;
      const p = await api.previewChanges(s.session_id, target, changes);
      let token: string | null = null;
      // Never bypassed: production / risky edits ask (or block) exactly as before.
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
      if (changes.some((c) => c.op !== 'update')) countKey.current = null;
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  // The top toolbar drives pending changes through stable wrappers around the latest closures.
  const latest = useRef({ commit, staged, rs, columns, keyCols, s });
  latest.current = { commit, staged, rs, columns, keyCols, s };
  useEffect(() => {
    const actions: PendingActions = {
      discard: () => {
        const cur = latest.current.staged;
        if (pendingCount(cur) === 0) return;
        hist.current.push(cur);
        setStaged(emptyStaged());
      },
      statements: async () => {
        const L = latest.current;
        if (!L.s || !L.rs) return [];
        const changes = buildChanges(L.staged, L.columns, L.rs.rows, L.keyCols);
        return (await api.previewChanges(L.s.session_id, target, changes)).statements;
      },
      commit: () => latest.current.commit(),
      openInQueryTab: (sql) => openTab({ kind: 'query', title: `${target.table} changes`, sessionId: latest.current.s?.session_id, sql }),
    };
    useTableWs.getState().patch(tab.id, { actions });
  }, [tab.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    useTableWs.getState().patch(tab.id, { pending });
  }, [tab.id, pending]);

  // Grid context menu (copy, set value, quick filter, FK links, ...); filters go through the tab's workspace store.
  const gridActions = useTableGridActions({ tab, session: s, target, desc, rs, staged, change, count: count?.n ?? null, editable, reload: () => void load() });

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

  const undo = () => {
    const p = hist.current.undo(staged);
    if (p) setStaged(p);
  };
  const redo = () => {
    const n = hist.current.redo(staged);
    if (n) setStaged(n);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    const inField = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (k === 'z' && !e.shiftKey && !inField) {
      undo();
      e.preventDefault();
    } else if ((k === 'y' || (k === 'z' && e.shiftKey)) && !inField) {
      redo();
      e.preventDefault();
    } else if (k === 's') {
      e.preventDefault();
      if (pending) void commit();
    } else if (k === 'r' && !e.shiftKey) {
      e.preventDefault();
      void load();
    } else if (k === 'f' && !e.shiftKey && mode === 'data') {
      e.preventDefault();
      wsApi.toggleFilterBar(tab.id);
    } else if (k === 'd' && e.shiftKey && mode === 'data') {
      e.preventDefault();
      wsApi.toggleDetail(tab.id);
    }
  };

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

  const resizeDetail = (e: React.MouseEvent) => {
    const startX = e.clientX;
    const startW = detailW;
    const move = (m: MouseEvent) => setDetailW(Math.min(720, Math.max(220, startW - (m.clientX - startX))));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const header = `${target.schema ? target.schema + '.' : ''}${target.table}`;

  if (!s) return <div className="p-4 text-muted">{t('status.disconnected')}</div>;
  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div role="toolbar" className="flex h-[36px] shrink-0 items-center gap-0.5 border-b border-border bg-panel px-2">
        <button className="icon-btn" title="Refresh (⌘/Ctrl+R)" aria-label={t('common.refresh')} onClick={() => { countKey.current = null; void load(); }}><Icon name="refresh" size={15} /></button>
        {editable && (
          <>
            <span className="mx-1 h-4 border-l border-border" />
            <button className="icon-btn" title={t('grid.addRow')} aria-label={t('grid.addRow')} onClick={() => change(addRow(staged))}><Icon name="plus" size={16} /></button>
            <button className="icon-btn" title={t('grid.duplicateRow')} aria-label={t('grid.duplicateRow')} onClick={duplicateSelected} disabled={!selRows.length}><Icon name="copy" size={15} /></button>
            <button className="icon-btn" title={t('grid.deleteRows')} aria-label={t('grid.deleteRows')} onClick={() => change(toggleDelete(staged, selRows.filter((r) => r < (rs?.rows.length ?? 0))))} disabled={!selRows.length || keyCols.length === 0}><Icon name="trash" size={15} /></button>
            <span className="mx-1 h-4 border-l border-border" />
            <button className="icon-btn" title="Undo (⌘/Ctrl+Z)" aria-label={t('grid.undo')} onClick={undo}>↶</button>
            <button className="icon-btn" title="Redo (⌘/Ctrl+Shift+Z)" aria-label={t('grid.redo')} onClick={redo}>↷</button>
          </>
        )}
        {pending > 0 && (
          <span className="ml-2 rounded-full bg-warn/15 px-2 py-0.5 text-[0.85rem] font-medium text-warn" aria-live="polite" title={`${t('tableWs.pendingCommit')} (${displayCombo('Mod+S')})`}>{t('grid.pending', { n: pending })}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button className={`icon-btn ${ws.filterOpen ? 'bg-accent/15 text-accent' : ''}`} title={`${t('tableWs.toggleFilter')} (${displayCombo('Mod+F')})`} aria-label={t('grid.filterAdd')} aria-pressed={ws.filterOpen} onClick={() => wsApi.toggleFilterBar(tab.id)}><Icon name="filter" size={15} /></button>
        </div>
      </div>
      {editable && desc && keyCols.length === 0 && <div className="border-b border-border bg-warn/10 px-2 py-1 text-sm text-warn">{t('grid.noKey')}</div>}
      {mode === 'data' && ws.filterOpen && (
        <FilterBar
          tabId={tab.id}
          columns={columns}
          onApply={applyRows}
          onClear={() => { wsApi.patch(tab.id, { applied: [] }); setPage(0); }}
          onExport={(f) => void exportAll(f)}
          sqlFor={sqlFor}
          onOpenSql={(sql) => openSql(sql)}
        />
      )}
      <ErrorBox error={error} />
      {mode === 'structure' ? (
        <div className="min-h-0 flex-1"><StructureView tab={tab} /></div>
      ) : mode === 'index' ? (
        <IndexList indexes={desc?.indexes ?? null} loading={loading} />
      ) : loading && !rs ? (
        <div className="p-4"><Spinner label={t('common.loading')} /></div>
      ) : rs ? (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <DataGrid
              columns={columns}
              rows={rs.rows}
              staged={staged}
              editable={editable}
              sort={sort}
              onSort={isDynamo ? undefined : sortBy}
              onEdit={onEdit}
              onEditInserted={(i, c, v) => change(setInsertedCell(staged, i, c, v))}
              onSelectRows={setSelRows}
              {...gridActions}
              ariaLabel={`Table ${header}`}
            />
          </div>
          {ws.detailOpen && (
            <>
              <div role="separator" aria-orientation="vertical" aria-label="Resize row details" className="w-[4px] shrink-0 cursor-col-resize hover:bg-accent/40" onMouseDown={resizeDetail} />
              <div style={{ width: detailW }} className="min-h-0 shrink-0">
                <RowDetailPanel
                  columns={columns}
                  rows={rs.rows}
                  staged={staged}
                  selection={selRows}
                  defs={desc?.columns}
                  editable={editable}
                  canEditExisting={keyCols.length > 0}
                  onStage={change}
                  onClose={() => wsApi.toggleDetail(tab.id, false)}
                />
              </div>
            </>
          )}
        </div>
      ) : null}
      <TableBottomBar
        mode={mode}
        onMode={setMode}
        canAdd={editable}
        onAddRow={() => change(addRow(staged))}
        selected={selRows.length}
        count={count}
        counting={counting}
        filtered={applied.length > 0}
        onExactCount={() => void runCount(applied)}
        loaded={rs?.rows.length ?? 0}
        loading={loading}
        page={page}
        pageSize={pageSize}
        onPage={setPage}
        onPageSize={(n) => { setPageSize(n); setPage(0); }}
        filterOpen={ws.filterOpen}
        onToggleFilter={() => wsApi.toggleFilterBar(tab.id)}
        detailOpen={ws.detailOpen}
        onToggleDetail={() => wsApi.toggleDetail(tab.id)}
      />
    </div>
  );
}
