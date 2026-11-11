// Performance measurements (spec §28). Records numbers; asserts only generous budgets.
// Environment is recorded alongside so results are comparable.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { test } from 'node:test';
import { clickSel, clickText, fill, launch, pageText, resultsText, runSql, sleep, until, waitText } from '../lib.mjs';

const rssMb = () => {
  try {
    const pids = execSync('pgrep -x dbstudio').toString().trim().split('\n');
    const kb = pids.map((p) => Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${p}/status`, 'utf8'))?.[1] ?? 0)).reduce((a, b) => a + b, 0);
    // WebKit runs the page in separate processes; include them.
    const web = execSync("pgrep -f 'WebKitWebProcess|WebKitNetworkProcess' || true").toString().trim().split('\n').filter(Boolean);
    const webKb = web.map((p) => Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${p}/status`, 'utf8'))?.[1] ?? 0)).reduce((a, b) => a + b, 0);
    return { app: Math.round(kb / 1024), webview: Math.round(webKb / 1024) };
  } catch {
    return { app: null, webview: null };
  }
};

test('performance budget measurements', async () => {
  const out = {
    when: new Date().toISOString(),
    env: { platform: `${os.platform()} ${os.arch()} (Docker, Xvfb, software rendering)`, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGb: Math.round(os.totalmem() / 2 ** 30) },
  };
  const t0 = Date.now();
  const b = await launch();
  try {
    await waitText(b, 'Create a new connection');
    out.startupMs = Date.now() - t0; // includes WebDriver session setup
    out.rssIdleMb = rssMb();

    await clickText(b, 'Connect from URL');
    await fill(b, 'Import from URL', 'postgresql://dbs_test:dbs_test@postgres:5432/dbs_test?sslmode=disable');
    const c0 = Date.now();
    await clickText(b, 'OK', { exact: true });
    await until(async () => (await pageText(b)).includes('customers'), 'connected');
    out.connectAndLoadTreeMs = Date.now() - c0;

    // Raise the result cap for this test only.
    await b.execute(() => window.__TAURI_INTERNALS__.invoke('set_setting', { key: 'query.maxRows', value: 200000 }));
    await clickSel(b, 'button[aria-label="New SQL query"]');
    await sleep(800);
    const q0 = Date.now();
    await runSql(b, "select g as id, md5(g::text) as hash, g * 1.5 as amount, now() - (g || ' seconds')::interval as ts from generate_series(1, 100000) g");
    await until(async () => /100000 rows/.test(await resultsText(b)), '100k rows displayed', 60000);
    out.query100kToGridMs = Date.now() - q0;
    out.rss100kMb = rssMb();
    out.domRowsRendered = await b.execute(() => document.querySelectorAll('[role=tabpanel]:not([hidden]) [role=row]').length);

    // Scroll the virtualized grid top→bottom for ~3 s and count animation frames.
    const scroll = await b.execute(
      () =>
        new Promise((resolve) => {
          const grid = document.querySelector('[role=tabpanel]:not([hidden]) [role=grid]');
          const max = grid.scrollHeight - grid.clientHeight;
          let frames = 0;
          let worst = 0;
          let last = performance.now();
          const start = last;
          const step = () => {
            const now = performance.now();
            worst = Math.max(worst, now - last);
            last = now;
            frames++;
            grid.scrollTop = Math.min(max, ((now - start) / 3000) * max);
            if (now - start < 3000) requestAnimationFrame(step);
            else resolve({ fps: Math.round((frames / (now - start)) * 1000), worstFrameMs: Math.round(worst), reachedBottom: grid.scrollTop >= max - 5 });
          };
          requestAnimationFrame(step);
        }),
    );
    out.scroll100k = scroll;
    out.lastRowVisible = await b.execute(() => document.querySelector('[role=tabpanel]:not([hidden]) [role=grid]').innerText.includes('100000'));

    // UI stays responsive while a long query runs (round-trip to the page).
    await runSql(b, 'select pg_sleep(5)');
    const pings = [];
    for (let i = 0; i < 10; i++) {
      const p0 = Date.now();
      await b.execute(() => 1);
      pings.push(Date.now() - p0);
      await sleep(200);
    }
    out.uiPingDuringLongQueryMs = { max: Math.max(...pings), avg: Math.round(pings.reduce((a, c) => a + c, 0) / pings.length) };
    await b.execute(() => window.__TAURI_INTERNALS__.invoke('set_setting', { key: 'query.maxRows', value: 10000 }));
  } finally {
    fs.mkdirSync('./artifacts', { recursive: true });
    fs.writeFileSync('./artifacts/perf.json', JSON.stringify(out, null, 2));
    console.log('PERF', JSON.stringify(out));
    await b.deleteSession();
  }
  // Generous budgets for a software-rendered VM; real hardware should be far better.
  assert.ok(out.query100kToGridMs < 30000, `100k rows took ${out.query100kToGridMs} ms`);
  assert.ok(out.domRowsRendered < 300, `virtualization: ${out.domRowsRendered} DOM rows`);
  assert.ok(out.scroll100k.reachedBottom && out.lastRowVisible, 'scrolled to the last row');
  assert.ok(out.uiPingDuringLongQueryMs.max < 1000, 'UI responsive during long query');
});
