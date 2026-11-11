import { test } from 'node:test';
import { clickText, fill, launch, pageText, until, waitText } from '../lib.mjs';
test('ipc timing', async () => {
  const b = await launch();
  try {
    await waitText(b, 'Create a new connection');
    await clickText(b, 'Connect from URL');
    await fill(b, 'Import from URL', 'postgresql://dbs_test:dbs_test@postgres:5432/dbs_test?sslmode=disable');
    await clickText(b, 'OK', { exact: true });
    await until(async () => (await pageText(b)).includes('customers'), 'connected');
    const r = await b.execute(async () => {
      const inv = window.__TAURI_INTERNALS__.invoke;
      const sid = Object.keys(JSON.parse(JSON.stringify({})) ) && (await inv('list_connections')) && null;
      return sid;
    });
    const timing = await b.execute(async () => {
      // find session id from the store via the DOM-less IPC: open_session already happened; ask backend for a fresh one
      const inv = window.__TAURI_INTERNALS__.invoke;
      const conns = await inv('list_connections');
      const s = await inv('open_session', { connectionId: conns[0].config.id, password: null, trustHostKey: null });
      const sql = "select g as id, md5(g::text) as hash, g * 1.5 as amount, now() - (g || ' seconds')::interval as ts from generate_series(1, 100000) g";
      const t0 = performance.now();
      const res = await inv('run_sql', { req: { session_id: s.session_id, sql, query_id: 'x', max_rows: 200000 } });
      const t1 = performance.now();
      const json = JSON.stringify(res);
      return { ipcMs: Math.round(t1 - t0), backendMs: res.duration_ms, payloadMb: +(json.length / 1e6).toFixed(1), rows: res.results[0].result.rows.length };
    });
    console.log('TIMING', JSON.stringify(timing), r);
  } finally { await b.deleteSession(); }
});
