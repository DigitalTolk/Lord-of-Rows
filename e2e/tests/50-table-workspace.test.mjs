// Table workspace: filter bar, row detail panel, pending
// changes in the top toolbar, bottom bar, status pill, sidebar sections and
// the schema rail. Runs against the Postgres fixture (schema "shop").
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { clickSel, clickText, fill, launch, pageText, resultsText, screenshot, sleep, until, waitText } from '../lib.mjs';

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
    await screenshot(b, `FAIL-50-${name}`);
    throw e;
  }
}

const ANY = '\u0000any';
const RAW = '\u0000raw';

/** Set the n-th (0-based) visible control with this aria-label inside the filter bar. */
async function setFilterField(label, n, value) {
  await until(
    () =>
      b.execute(
        (label, n, value) => {
          const bar = document.querySelector('[role=tabpanel]:not([hidden]) [role=search]');
          const el = bar && [...bar.querySelectorAll(`[aria-label="${label}"]`)].filter((e) => e.offsetParent !== null)[n];
          if (!el) return false;
          const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
          el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
          return true;
        },
        label,
        n,
        value,
      ),
    `filter field ${label}#${n}`,
  );
  await sleep(150);
}

const status = () => b.execute(() => document.querySelector('[role=tabpanel]:not([hidden]) [aria-live=polite]')?.innerText ?? '');
const waitStatus = (re, what) => until(async () => re.test(await resultsText(b)), what, 20000);

async function selectRowWithText(text) {
  await until(
    () =>
      b.execute((text) => {
        const row = [...document.querySelectorAll('[role=tabpanel]:not([hidden]) [role=row]')].find((r) => [...r.querySelectorAll('[role=gridcell]')].some((c) => c.innerText.trim() === text));
        const cell = row?.querySelector('[role=gridcell]');
        if (!cell) return false;
        cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        return true;
      }, text),
    `row with ${text}`,
  );
  await sleep(200);
}

async function setDetailField(name, value) {
  await until(
    () =>
      b.execute(
        (name, value) => {
          const panel = document.querySelector('[role=tabpanel]:not([hidden]) aside[aria-label="Row details"]');
          const el = panel?.querySelector(`[data-field="${name}"] input, [data-field="${name}"] textarea`);
          if (!el) return false;
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
          el.focus();
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        },
        name,
        value,
      ),
    `detail field ${name}`,
  );
  await sleep(200);
  // Leaving the field commits it to the staged edits (separate task so React has re-rendered).
  await b.execute((name) => document.querySelector(`aside[aria-label="Row details"] [data-field="${name}"] :is(input, textarea)`)?.blur(), name);
  await sleep(250);
}

describe('table workspace', () => {
  test('open customers via URL connection; bottom bar shows count and selection', () =>
    fail('open', async () => {
      await clickText(b, 'Connect from URL');
      await fill(b, 'Import from URL', 'postgresql://dbs_test:dbs_test@postgres:5432/dbs_test?sslmode=disable');
      await clickText(b, 'OK', { exact: true });
      await until(async () => (await pageText(b)).includes('customers'), 'object tree');
      await clickText(b, 'customers', { exact: true, selector: '[role=treeitem]' });
      await waitText(b, 'user1@example.com');
      await waitStatus(/0 of ~?500 rows selected/, 'row status');
      await selectRowWithText('user1@example.com');
      await waitStatus(/1 of ~?500 rows selected/, 'one selected');
    }));

  test('status pill shows engine, TLS state, connection, schema and table', () =>
    fail('pill', async () => {
      const pill = await b.execute(() => document.querySelector('[data-testid=status-pill]')?.innerText ?? '');
      assert.match(pill, /\|\s*PostgreSQL \d+/);
      assert.match(pill, /no TLS/);
      assert.match(pill, /: dbs_test : shop : customers/);
      // Plaintext to a non-loopback host carries the warning marker.
      const warn = await b.execute(() => !!document.querySelector('[data-testid=status-pill] [aria-label="Unencrypted connection to a remote host"]'));
      assert.ok(warn, 'warning icon');
    }));

  test('filter bar: column filter, second row with AND, Any column', () =>
    fail('filter', async () => {
      await clickSel(b, '[role=tabpanel]:not([hidden]) button[aria-label="Filter bar"]');
      await until(() => b.execute(() => !!document.querySelector('[role=tabpanel]:not([hidden]) [role=search]')), 'filter bar');
      await setFilterField('Column', 0, 'country');
      await setFilterField('Operator', 0, 'eq');
      await setFilterField('Value', 0, 'GB');
      await clickText(b, 'Apply', { exact: true });
      await waitStatus(/of 72 rows selected/, '72 GB customers');
      await clickSel(b, '[role=tabpanel]:not([hidden]) [role=search] button[aria-label="Add filter"]');
      await setFilterField('Column', 1, 'vip');
      await setFilterField('Operator', 1, 'eq');
      await setFilterField('Value', 1, 'true');
      await clickText(b, 'Apply All', { exact: true });
      await waitStatus(/of 7 rows selected/, 'GB AND vip');
      // Any column (OR over all columns cast to text).
      await clickSel(b, '[role=tabpanel]:not([hidden]) [role=search] button[aria-label="Remove filter"]');
      await setFilterField('Column', 0, ANY);
      await setFilterField('Operator', 0, 'contains');
      await setFilterField('Value', 0, 'user42@');
      await clickText(b, 'Apply All', { exact: true });
      await waitStatus(/of 1 rows selected/, 'any column match');
      await waitText(b, 'user42@example.com');
    }));

  test('raw SQL filter: valid expression applies, statements are rejected by the backend', () =>
    fail('raw', async () => {
      await setFilterField('Column', 0, RAW);
      await setFilterField('Raw SQL', 0, 'id <= 10 OR id = 500');
      await clickText(b, 'Apply All', { exact: true });
      await waitStatus(/of 11 rows selected/, 'raw filter rows');
      // SQL button shows the generated SELECT.
      await clickText(b, 'SQL', { exact: true });
      await waitText(b, 'SELECT * FROM "shop"."customers" WHERE (id <= 10 OR id = 500) ORDER BY "id" ASC');
      await clickText(b, 'Open in query tab', { exact: true });
      await until(async () => b.execute(() => !!document.querySelector('[role=tabpanel]:not([hidden]) .monaco-editor')), 'query tab with SQL');
      await clickText(b, 'customers', { exact: true, selector: '[role=tab]' });
      await setFilterField('Raw SQL', 0, '1=1; DROP TABLE customers');
      await clickText(b, 'Apply All', { exact: true });
      await waitText(b, 'Raw SQL filter rejected');
      await setFilterField('Raw SQL', 0, "id IN (DELETE FROM shop.orders RETURNING customer_id)");
      await clickText(b, 'Apply All', { exact: true });
      await waitText(b, 'DELETE is not allowed');
      // Still 11 rows: nothing changed.
      await waitStatus(/of 11 rows selected/, 'previous filter kept');
      await clickText(b, 'Clear', { exact: true });
      await waitStatus(/of ~?500 rows selected/, 'filters cleared');
    }));

  test('row detail panel edits stage like grid edits; top toolbar previews, discards and commits', () =>
    fail('detail', async () => {
      await clickSel(b, '[role=tabpanel]:not([hidden]) button[aria-label="Row details"]');
      await selectRowWithText('user3@example.com');
      await until(() => b.execute(() => !!document.querySelector('aside[aria-label="Row details"] [data-field="email"]')), 'detail fields');
      const label = await b.execute(() => document.querySelector('aside[aria-label="Row details"] [data-field="id"]')?.innerText ?? '');
      assert.match(label, /longlong/);
      await setDetailField('name', 'Detail Edit');
      await waitText(b, '1 pending change');
      // The grid cell shows the staged value.
      await until(() => b.execute(() => [...document.querySelectorAll('[role=gridcell]')].some((c) => c.innerText.trim() === 'Detail Edit')), 'grid cell staged');
      // Eye button: exact SQL, then Discard.
      await clickSel(b, 'button[aria-label="Preview pending changes"]');
      await waitText(b, 'UPDATE "shop"."customers" SET "name" = \'Detail Edit\' WHERE "id" = 3');
      await clickText(b, 'Discard', { exact: true });
      await until(async () => !(await pageText(b)).includes('1 pending change'), 'discarded');
      // Edit again and commit directly from the toolbar.
      await setDetailField('name', 'Detail Edit');
      await waitText(b, '1 pending change');
      await clickSel(b, 'button[aria-label="Commit pending changes"]');
      await waitText(b, 'Committed 1 row');
      // Restore the fixture value.
      await selectRowWithText('user3@example.com');
      await setDetailField('name', 'Customer 3');
      await waitText(b, '1 pending change');
      await clickSel(b, 'button[aria-label="Commit pending changes"]');
      await waitText(b, 'Committed 1 row');
      await clickSel(b, '[role=tabpanel]:not([hidden]) button[aria-label="Row details"]');
    }));

  test('bottom bar Index view lists the table indexes', () =>
    fail('index', async () => {
      await clickText(b, 'Index', { exact: true, selector: '[role=tab]' });
      await waitText(b, 'customers_pkey');
      await waitText(b, 'customers_email_key');
      await clickText(b, 'Data', { exact: true, selector: '[role=tab]' });
      await waitText(b, 'user1@example.com');
    }));

  test('sidebar Items | Queries | History and the schema rail', () =>
    fail('sidebar', async () => {
      await clickText(b, 'History', { exact: true, selector: '[role=tab]' });
      await until(async () => /No query history|History/.test(await pageText(b)), 'history section');
      await clickText(b, 'Queries', { exact: true, selector: '[role=tab]' });
      await sleep(300);
      await clickText(b, 'Items', { exact: true, selector: '[role=tab]' });
      await until(async () => (await pageText(b)).includes('revenue_by_country'), 'object tree back');
      const current = await b.execute(() => document.querySelector('[role=listbox][aria-label="Databases"] [aria-selected=true]')?.getAttribute('title'));
      assert.equal(current, 'shop');
      // Each entry is a cylinder icon with the schema name as its label.
      const label = await b.execute(() => document.querySelector('[role=listbox][aria-label="Databases"] [title="shop"]')?.innerText.trim());
      assert.equal(label, 'shop');
      // Switching schema in the sidebar adds it to the rail; clicking a rail entry switches back.
      await fill(b, 'Schemas', 'public');
      await until(() => b.execute(() => document.querySelector('[role=listbox][aria-label="Databases"] [title="public"]')?.getAttribute('aria-selected') === 'true'), 'public in rail, selected');
      await clickSel(b, '[role=listbox][aria-label="Databases"] [title="shop"]');
      await until(() => b.execute(() => document.querySelector('select[aria-label="Schemas"]')?.value === 'shop'), 'schema back');
      assert.ok(typeof (await status()) === 'string');
    }));
});
