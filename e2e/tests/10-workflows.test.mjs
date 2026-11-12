// Full user workflows against real Postgres / MySQL / Redis / SQLite.
// Tests run in order and share one app session (like a real user would).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { clickSel, clickText, dblclickText, fill, launch, pageText, resultsText, runSql, screenshot, sleep, until, waitText } from '../lib.mjs';

let b;
before(async () => {
  b = await launch();
  await waitText(b, 'Create a new connection');
});
after(async () => b?.deleteSession());

async function fail(name, fn) {
  try {
    await fn();
  } catch (e) {
    await screenshot(b, `FAIL-${name}`);
    throw e;
  }
}

async function newPgConnection(name, { env, readOnly, tls } = {}) {
  await clickText(b, 'Create a new connection');
  if (tls) {
    // Verified TLS against the test CA (certificate + hostname "postgres"). The CA path comes from the
    // URL (libpq sslrootcert): the form's CA Cert… button opens a native picker WebDriver can't drive.
    await fill(b, 'Import from URL', 'postgresql://dbs_test:dbs_test@postgres:5432/dbs_test?sslmode=verify-full&sslrootcert=/certs/ca.crt');
    await clickText(b, 'Import from URL', { exact: true });
    await waitText(b, 'PostgreSQL Connection');
    const sel = await b.execute(() => document.querySelector('[role=dialog] select[aria-label="SSL mode"]')?.value);
    assert.equal(sel, 'verify_identity');
    await waitText(b, 'ca.crt');
  } else {
    await clickSel(b, 'button[title="PostgreSQL"]');
    await fill(b, 'Host/IP', 'postgres');
    await fill(b, 'User', 'dbs_test');
    await fill(b, 'Password', 'dbs_test');
    await fill(b, 'Database', 'dbs_test');
  }
  await fill(b, 'Name', name);
  if (env) await fill(b, 'Tag', env.toLowerCase());
  if (readOnly) await fill(b, 'Safe mode', 'read_only');
}

async function openLauncher() {
  await clickSel(b, 'button[aria-label="Open another connection"]');
  await waitText(b, 'Create a new connection');
}

async function connectUrl(url) {
  await clickText(b, 'Connect from URL');
  await fill(b, 'Import from URL', url);
  await clickText(b, 'OK', { exact: true });
}

async function newQueryTab() {
  await clickSel(b, 'button[aria-label="New SQL query"]');
  await until(() => b.execute(() => !!document.querySelector('[role=tabpanel]:not([hidden]) .monaco-editor')), 'query editor');
  await sleep(500);
}

describe('connections', () => {
  test('create a PostgreSQL connection with Test, then Save', () =>
    fail('create-pg', async () => {
      await newPgConnection('E2E Postgres');
      await clickText(b, 'Test', { exact: true });
      await waitText(b, 'Connected to PostgreSQL');
      await clickText(b, 'Save', { exact: true });
      await until(async () => (await pageText(b)).includes('E2E Postgres') && !(await pageText(b)).includes('Native driver'), 'saved connection in list');
    }));

  test('wrong password shows an authentication error and never echoes the password', () =>
    fail('bad-password', async () => {
      await newPgConnection('Bad');
      await fill(b, 'Password', 'definitely-wrong-pw');
      await clickText(b, 'Test', { exact: true });
      await waitText(b, 'password authentication failed');
      assert.ok(!(await pageText(b)).includes('definitely-wrong-pw'));
      await clickText(b, 'Cancel', { exact: true }).catch(() => clickSel(b, 'button[aria-label="Close"]'));
      await clickSel(b, 'button[aria-label="Close"]').catch(() => {});
    }));

  test('connect by double-clicking; opens on the schema that has tables', () =>
    fail('connect', async () => {
      await dblclickText(b, 'E2E Postgres');
      await until(async () => (await pageText(b)).includes('customers') && (await pageText(b)).includes('revenue_by_country'), 'object tree');
      const schema = await b.execute(() => document.querySelector('select[aria-label="Schemas"]')?.value);
      assert.equal(schema, 'shop');
    }));
});

describe('browsing and querying', () => {
  test('open a table: grid, row count, paging', () =>
    fail('open-table', async () => {
      await clickText(b, 'customers', { exact: true, selector: '[role=treeitem]' });
      await waitText(b, '500 rows');
      await waitText(b, 'user1@example.com');
      // The exact count arrives lazily (an estimate marked ~ may show first).
      await until(async () => /1–500 of 500/.test(await resultsText(b)), 'exact row count');
    }));

  test('Structure view shows columns, indexes and DDL', () =>
    fail('structure', async () => {
      await clickText(b, 'Structure', { exact: true, selector: '[role=tab]' });
      await until(async () => (await b.execute(() => [...document.querySelectorAll('input[aria-label="Column name"]')].map((i) => i.value))).includes('email'), 'columns');
      await clickText(b, 'DDL', { exact: true, selector: '[role=tab]' });
      await waitText(b, 'CREATE TABLE "shop"."customers"');
      await clickText(b, 'Data', { exact: true, selector: '[role=tab]' });
    }));

  test('SQL tab: unqualified names resolve to the selected schema', () =>
    fail('sql-unqualified', async () => {
      await newQueryTab();
      await runSql(b, 'select * from customers');
      await until(async () => /500 rows/.test(await resultsText(b)), '500 result rows');
    }));

  test('switching schema in the sidebar changes name resolution', () =>
    fail('schema-switch', async () => {
      await fill(b, 'Schemas', 'public');
      await sleep(600);
      await runSql(b, 'select * from customers');
      await waitText(b, 'relation "customers" does not exist');
      await fill(b, 'Schemas', 'shop');
      await sleep(600);
      await runSql(b, 'select count(*) as n from customers');
      await until(async () => /\b500\b/.test(await resultsText(b)), 'count after switching back');
    }));

  test('multiple statements, multiple result sets, affected-row messages', () =>
    fail('multi', async () => {
      await runSql(b, "select 1 as a; select 'x' as b; update shop.customers set vip = vip where id <= 3");
      await clickText(b, 'Messages', { selector: '[role=tab]' });
      await until(async () => /3 rows affected/.test(await resultsText(b)), 'rows affected message');
      await clickText(b, 'Results', { exact: true, selector: '[role=tab]' });
    }));

  test('syntax errors are reported with SQLSTATE', () =>
    fail('syntax', async () => {
      await runSql(b, 'selec 1');
      await waitText(b, '42601');
    }));

  test('types: bigint, numeric, json, null vs empty string', () =>
    fail('types', async () => {
      await runSql(b, "select 9223372036854775807::bigint as big, 12345678901234567890.123::numeric as num, '{\"a\":1}'::jsonb as j, null::text as n, ''::text as e");
      const t = await resultsText(b);
      assert.match(t, /9223372036854775807/);
      assert.match(t, /12345678901234567890\.123/);
      assert.match(t, /NULL/);
    }));

  test('cancel a long-running query', () =>
    fail('cancel', async () => {
      await b.execute(() => {
        const panel = document.querySelector('[role=tabpanel]:not([hidden])');
        const node = panel.querySelector('.monaco-editor');
        globalThis.__monaco.editor.getEditors().find((e) => e.getContainerDomNode().contains(node) || node.contains(e.getContainerDomNode())).setValue('select pg_sleep(30)');
      });
      await clickText(b, 'Run all', { exact: true });
      await sleep(800);
      await clickSel(b, '[role=tabpanel]:not([hidden]) button[aria-label="Cancel"]');
      await waitText(b, 'query cancelled', 8000);
    }));

  test('EXPLAIN shows a plan', () =>
    fail('explain', async () => {
      await runSql(b, 'select * from customers where id = 1');
      await clickText(b, 'Explain', { exact: true });
      await waitText(b, 'QUERY PLAN');
    }));
});

describe('editing data', () => {
  test('edit a cell, review generated SQL, commit', () =>
    fail('edit-commit', async () => {
      await clickText(b, 'customers', { exact: true, selector: '[role=tab]' });
      await waitText(b, 'user1@example.com');
      // Double-click the "name" cell of row 1 and type a new value.
      await b.execute(() => {
        const header = [...document.querySelectorAll('[role=columnheader]')].map((h) => h.innerText.trim());
        const idx = header.indexOf('name');
        const row = [...document.querySelectorAll('[role=row]')].find((r) => [...r.querySelectorAll('[role=gridcell]')].some((c) => c.innerText.trim() === 'user1@example.com'));
        row.querySelectorAll('[role=gridcell]')[idx].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      });
      await sleep(300);
      await b.execute(() => {
        const input = document.querySelector('[role=gridcell] input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'E2E Edited');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      await waitText(b, '1 pending change');
      // Pending changes live in the top toolbar: the eye button previews the exact SQL.
      await clickSel(b, 'button[aria-label="Preview pending changes"]');
      await waitText(b, 'UPDATE "shop"."customers" SET "name" = \'E2E Edited\' WHERE "id" = 1 AND "name" = ');
      await clickText(b, 'Commit', { exact: true });
      await waitText(b, 'Committed 1 row');
    }));

  test('the edit is really in the database', () =>
    fail('edit-verify', async () => {
      await clickText(b, 'Query', { selector: '[role=tab]' });
      await runSql(b, 'select name from customers where id = 1');
      await until(async () => /E2E Edited/.test(await resultsText(b)), 'edited value');
      await runSql(b, "update customers set name = 'Customer 1' where id = 1");
    }));

  test('stale edits are detected as conflicts and nothing is overwritten', () =>
    fail('conflict', async () => {
      await clickText(b, 'customers', { exact: true, selector: '[role=tab]' });
      await clickSel(b, 'button[aria-label="Refresh"]');
      await waitText(b, 'user2@example.com');
      await b.execute(() => {
        const header = [...document.querySelectorAll('[role=columnheader]')].map((h) => h.innerText.trim());
        const idx = header.indexOf('name');
        const row = [...document.querySelectorAll('[role=row]')].find((r) => [...r.querySelectorAll('[role=gridcell]')].some((c) => c.innerText.trim() === 'user2@example.com'));
        row.querySelectorAll('[role=gridcell]')[idx].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      });
      await sleep(300);
      await b.execute(() => {
        const input = document.querySelector('[role=gridcell] input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Mine');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      await waitText(b, '1 pending change');
      // Someone else changes the same row meanwhile.
      await clickText(b, 'Query', { selector: '[role=tab]' });
      await runSql(b, "update customers set name = 'Theirs' where id = 2");
      await sleep(500);
      await clickText(b, 'customers', { exact: true, selector: '[role=tab]' });
      // Pending changes live in the top toolbar: the eye button previews the exact SQL.
      await clickSel(b, 'button[aria-label="Preview pending changes"]');
      await clickText(b, 'Commit', { exact: true });
      await waitText(b, 'changed or deleted by someone else');
      await clickText(b, 'Query', { selector: '[role=tab]' });
      await runSql(b, 'select name from customers where id = 2');
      await until(async () => /Theirs/.test(await resultsText(b)), "other user's value kept");
      await runSql(b, "update customers set name = 'Customer 2' where id = 2");
    }));
});

describe('production safety', () => {
  test('plaintext production connections are refused', () =>
    fail('prod-plaintext', async () => {
      await openLauncher();
      await newPgConnection('E2E Prod Plain', { env: 'Production' });
      // Tagging a remote connection Production raises PREFERRED to REQUIRED by itself…
      await waitText(b, 'because this connection is tagged Production');
      const raised = await b.execute(() => document.querySelector('[role=dialog] select[aria-label="SSL mode"]')?.value);
      assert.equal(raised, 'required');
      // …and choosing a mode that can fall back to plaintext again is still refused.
      await fill(b, 'SSL mode', 'preferred');
      await clickText(b, 'Connect', { exact: true });
      await waitText(b, 'SSL mode PREFERRED can send data unencrypted');
      await clickSel(b, 'button[aria-label="Close"]');
    }));

  test('production connection over verified TLS: banner + typed confirmation for destructive SQL', () =>
    fail('prod', async () => {
      await newPgConnection('E2E Prod', { env: 'Production', tls: true });
      await clickText(b, 'Test', { exact: true });
      await waitText(b, 'Connected to PostgreSQL');
      await clickText(b, 'Connect', { exact: true });
      await waitText(b, 'PRODUCTION');
      await newQueryTab();
      await runSql(b, 'update customers set vip = vip');
      await waitText(b, 'Review before running');
      await waitText(b, 'affects every row');
      const disabled = await b.execute(() => [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Run anyway')?.disabled);
      assert.equal(disabled, true, 'Run anyway must be disabled until the name is typed');
      await b.execute(() => {
        const input = [...document.querySelectorAll('[role=dialog] input')].pop();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'E2E Prod');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await clickText(b, 'Run anyway', { exact: true });
      await until(async () => /500 rows affected/.test(await pageText(b)) || /Completed/.test(await pageText(b)), 'update executed');
    }));

  test('cancelling the confirmation runs nothing', () =>
    fail('prod-cancel', async () => {
      await runSql(b, 'delete from order_items');
      await waitText(b, 'Review before running');
      await clickText(b, 'Cancel', { exact: true });
      await runSql(b, 'select count(*) as n from order_items');
      await until(async () => /\b5000\b/.test(await resultsText(b)), 'rows still present');
    }));

  test('read-only connection blocks writes', () =>
    fail('readonly', async () => {
      await openLauncher();
      await newPgConnection('E2E ReadOnly', { readOnly: true });
      await clickText(b, 'Connect', { exact: true });
      await until(async () => (await pageText(b)).includes('customers'), 'connected');
      await newQueryTab();
      await runSql(b, "insert into customers(name) values ('x')");
      await waitText(b, 'Blocked by safety policy');
      await clickText(b, 'Close', { exact: true }).catch(() => clickSel(b, 'button[aria-label="Close"]'));
    }));
});

describe('SSL modes', () => {
  test('the SSL mode list shows the five standard modes, PREFERRED by default', () =>
    fail('ssl-list', async () => {
      await openLauncher();
      await clickText(b, 'Create a new connection');
      await clickSel(b, 'button[title="MySQL"]');
      await waitText(b, 'MySQL Connection');
      const s = await b.execute(() => {
        const el = document.querySelector('[role=dialog] select[aria-label="SSL mode"]');
        return el && { value: el.value, labels: [...el.options].map((o) => o.textContent) };
      });
      assert.deepEqual(s?.labels, ['PREFERRED', 'DISABLED', 'REQUIRED', 'VERIFY-CA', 'VERIFY-IDENTITY']);
      assert.equal(s?.value, 'preferred');
      await screenshot(b, 'connection-form'); // visual record (artifacts/)
    }));

  test('MySQL connection with SSL mode REQUIRED connects encrypted', () =>
    fail('mysql-required', async () => {
      await fill(b, 'Name', 'E2E MySQL TLS');
      await fill(b, 'Host/IP', 'mysql');
      await fill(b, 'User', 'dbs_test');
      await fill(b, 'Password', 'dbs_test');
      await fill(b, 'Database', 'dbs_test');
      await fill(b, 'SSL mode', 'required');
      await waitText(b, 'server certificate is not verified');
      await clickText(b, 'Test', { exact: true });
      await waitText(b, 'Connected to');
      await clickText(b, 'Connect', { exact: true });
      await until(async () => (await pageText(b)).includes('orders'), 'mysql tree');
      await newQueryTab();
      await runSql(b, "show session status like 'Ssl_cipher'");
      await until(async () => /(TLS_|ECDHE|AES)/.test(await resultsText(b)), 'encrypted session (Ssl_cipher)');
    }));
});

describe('multiple databases', () => {
  test('MySQL via URL', () =>
    fail('mysql', async () => {
      await openLauncher();
      await connectUrl('mysql://dbs_test:dbs_test@mysql:3306/dbs_test?ssl-mode=DISABLED');
      await until(async () => (await pageText(b)).includes('orders'), 'mysql tree');
      await newQueryTab();
      await runSql(b, 'select count(*) as n from orders');
      await until(async () => /\b2000\b/.test(await resultsText(b)), 'mysql count');
    }));

  test('MariaDB via URL', () =>
    fail('mariadb', async () => {
      await openLauncher();
      await connectUrl('mariadb://dbs_test:dbs_test@mariadb:3306/dbs_test?ssl-mode=DISABLED');
      await until(async () => (await pageText(b)).includes('MariaDB') || (await pageText(b)).includes('dbs_test@mariadb'), 'mariadb session');
      await newQueryTab();
      await runSql(b, 'select version() as v, 1 + 1 as two');
      await until(async () => /MariaDB/.test(await resultsText(b)), 'mariadb version');
    }));

  test('SQLite via URL', () =>
    fail('sqlite', async () => {
      await openLauncher();
      await connectUrl(`sqlite://${process.env.E2E_SQLITE}`);
      await until(async () => (await pageText(b)).includes('customer_totals'), 'sqlite tree');
    }));

  test('Redis via URL', () =>
    fail('redis', async () => {
      await openLauncher();
      await connectUrl('redis://redis:6379/0');
      await until(async () => b.execute(() => document.querySelectorAll('nav[aria-label="Open connections"] button[aria-current]').length >= 7), 'redis session');
      await newQueryTab();
      await runSql(b, 'SET e2e:greeting "hello world"\nGET e2e:greeting');
      await until(async () => /hello world/.test(await resultsText(b)), 'redis value');
    }));

  test('connection rail lists every open database and keeps tabs per database', () =>
    fail('rail', async () => {
      const labels = await b.execute(() => [...document.querySelectorAll('nav[aria-label="Open connections"] button[aria-current]')].map((x) => x.getAttribute('aria-label')));
      assert.ok(labels.length >= 7, `rail: ${labels}`);
      await clickSel(b, 'nav[aria-label="Open connections"] button[aria-label^="E2E Postgres"]');
      await until(async () => b.execute(() => [...document.querySelectorAll('[role=tablist][aria-label="Open tabs"] [role=tab]')].some((t) => t.innerText.includes('customers'))), 'postgres tabs restored');
      const tabs = await b.execute(() => [...document.querySelectorAll('[role=tablist][aria-label="Open tabs"] [role=tab]')].map((t) => t.innerText.trim()));
      assert.ok(!tabs.some((t) => /mysql/i.test(t)), `only postgres tabs shown: ${tabs}`);
    }));
});

describe('tools', () => {
  test('command palette opens a table', () =>
    fail('palette', async () => {
      await b.keys(['Control', 'p']); // Ctrl+K is "Open database"; Ctrl+P / Ctrl+Shift+P open the palette
      await until(() => b.execute(() => !!document.querySelector('[aria-label="Command palette"]')), 'palette');
      await b.execute(() => {
        const input = document.querySelector('[aria-label="Command palette"] input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'shop.products');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await sleep(300);
      await b.keys(['Enter']);
      await waitText(b, 'SKU-0001');
    }));

  test('ER diagram renders tables and relationships', () =>
    fail('er', async () => {
      await clickSel(b, 'button[aria-label="ER diagram"]');
      await until(() => b.execute(() => document.querySelectorAll('svg[aria-label="Entity relationship diagram"] path[marker-end]').length >= 3), 'FK edges');
    }));

  test('monitor lists live sessions', () =>
    fail('monitor', async () => {
      await clickSel(b, 'button[aria-label="Monitor"]');
      await until(async () => /Sessions \(\d+\)/.test(await pageText(b)), 'sessions');
      await waitText(b, 'Largest tables');
    }));

  test('audit log records activity and the hash chain verifies', () =>
    fail('audit', async () => {
      await clickSel(b, 'button[aria-label="Audit log"]');
      await waitText(b, 'safety_confirmed');
      await waitText(b, 'data_edited');
      await clickText(b, 'Verify integrity');
      await waitText(b, 'Chain intact');
    }));

  test('settings: dark theme applies', () =>
    fail('settings', async () => {
      await clickSel(b, 'button[aria-label="Settings"]');
      await fill(b, 'Theme', 'dark').catch(async () => {
        await b.execute(() => {
          const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'hc'));
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'dark');
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
      await until(() => b.execute(() => document.documentElement.classList.contains('dark')), 'dark class');
      await screenshot(b, 'dark-theme');
    }));
});
