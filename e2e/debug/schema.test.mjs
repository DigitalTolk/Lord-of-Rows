import { test } from 'node:test';
import { clickSel, clickText, fill, launch, pageText, runSql, screenshot, sleep, until, waitText } from '../lib.mjs';
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
test('debug schema switch', async () => {
  const b = await launch();
  b.setTimeout?.({ script: 10000 });
  try {
    await waitText(b, 'Create a new connection');
    await clickText(b, 'Connect from URL');
    await fill(b, 'Import from URL', 'postgresql://dbs_test:dbs_test@postgres:5432/dbs_test?sslmode=disable');
    await clickText(b, 'OK', { exact: true });
    await until(async () => (await pageText(b)).includes('customers'), 'connected'); log('connected');
    await clickText(b, 'customers', { exact: true, selector: '[role=treeitem]' }); await waitText(b, '500 rows'); log('table');
    await clickText(b, 'Structure', { exact: true, selector: '[role=tab]' }); await sleep(800);
    await clickText(b, 'DDL', { exact: true, selector: '[role=tab]' }); await sleep(500);
    await clickText(b, 'Data', { exact: true, selector: '[role=tab]' }); await sleep(500); log('structure');
    await clickSel(b, 'button[aria-label="New SQL query"]'); await sleep(1500); log('tab');
    await runSql(b, 'select 1 as x'); await sleep(1500); log('ran 1'); await screenshot(b, 'd1');
    await fill(b, 'Schemas', 'public'); log('filled public');
    for (let i = 0; i < 6; i++) { const t0 = Date.now(); await b.execute(() => 1); log('ping', Date.now() - t0); await sleep(300); }
    await screenshot(b, 'd2'); log('shot d2');
    await runSql(b, 'select * from customers'); log('ran 2'); await sleep(1500);
    log('BODY:', await b.execute(() => document.body.innerText.slice(0, 1500)));
    log('PANELS:', await b.execute(() => [...document.querySelectorAll('[role=tabpanel]')].map((p) => p.hidden).join(',')), 'root children', await b.execute(() => document.getElementById('root').children.length));
    for (let i = 0; i < 6; i++) { const t0 = Date.now(); await b.execute(() => 1); log('ping', Date.now() - t0); await sleep(300); }
    await screenshot(b, 'd3'); log('done');
  } finally { await b.deleteSession(); }
});
