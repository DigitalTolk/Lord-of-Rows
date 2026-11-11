import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirmDecision } from '../components/confirm';
import { ask } from '../components/ask';
import { DataGrid } from '../components/DataGrid';
import { KeyPatternBar } from '../components/FilterBar';
import { Icon } from '../components/icons';
import { RedisValuePanel } from '../components/RedisValuePanel';
import { ErrorBox, Spinner } from '../components/ui';
import { emptyStaged, type StagedState } from '../lib/changes';
import { clampDetailWidth, detailWidth, onRowsSelected, saveDetailWidth, setDetailPanel } from '../lib/detailPanel';
import { fmtNumber } from '../lib/format';
import { api } from '../lib/ipc';
import { displayCombo } from '../lib/keys';
import { DEFAULT_KEY_PAGE, isLiteralPattern, KEY_COLUMNS, KEY_PAGE_SIZES, keyGridRows } from '../lib/redisKeys';
import { selectTab, useTableWs, type PendingActions } from '../lib/tableWorkspace';
import type { KeyPage, KeyRow, KvEdit } from '../lib/types';
import { errMsg, useApp, type Tab } from '../store';

/**
 * Key grid of one logical database (key-value sessions): key, type, ttl, size and a
 * value preview, paged with SCAN (never KEYS). Each page continues from the scan
 * position the previous one ended at (the backend caches the server cursor per
 * pattern), so paging forward through millions of keys stays cheap. The Key
 * pattern bar narrows the scan server-side (`MATCH`). Selecting a key shows its
 * value by type; edits are staged and committed through the safety policy.
 */
export function RedisKeysView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const s = useApp((st) => (tab.sessionId ? st.sessions[tab.sessionId] : undefined));
  const settings = useApp((st) => st.settings);
  const { toast, openTab } = useApp.getState();
  const sessionId = s?.session_id;
  const db = tab.target?.schema || s?.activeSchema || 'db0';
  const ws = useTableWs(selectTab(tab.id));
  const [pattern, setPattern] = useState(tab.target?.table || '*');
  const [pageSize, setPageSize] = useState(DEFAULT_KEY_PAGE);
  /** Scan position each visited page starts at (page i starts at starts[i]). */
  const [starts, setStarts] = useState<number[]>([0]);
  const [pageIdx, setPageIdx] = useState(0);
  const [page, setPage] = useState<KeyPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selRows, setSelRows] = useState<number[]>([]);
  const [edits, setEdits] = useState<KvEdit[]>([]);
  const [reloadSeq, setReloadSeq] = useState(0);
  const [detailW, setDetailW] = useState(() => detailWidth(settings));
  const editable = !!s && !s.config.read_only;

  const load = useCallback(
    async (from: number, restart: boolean) => {
      if (!sessionId) return;
      setLoading(true);
      setError(null);
      try {
        const p = await api.kvScanKeys(sessionId, db, pattern, from, pageSize, restart);
        setPage(p);
        setSelRows([]);
        // A literal pattern (a key opened from the tree): show its value.
        if (p.keys.length === 1 && isLiteralPattern(pattern)) onRowsSelected(tab.id, [0]);
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setLoading(false);
      }
    },
    [sessionId, db, pattern, pageSize, tab.id],
  );

  const restart = useCallback(() => {
    setStarts([0]);
    setPageIdx(0);
    setReloadSeq((n) => n + 1);
    void load(0, true);
  }, [load]);

  // New tab, changed pattern or page size: start a new scan.
  useEffect(() => {
    restart();
  }, [restart]);

  const goPage = (idx: number) => {
    if (idx < 0 || !page) return;
    if (idx > pageIdx) {
      if (page.done) return;
      const next = page.next;
      setStarts((st) => [...st.slice(0, pageIdx + 1), next]);
      setPageIdx(pageIdx + 1);
      void load(next, false);
    } else {
      setPageIdx(idx);
      void load(starts[idx] ?? 0, false);
    }
  };

  const summary = useCallback(
    (r: KeyRow) => {
      const n = r.length ?? 0;
      switch (r.kind) {
        case 'hash': return t('redis.summary.hash', { count: n, formatted: fmtNumber(n) });
        case 'list': return t('redis.summary.list', { count: n, formatted: fmtNumber(n) });
        case 'set': return t('redis.summary.set', { count: n, formatted: fmtNumber(n) });
        case 'zset': return t('redis.summary.zset', { count: n, formatted: fmtNumber(n) });
        case 'stream': return t('redis.summary.stream', { count: n, formatted: fmtNumber(n) });
        case 'string': return t('redis.summary.string', { count: n, formatted: fmtNumber(n) });
        case 'json': return t('redis.summary.json');
        default: return r.kind;
      }
    },
    [t],
  );
  const keys = useMemo(() => page?.keys ?? [], [page]);
  const rows = useMemo(() => keyGridRows(keys, summary), [keys, summary]);

  // Staged edits shown in the grid: deleted keys struck through, new values/TTL/name highlighted.
  const staged = useMemo<StagedState>(() => {
    const st = emptyStaged();
    keys.forEach((k, i) => {
      for (const e of edits) {
        if (e.key !== k.key) continue;
        if (e.op === 'delete') st.deleted.push(i);
        else if (e.op === 'set_string') st.edits[i] = { ...st.edits[i], value: { t: 'text', v: e.value.slice(0, 200) } };
        else if (e.op === 'expire') st.edits[i] = { ...st.edits[i], ttl: { t: 'int', v: e.seconds } };
        else if (e.op === 'rename') st.edits[i] = { ...st.edits[i], key: { t: 'text', v: e.to } };
      }
    });
    return st;
  }, [keys, edits]);

  const stage = (e: KvEdit) => setEdits((cur) => [...cur.filter((x) => !(x.op === 'delete' && e.op === 'delete' && x.key === e.key)), e]);
  const unstage = (e: KvEdit) => setEdits((cur) => cur.filter((x) => x !== e));

  // ---------------------------------------------------------------- commit

  const commit = async () => {
    if (!s || !edits.length) return;
    try {
      const p = await api.kvPreviewEdits(s.session_id, db, edits);
      let token: string | null = null;
      let typed: string | undefined;
      // Never bypassed: read-only refuses, production / destructive commands ask (typed name where required).
      if (p.decision.decision !== 'allow') {
        const c = await confirmDecision(p.decision, { production: s.config.environment === 'production', sqlPreview: p.statements.join('\n') });
        if (!c) return;
        token = c.token;
        typed = c.typed;
      }
      const r = await api.kvApplyEdits(s.session_id, db, edits, token, typed);
      if (!r.committed || r.conflicts.length) {
        setError(t('redis.renameConflict'));
        if (!r.committed) return;
      }
      toast('ok', t('redis.committed', { count: r.applied, formatted: fmtNumber(r.applied) }));
      setEdits([]);
      restart();
      void useApp.getState().loadKeyspaces(s.session_id).catch(() => undefined);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  // The top toolbar (pending changes: discard · preview · commit) drives the staged edits.
  const latest = useRef({ commit, edits, sessionId, db });
  latest.current = { commit, edits, sessionId, db };
  useEffect(() => {
    const actions: PendingActions = {
      plain: true,
      discard: () => setEdits([]),
      statements: async () => {
        const L = latest.current;
        if (!L.sessionId || !L.edits.length) return [];
        return (await api.kvPreviewEdits(L.sessionId, L.db, L.edits)).statements;
      },
      commit: () => latest.current.commit(),
      openInQueryTab: (sql) => openTab({ kind: 'query', title: `${latest.current.db} changes`, sessionId: latest.current.sessionId, sql }),
    };
    useTableWs.getState().patch(tab.id, { actions });
  }, [tab.id, openTab]);
  useEffect(() => {
    useTableWs.getState().patch(tab.id, { pending: edits.length });
  }, [tab.id, edits.length]);
  useEffect(() => {
    useTableWs.getState().patch(tab.id, { loading });
  }, [tab.id, loading]);
  useEffect(() => {
    const id = tab.id;
    return () => {
      useTableWs.getState().drop(id);
    };
  }, [tab.id]);

  // Top-bar refresh and Cmd/Ctrl+R restart the scan.
  const restartRef = useRef(restart);
  restartRef.current = restart;
  const refreshSeq = ws.refreshSeq ?? 0;
  useEffect(() => {
    if (refreshSeq) restartRef.current();
  }, [refreshSeq]);

  const newKey = async () => {
    const key = (await ask.text(t('redis.newKeyPrompt')))?.trim();
    if (!key) return;
    const value = await ask.text(t('redis.valuePrompt'), key);
    if (value != null) stage({ op: 'set_string', key, value });
  };
  const deleteSelected = () => {
    for (const i of selRows) if (keys[i]) stage({ op: 'delete', key: keys[i].key });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === 's') {
      e.preventDefault();
      if (edits.length) void commit();
    } else if (k === 'r' && !e.shiftKey) {
      e.preventDefault();
      restart();
    } else if (k === 'd' && e.shiftKey) {
      e.preventDefault();
      setDetailPanel(tab.id);
    }
  };

  const resizeDetail = (e: React.MouseEvent) => {
    const startX = e.clientX;
    const startW = detailW;
    let last = startW;
    const move = (m: MouseEvent) => {
      last = clampDetailWidth(startW - (m.clientX - startX));
      setDetailW(last);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (last !== startW) saveDetailWidth(last);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const onSelectRows = useCallback(
    (r: number[]) => {
      setSelRows(r);
      onRowsSelected(tab.id, r);
    },
    [tab.id],
  );

  if (!s) return <div className="p-4 text-muted">{t('status.disconnected')}</div>;
  const start = starts[pageIdx] ?? 0;
  const status =
    page?.total != null ? t('redis.approxKeys', { count: page.total, formatted: fmtNumber(page.total) })
    : page?.done ? t('redis.matched', { count: page.next, formatted: fmtNumber(page.next) })
    : t('redis.matchedSoFar', { count: page?.next ?? 0, formatted: fmtNumber(page?.next ?? 0) });
  // A literal pattern (a key opened from the tree) shows that key until another row is selected.
  const selected = selRows.length === 1 ? (keys[selRows[0]] ?? null) : !selRows.length && keys.length === 1 && isLiteralPattern(pattern) ? keys[0] : null;

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div role="toolbar" aria-label={t('redis.keysToolbar')} className="flex h-[36px] shrink-0 items-center gap-0.5 border-b border-border bg-panel px-2">
        <button className="icon-btn" title={`${t('common.refresh')} (⌘/Ctrl+R)`} aria-label={t('common.refresh')} aria-busy={loading} onClick={restart}><Icon name="refresh" size={15} className={loading ? 'animate-spin' : ''} /></button>
        {editable && (
          <>
            <span className="mx-1 h-4 border-s border-border" aria-hidden />
            <button className="icon-btn" title={t('redis.newKey')} aria-label={t('redis.newKey')} onClick={() => void newKey()}><Icon name="plus" size={16} /></button>
            <button className="icon-btn" title={t('redis.deleteKeys')} aria-label={t('redis.deleteKeys')} disabled={!selRows.length} onClick={deleteSelected}><Icon name="trash" size={15} /></button>
          </>
        )}
        {edits.length > 0 && (
          <span className="ms-2 rounded-full bg-warn/15 px-2 py-0.5 text-[0.85rem] font-medium text-warn" aria-live="polite" title={`${t('tableWs.pendingCommit')} (${displayCombo('Mod+S')})`}>
            {t('grid.pending', { count: edits.length, formatted: fmtNumber(edits.length) })}
          </span>
        )}
        <span className="ms-auto truncate font-mono text-[0.85rem] text-muted" dir="auto">{db}</span>
      </div>
      <KeyPatternBar value={pattern} onApply={(p) => (p === pattern ? restart() : setPattern(p))} />
      <ErrorBox error={error} />
      {loading && !page ? (
        <div className="p-4"><Spinner label={t('common.loading')} /></div>
      ) : page ? (
        <div className="flex min-h-0 flex-1">
          <div className={`flex min-h-0 min-w-0 flex-1 flex-col transition-opacity duration-150 ${loading ? 'opacity-50' : ''}`} aria-busy={loading}>
            {rows.length === 0 && !page.done && <div className="border-b border-border bg-accent/10 px-2 py-1 text-[0.85rem]">{t('redis.scanContinues')}</div>}
            <DataGrid columns={KEY_COLUMNS} rows={rows} staged={staged} editable={false} onSelectRows={onSelectRows} onRefresh={restart} ariaLabel={t('table.gridLabel', { table: `${db} ${pattern}` })} />
          </div>
          {ws.detailOpen && (
            <>
              <div role="separator" aria-orientation="vertical" aria-label={t('tableWs.resizeDetail')} className="w-[4px] shrink-0 cursor-col-resize hover:bg-accent/40" onMouseDown={resizeDetail} />
              <div style={{ width: detailW }} className="min-h-0 shrink-0">
                <RedisValuePanel
                  sessionId={s.session_id}
                  db={db}
                  row={selected}
                  selectedCount={selRows.length}
                  editable={editable}
                  edits={edits}
                  onStage={stage}
                  onUnstage={unstage}
                  onClose={() => setDetailPanel(tab.id, false)}
                  reloadSeq={reloadSeq}
                />
              </div>
            </>
          )}
        </div>
      ) : null}
      <div className="grid h-[30px] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-t border-border bg-panel px-2 text-[0.86rem]">
        <span className="min-w-0 truncate text-muted" aria-live="polite">
          {status}
          {selRows.length > 0 && ` · ${t('tableWs.rowsSelectedShort', { count: selRows.length, formatted: fmtNumber(selRows.length) })}`}
        </span>
        <div className="flex items-center gap-1">
          <button className="icon-btn h-6 w-6" disabled={pageIdx === 0 || loading} onClick={() => goPage(pageIdx - 1)} aria-label={t('tableWs.prevPage')} title={t('tableWs.prevPage')}><Icon name="chevronLeft" size={14} /></button>
          <span className="tabular-nums text-muted">{t('tableWs.range', { from: rows.length ? start + 1 : start, to: start + rows.length })}</span>
          <button className="icon-btn h-6 w-6" disabled={!page || page.done || loading} onClick={() => goPage(pageIdx + 1)} aria-label={t('tableWs.nextPage')} title={t('tableWs.nextPage')}><Icon name="chevronRight" size={14} /></button>
        </div>
        <div className="flex items-center justify-end gap-1">
          <button className={`icon-btn h-6 w-6 ${ws.detailOpen ? 'bg-accent/15 text-accent' : ''}`} aria-pressed={ws.detailOpen} aria-label={t('tableWs.toggleDetail')} title={`${t('tableWs.toggleDetail')} (${displayCombo('Mod+Shift+D')})`} onClick={() => setDetailPanel(tab.id)}>
            <Icon name="panelRight" size={14} />
          </button>
          <select className="input h-6 w-auto py-0 text-[0.82rem]" aria-label={t('grid.pageSize')} value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
            {KEY_PAGE_SIZES.map((n) => <option key={n} value={n}>{t('tableWs.pageSize', { n })}</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}
