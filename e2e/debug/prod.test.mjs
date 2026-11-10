import { test } from 'node:test';
import { clickSel, clickText, fill, launch, pageText, sleep, until, waitText } from '../lib.mjs';
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
test('debug prod', async () => {
  const b = await launch();
  try {
    await waitText(b, 'Create a new connection');
    await clickText(b, 'Connect from URL');
    await fill(b, 'Import from URL', 'postgresql://dbs_test:dbs_test@postgres:5432/dbs_test?sslmode=disable');
    await clickText(b, 'OK', { exact: true });
    await until(async () => (await pageText(b)).includes('customers'), 'connected'); log('connected 1');
    await clickSel(b, 'button[aria-label="Open another connection"]'); await waitText(b, 'Create a new connection'); log('launcher');
    await clickText(b, 'Create a new connection'); await clickSel(b, 'button[title="PostgreSQL"]'); log('form');
    await fill(b, 'Name', 'E2E Prod'); await fill(b, 'Host', 'postgres'); await fill(b, 'User', 'dbs_test'); await fill(b, 'Password', 'dbs_test'); await fill(b, 'Database', 'dbs_test');
    await clickText(b, 'Production', { exact: true, selector: '[role=radio]' }); log('env');
    log('radio checked:', await b.execute(() => [...document.querySelectorAll('[role=dialog] [role=radio]')].map((r) => r.innerText.trim() + '=' + r.getAttribute('aria-checked')).join(' ')));
    await clickText(b, 'Connect', { exact: true }); log('clicked connect');
    await sleep(4000);
    log('TEXT:', (await pageText(b)).slice(0, 900));
  } finally { await b.deleteSession(); }
});
