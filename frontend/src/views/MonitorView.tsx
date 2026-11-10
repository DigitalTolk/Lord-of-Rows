import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ask } from '../components/ask';
import { ErrorBox, Toolbar } from '../components/ui';
import { api } from '../lib/ipc';
import type { SessionInfo } from '../lib/types';
import { errMsg, useApp, type Tab } from '../store';
import { SimpleTable } from './StructureView';

const STATS: Record<string, { title: string; sql: string }[]> = {
  pg: [
    { title: 'Database size', sql: "SELECT datname, pg_size_pretty(pg_database_size(datname)) AS size FROM pg_database WHERE NOT datistemplate ORDER BY pg_database_size(datname) DESC" },
    { title: 'Largest tables', sql: "SELECT schemaname || '.' || relname AS table, pg_size_pretty(pg_total_relation_size(relid)) AS total, pg_size_pretty(pg_indexes_size(relid)) AS indexes, n_live_tup AS live_rows, n_dead_tup AS dead_rows, last_autovacuum, last_autoanalyze FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 25" },
    { title: 'Index usage', sql: "SELECT schemaname || '.' || relname AS table, indexrelname AS index, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS size FROM pg_stat_user_indexes ORDER BY idx_scan ASC LIMIT 25" },
    { title: 'Cache hit ratio', sql: "SELECT round(100.0 * sum(blks_hit) / nullif(sum(blks_hit) + sum(blks_read), 0), 2) AS cache_hit_pct FROM pg_stat_database" },
    { title: 'Locks', sql: "SELECT l.pid, l.locktype, l.mode, l.granted, c.relname FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation WHERE l.pid <> pg_backend_pid() ORDER BY l.granted, l.pid LIMIT 100" },
    { title: 'Replication', sql: 'SELECT client_addr, state, sync_state, write_lag, flush_lag, replay_lag FROM pg_stat_replication' },
  ],
  mysql: [
    { title: 'Database size', sql: 'SELECT table_schema AS db, ROUND(SUM(data_length + index_length) / 1024 / 1024, 1) AS size_mb FROM information_schema.tables GROUP BY table_schema ORDER BY size_mb DESC' },
    { title: 'Largest tables', sql: 'SELECT table_schema, table_name, table_rows, ROUND(data_length/1024/1024,1) AS data_mb, ROUND(index_length/1024/1024,1) AS index_mb FROM information_schema.tables ORDER BY data_length + index_length DESC LIMIT 25' },
    { title: 'Status', sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Questions','Slow_queries','Uptime','Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads')" },
  ],
};

export function MonitorView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const { sessions, toast } = useApp();
  const s = tab.sessionId ? sessions[tab.sessionId] : undefined;
  const [rows, setRows] = useState<SessionInfo[]>([]);
  const [interval, setIntervalS] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<Record<string, { heads: string[]; rows: string[][] } | string>>({});
  const fam = s ? (['postgres', 'cockroach_db', 'yugabyte_db', 'greenplum'].includes(s.config.engine) ? 'pg' : ['my_sql', 'maria_db', 'percona'].includes(s.config.engine) ? 'mysql' : null) : null;

  const load = async () => {
    if (!s?.capabilities.sessions_monitor) return;
    try {
      setRows(await api.listDbSessions(s.session_id));
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  };
  const loadStats = async () => {
    if (!s || !fam) return;
    const out: typeof stats = {};
    for (const q of STATS[fam]) {
      try {
        const r = await api.runSql({ session_id: s.session_id, sql: q.sql, query_id: crypto.randomUUID(), max_rows: 200 });
        const rs = r.results[0]?.result;
        out[q.title] = rs ? { heads: rs.columns.map((c) => c.name), rows: rs.rows.map((row) => row.map((v) => (v.t === 'null' ? '' : 'v' in v ? (typeof v.v === 'object' ? JSON.stringify(v.v) : String(v.v)) : ''))) } : 'no rows';
      } catch (e) {
        out[q.title] = errMsg(e);
      }
    }
    setStats(out);
  };
  useEffect(() => {
    void load();
    void loadStats();
    if (!interval) return;
    const h = setInterval(load, interval * 1000);
    return () => clearInterval(h);
  }, [s?.session_id, interval]); // eslint-disable-line react-hooks/exhaustive-deps

  const kill = async (id: string) => {
    if (!s) return;
    try {
      const r = await api.killDbSession(s.session_id, id);
      if (r.confirm) {
        if (!(await ask.confirm(t('monitor.kill'), r.confirm.message, true))) return;
        await api.killDbSession(s.session_id, id, r.confirm.token);
      }
      toast('ok', `Session ${id} terminated`);
      void load();
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  if (!s) return <div className="p-4 text-muted">{t('status.disconnected')}</div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <span className="font-semibold">{t('monitor.title')} — {s.config.name}</span>
        <span className="ml-2 text-xs text-muted">{s.server.version}</span>
        <label className="ml-auto flex items-center gap-1">{t('monitor.refreshEvery')}
          <select className="input w-auto" value={interval} onChange={(e) => setIntervalS(Number(e.target.value))}>
            <option value={0}>{t('monitor.off')}</option>{[2, 5, 10, 30, 60].map((n) => <option key={n} value={n}>{n}s</option>)}
          </select>
        </label>
        <button className="btn" onClick={() => { void load(); void loadStats(); }}>⟳</button>
      </Toolbar>
      <ErrorBox error={error} />
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <h3 className="mb-1 font-semibold">{t('monitor.sessions')} ({rows.length})</h3>
        {!s.capabilities.sessions_monitor ? (
          <p className="text-muted">{t('monitor.unsupported')}</p>
        ) : (
          <table className="mb-4 w-full text-sm">
            <thead className="sticky top-0 bg-panel"><tr>{['ID', 'User', 'DB', 'Client', 'State', 'Duration', t('monitor.blockedBy'), 'Query', ''].map((h) => <th key={h} className="border-b border-border px-2 py-1 text-left">{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`border-b border-border/50 ${r.blocked_by ? 'bg-danger/10' : (r.duration_ms ?? 0) > 60000 && r.state === 'active' ? 'bg-warn/10' : ''}`}>
                  <td className="px-2 font-mono">{r.id}</td><td className="px-2">{r.user}</td><td className="px-2">{r.database}</td><td className="px-2 text-xs">{r.client}</td>
                  <td className="px-2">{r.state}</td><td className="px-2 text-right">{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : ''}</td><td className="px-2">{r.blocked_by}</td>
                  <td className="max-w-md truncate px-2 font-mono text-xs" title={r.query ?? ''}>{r.query}</td>
                  <td>{s.capabilities.kill_session && !s.config.read_only && <button className="btn text-danger" onClick={() => kill(r.id)}>{t('monitor.kill')}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {Object.entries(stats).map(([title, v]) => (
          <section key={title} className="mb-4">
            <h3 className="mb-1 font-semibold">{title}</h3>
            {typeof v === 'string' ? <p className="text-sm text-muted">{v}</p> : <SimpleTable heads={v.heads} rows={v.rows} />}
          </section>
        ))}
      </div>
    </div>
  );
}
