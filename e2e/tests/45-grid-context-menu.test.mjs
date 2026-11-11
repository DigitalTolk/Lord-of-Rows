// Data grid context menu: copy as SQL, Set Value ▸ NULL,
// Duplicate, Quick Filter, Delete — against the SQLite fixture from run.sh
// (customers(id INTEGER PK, name NOT NULL, email UNIQUE), orders(id INTEGER PK, customer_id FK, total)).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { clickText, fill, launch, pageText, resultsText, runSql, screenshot, sleep, until, waitText } from '../lib.mjs';

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
    await screenshot(b, `FAIL-45-${name}`);
    throw e;
  }
}

/** Dispatch a mouse event on the grid cell in the row containing `rowText`, column `col`. */
async function cellEvent(type, rowText, col, init = {}) {
  await until(
    () =>
      b.execute(
        (type, rowText, col, init) => {
          const panel = document.querySelector('[role=tabpanel]:not([hidden])') ?? document;
          const header = [...panel.querySelectorAll('[role=columnheader]')].map((h) => h.innerText.trim());
          const idx = header.indexOf(col);
          const row = [...panel.querySelectorAll('[role=row]')].find((r) => [...r.querySelectorAll('[role=gridcell]')].some((c) => c.innerText.trim() === rowText));
          const cell = row?.querySelectorAll('[role=gridcell]')[idx];
          if (!cell) return false;
          const r = cell.getBoundingClientRect();
          cell.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: type === 'contextmenu' ? 2 : 0, clientX: r.left + 5, clientY: r.top + 5, ...init }));
          return true;
        },
        type,
        rowText,
        col,
        init,
      ),
    `cell ${rowText}/${col}`,
  );
  await sleep(200);
}

async function contextMenu(rowText, col) {
  await cellEvent('mousedown', rowText, col);
  await cellEvent('contextmenu', rowText, col);
  await until(() => b.execute(() => !!document.querySelector('[role=menu][aria-label="Cell actions"]')), 'context menu');
}

async function gridKey(key, code, mods = {}) {
  await b.execute(
    (key, code, mods) => {
      const grid = document.querySelector('[role=tabpanel]:not([hidden]) [role=grid]') ?? document.querySelector('[role=grid]');
      grid.focus();
      grid.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...mods }));
    },
    key,
    code,
    mods,
  );
  await sleep(250);
}

async function commit() {
  await clickText(b, 'Commit…');
  await clickText(b, 'Commit', { exact: true });
  await until(async () => !(await pageText(b)).includes('pending change'), 'pending changes committed');
  await waitText(b, 'Committed');
}

async function openTable(name) {
  await clickText(b, name, { exact: true, selector: '[role=treeitem],[role=tab]' });
  await sleep(500);
}

async function sql(text, expect) {
  await clickText(b, 'New SQL query', { selector: 'button' }).catch(() => b.execute(() => document.querySelector('button[aria-label="New SQL query"]')?.click()));
  await until(() => b.execute(() => !!document.querySelector('[role=tabpanel]:not([hidden]) .monaco-editor')), 'query editor');
  await sleep(400);
  await runSql(b, text);
  await until(async () => expect.test(await resultsText(b)), `query result ${expect}`);
}

describe('grid context menu (SQLite)', () => {
  test('connect to the SQLite fixture', () =>
    fail('connect', async () => {
      await clickText(b, 'Connect from URL');
      await fill(b, 'Import from URL', `sqlite://${process.env.E2E_SQLITE}`);
      await clickText(b, 'OK', { exact: true });
      await until(async () => (await pageText(b)).includes('customer_totals'), 'sqlite tree');
      await openTable('customers');
      await waitText(b, 'ada@example.com');
    }));

  test('Copy Rows As ▸ SQL INSERT statements puts escaped SQL on the clipboard', () =>
    fail('copy-sql', async () => {
      // Capture clipboard writes (WebDriver cannot read the OS clipboard).
      await b.execute(() => {
        globalThis.__clip = null;
        navigator.clipboard.writeText = async (s) => {
          globalThis.__clip = s;
        };
      });
      await contextMenu('Ada', 'name');
      await clickText(b, 'Copy Rows As', { selector: '[role=menuitem]' });
      await clickText(b, 'SQL INSERT statements', { selector: '[role=menuitem]' });
      const clip = await until(() => b.execute(() => globalThis.__clip), 'clipboard text');
      assert.match(clip, /^INSERT INTO ("main"\.)?"customers" \("id", "name", "email"\) VALUES \(1, 'Ada', 'ada@example\.com'\);$/);
    }));

  test('Set Value ▸ NULL stages an edit that commits through review', () =>
    fail('set-null', async () => {
      await contextMenu('grace@example.com', 'email');
      await clickText(b, 'Set Value', { selector: '[role=menuitem]' });
      await clickText(b, 'NULL', { exact: true, selector: '[role=menuitem]' });
      await waitText(b, '1 pending change');
      await commit();
      await sql('select count(*) as n from customers where email is null', /\b1\b/);
    }));

  test('Duplicate (⌘/Ctrl+D) stages a new row without the INTEGER PRIMARY KEY', () =>
    fail('duplicate', async () => {
      await openTable('orders');
      await waitText(b, '99.99');
      await cellEvent('mousedown', '99.99', 'total');
      // E2E runs on Linux, where the primary modifier is Ctrl.
      await gridKey('d', 'KeyD', { ctrlKey: true });
      await waitText(b, '1 pending change');
      // The id cell of the new row shows DEFAULT (left to the database).
      assert.match(await resultsText(b), /DEFAULT/);
      await commit();
      await sql('select count(*) as n, max(id) as m from orders where total = 99.99', /\b2\b[\s\S]*\b3\b/);
    }));

  test('Quick Filter ▸ = value filters the table with a bound parameter', () =>
    fail('quick-filter', async () => {
      await openTable('orders');
      await waitText(b, '99.99');
      await contextMenu('10.5', 'total');
      await clickText(b, 'Quick Filter', { selector: '[role=menuitem]' });
      await clickText(b, 'total = 10.5', { selector: '[role=menuitem]' });
      await until(async () => /\b1 rows\b[\s\S]*filtered/.test(await resultsText(b)), 'filtered row count');
      assert.ok(!(await resultsText(b)).includes('99.99'));
      // Widen again through the menu (independent of the filter bar UI): total IS NOT NULL shows every order.
      await contextMenu('10.5', 'total');
      await clickText(b, 'Quick Filter', { selector: '[role=menuitem]' });
      await clickText(b, 'total IS NOT NULL', { selector: '[role=menuitem]' });
      await waitText(b, '99.99');
    }));

  test('Delete key stages deletion of the selected row; commit removes it', () =>
    fail('delete', async () => {
      await openTable('orders');
      await until(async () => ((await resultsText(b)).match(/99\.99/g) ?? []).length >= 2, 'duplicated order visible');
      // Select the last (duplicated) row via its row number, then press Delete.
      await b.execute(() => {
        const headers = [...document.querySelectorAll('[role=tabpanel]:not([hidden]) [role=rowheader]')];
        headers[headers.length - 1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      });
      await sleep(200);
      await gridKey('Delete', 'Delete');
      await waitText(b, '1 pending change');
      await commit();
      await sql('select count(*) as n from orders', /\b2\b/);
    }));
});
