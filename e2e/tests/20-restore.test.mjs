// Restart the app: saved connections persist, restored query tabs re-attach on connect.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clickText, dblclickText, launch, pageText, resultsText, runSql, screenshot, until, waitText } from '../lib.mjs';

test('after restart: launcher shows saved connections, query tab re-attaches and runs', async () => {
  const b = await launch();
  try {
    await waitText(b, 'Create a new connection');
    const text = await pageText(b);
    for (const name of ['E2E Postgres', 'E2E Prod', 'E2E ReadOnly']) assert.ok(text.includes(name), `${name} listed`);
    assert.ok(!text.includes('dbs_test') || !text.includes('password'), 'no secrets in launcher');
    await dblclickText(b, 'E2E Postgres');
    await until(async () => (await pageText(b)).includes('customers'), 'connected');
    // A restored query tab must be bound to this connection (regression: it stayed "Not connected").
    await until(async () => b.execute(() => [...document.querySelectorAll('[role=tablist][aria-label="Open tabs"] [role=tab]')].some((t) => t.innerText.includes('Query'))), 'restored query tab');
    await clickText(b, 'Query', { selector: '[role=tab]' });
    assert.ok(!(await pageText(b)).includes('isn’t connected'), 'tab is connected');
    await runSql(b, 'select count(*) as n from customers');
    await until(async () => /\b500\b/.test(await resultsText(b)), 'query result');
  } catch (e) {
    await screenshot(b, 'FAIL-restore');
    throw e;
  } finally {
    await b.deleteSession();
  }
});
