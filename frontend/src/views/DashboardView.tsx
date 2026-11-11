import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChartView, type ChartSpec } from '../components/Chart';
import { ask } from '../components/ask';
import { ErrorBox, Toolbar } from '../components/ui';
import { api } from '../lib/ipc';
import type { ResultSet } from '../lib/types';
import { errMsg, useApp, type Tab } from '../store';

interface Widget {
  id: string;
  title: string;
  sql: string;
  spec: ChartSpec | null; // null = table
  w: 1 | 2 | 3;
}
interface Dashboard {
  id: string;
  name: string;
  connectionId: string;
  refreshSecs: number;
  widgets: Widget[];
}

/** Query-backed metrics board. Read-only queries only (the backend enforces this via the safety policy). */
export function DashboardView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const { sessions } = useApp();
  const s = tab.sessionId ? sessions[tab.sessionId] : undefined;
  const [boards, setBoards] = useState<Dashboard[]>([]);
  const [board, setBoard] = useState<Dashboard | null>(null);
  const [data, setData] = useState<Record<string, ResultSet | string>>({});

  useEffect(() => {
    void api.listDocuments<Dashboard>('dashboard').then((d) => {
      const list = d.map((x) => x.body).filter((b) => !s || b.connectionId === s.config.id);
      setBoards(list);
      setBoard(list[0] ?? null);
    });
  }, [s?.config.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(async () => {
    if (!s || !board) return;
    const out: typeof data = {};
    await Promise.all(
      board.widgets.map(async (w) => {
        try {
          const ev = await api.evaluateSql(s.session_id, w.sql);
          if (ev.statements.some((x) => x.risk !== 'read')) throw new Error(t('dashboard.readOnlyOnly'));
          const r = await api.runSql({ session_id: s.session_id, sql: w.sql, query_id: crypto.randomUUID(), max_rows: 5000 });
          out[w.id] = r.results.find((x) => x.result)?.result ?? t('dashboard.noRows');
        } catch (e) {
          out[w.id] = errMsg(e);
        }
      }),
    );
    setData(out);
  }, [s, board, t]);

  useEffect(() => {
    void refresh();
    if (!board?.refreshSecs) return;
    const h = setInterval(refresh, Math.max(5, board.refreshSecs) * 1000);
    return () => clearInterval(h);
  }, [board, refresh]);

  const persist = async (b: Dashboard) => {
    setBoard(b);
    setBoards((bs) => [...bs.filter((x) => x.id !== b.id), b]);
    await api.saveDocument('dashboard', b.id, b.name, b);
  };

  const newBoard = async () => {
    if (!s) return;
    const name = await ask.text(t('dashboard.new'), t('dashboard.name'));
    if (!name) return;
    await persist({ id: crypto.randomUUID(), name, connectionId: s.config.id, refreshSecs: 0, widgets: [] });
  };
  const addWidget = async () => {
    if (!board) return;
    const title = await ask.text(t('dashboard.addWidget'), t('dashboard.widgetTitle'));
    if (!title) return;
    const sql = await ask.text(t('dashboard.addWidget'), t('dashboard.widgetSql'));
    if (!sql) return;
    const kind = ((await ask.text(t('dashboard.addWidget'), t('dashboard.widgetKind'))) ?? 'table').trim();
    const w: Widget = { id: crypto.randomUUID(), title, sql, w: 1, spec: kind === 'table' ? null : { kind: kind as ChartSpec['kind'], x: '', y: [] } };
    await persist({ ...board, widgets: [...board.widgets, w] });
  };

  if (!s) return <div className="p-4 text-muted">{t('dashboard.needConnection')}</div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <span className="font-semibold">{t('dashboard.title')}</span>
        <select className="input w-56" aria-label={t('dashboard.select')} value={board?.id ?? ''} onChange={(e) => setBoard(boards.find((b) => b.id === e.target.value) ?? null)}>
          {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <button className="btn" onClick={newBoard}>+ {t('common.new')}</button>
        {board && (
          <>
            <button className="btn" onClick={addWidget}>+ {t('dashboard.widget')}</button>
            <button className="btn" onClick={refresh} aria-label={t('common.refresh')} title={t('common.refresh')}>⟳</button>
            <label className="flex items-center gap-1">{t('dashboard.autoRefresh')}
              <select className="input w-auto" value={board.refreshSecs} onChange={(e) => persist({ ...board, refreshSecs: Number(e.target.value) })}>
                {[0, 10, 30, 60, 300].map((n) => <option key={n} value={n}>{n ? t('dashboard.seconds', { n }) : t('monitor.off')}</option>)}
              </select>
            </label>
            <button className="btn" onClick={() => navigator.clipboard.writeText(JSON.stringify({ ...board, connectionId: undefined }, null, 2))}>{t('common.export')}</button>
            <button className="btn text-danger" onClick={async () => { if (await ask.confirm(t('dashboard.delete'), board.name, true)) { await api.deleteDocument('dashboard', board.id); setBoards(boards.filter((b) => b.id !== board.id)); setBoard(null); } }}>{t('common.delete')}</button>
          </>
        )}
      </Toolbar>
      <div className="grid min-h-0 flex-1 auto-rows-[280px] grid-cols-3 gap-2 overflow-auto p-2">
        {board?.widgets.map((w) => {
          const d = data[w.id];
          const spec = w.spec && typeof d === 'object' ? { ...w.spec, x: w.spec.x || d.columns[0]?.name, y: w.spec.y.length ? w.spec.y : d.columns.slice(1).map((c) => c.name) } : null;
          return (
            <section key={w.id} className="flex min-h-0 flex-col rounded border border-border bg-raised" style={{ gridColumn: `span ${w.w}` }} aria-label={w.title}>
              <header className="flex items-center gap-1 border-b border-border px-2 py-1">
                <span className="font-semibold">{w.title}</span>
                <button className="btn btn-ghost ms-auto px-1" aria-label={t('dashboard.wider')} title={t('dashboard.wider')} onClick={() => persist({ ...board, widgets: board.widgets.map((x) => (x.id === w.id ? { ...x, w: ((x.w % 3) + 1) as 1 | 2 | 3 } : x)) })}>⇔</button>
                <button className="btn btn-ghost px-1 text-danger" aria-label={t('dashboard.removeWidget', { title: w.title })} onClick={() => persist({ ...board, widgets: board.widgets.filter((x) => x.id !== w.id) })}>✕</button>
              </header>
              <div className="min-h-0 flex-1 overflow-auto p-1">
                {typeof d === 'string' ? <ErrorBox error={d} /> : !d ? null : spec ? <ChartView columns={d.columns} rows={d.rows} spec={spec} /> : (
                  <table className="w-full text-xs"><thead><tr>{d.columns.map((c) => <th key={c.name} className="text-start">{c.name}</th>)}</tr></thead>
                    <tbody>{d.rows.slice(0, 200).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className="font-mono">{v.t === 'null' ? 'NULL' : 'v' in v ? String(typeof v.v === 'object' ? JSON.stringify(v.v) : v.v) : ''}</td>)}</tr>)}</tbody></table>
                )}
              </div>
            </section>
          );
        })}
        {!board && <p className="text-muted">{t('dashboard.empty')}</p>}
      </div>
    </div>
  );
}
