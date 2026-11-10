import { useCallback, useEffect, useState } from 'react';
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
          if (ev.statements.some((x) => x.risk !== 'read')) throw new Error('Dashboard widgets may only run read-only queries');
          const r = await api.runSql({ session_id: s.session_id, sql: w.sql, query_id: crypto.randomUUID(), max_rows: 5000 });
          out[w.id] = r.results.find((x) => x.result)?.result ?? 'No rows';
        } catch (e) {
          out[w.id] = errMsg(e);
        }
      }),
    );
    setData(out);
  }, [s, board]);

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
    const name = await ask.text('New dashboard', 'Name');
    if (!name) return;
    await persist({ id: crypto.randomUUID(), name, connectionId: s.config.id, refreshSecs: 0, widgets: [] });
  };
  const addWidget = async () => {
    if (!board) return;
    const title = await ask.text('Add widget', 'Title');
    if (!title) return;
    const sql = await ask.text('Add widget', 'Read-only SQL query (first column = X, numeric columns = series)');
    if (!sql) return;
    const kind = ((await ask.text('Add widget', 'Visual: table, bar, line, area, pie, scatter, kpi')) ?? 'table').trim();
    const w: Widget = { id: crypto.randomUUID(), title, sql, w: 1, spec: kind === 'table' ? null : { kind: kind as ChartSpec['kind'], x: '', y: [] } };
    await persist({ ...board, widgets: [...board.widgets, w] });
  };

  if (!s) return <div className="p-4 text-muted">Connect to a database to use dashboards.</div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <span className="font-semibold">Dashboards</span>
        <select className="input w-56" aria-label="Dashboard" value={board?.id ?? ''} onChange={(e) => setBoard(boards.find((b) => b.id === e.target.value) ?? null)}>
          {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <button className="btn" onClick={newBoard}>+ New</button>
        {board && (
          <>
            <button className="btn" onClick={addWidget}>+ Widget</button>
            <button className="btn" onClick={refresh}>⟳</button>
            <label className="flex items-center gap-1">Auto-refresh
              <select className="input w-auto" value={board.refreshSecs} onChange={(e) => persist({ ...board, refreshSecs: Number(e.target.value) })}>
                {[0, 10, 30, 60, 300].map((n) => <option key={n} value={n}>{n ? `${n}s` : 'off'}</option>)}
              </select>
            </label>
            <button className="btn" onClick={() => navigator.clipboard.writeText(JSON.stringify({ ...board, connectionId: undefined }, null, 2))}>Export</button>
            <button className="btn text-danger" onClick={async () => { if (await ask.confirm('Delete dashboard', board.name, true)) { await api.deleteDocument('dashboard', board.id); setBoards(boards.filter((b) => b.id !== board.id)); setBoard(null); } }}>Delete</button>
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
                <button className="btn btn-ghost ml-auto px-1" aria-label="Wider" onClick={() => persist({ ...board, widgets: board.widgets.map((x) => (x.id === w.id ? { ...x, w: ((x.w % 3) + 1) as 1 | 2 | 3 } : x)) })}>⇔</button>
                <button className="btn btn-ghost px-1 text-danger" aria-label={`Remove ${w.title}`} onClick={() => persist({ ...board, widgets: board.widgets.filter((x) => x.id !== w.id) })}>✕</button>
              </header>
              <div className="min-h-0 flex-1 overflow-auto p-1">
                {typeof d === 'string' ? <ErrorBox error={d} /> : !d ? null : spec ? <ChartView columns={d.columns} rows={d.rows} spec={spec} /> : (
                  <table className="w-full text-xs"><thead><tr>{d.columns.map((c) => <th key={c.name} className="text-left">{c.name}</th>)}</tr></thead>
                    <tbody>{d.rows.slice(0, 200).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className="font-mono">{v.t === 'null' ? 'NULL' : 'v' in v ? String(typeof v.v === 'object' ? JSON.stringify(v.v) : v.v) : ''}</td>)}</tr>)}</tbody></table>
                )}
              </div>
            </section>
          );
        })}
        {!board && <p className="text-muted">Create a dashboard to add query-backed widgets.</p>}
      </div>
    </div>
  );
}
