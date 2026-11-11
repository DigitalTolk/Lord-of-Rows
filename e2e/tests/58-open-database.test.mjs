// "Open database" picker (Cmd+K): toolbar button and Ctrl+K open it, the
// search box filters, ↑/↓ + Enter open a schema (sidebar tree + schema rail follow),
// system schemas sit in their own group, New… creates a schema through the safety
// gate, and Postgres lists the server's other databases. Runs against the Postgres
// fixture (database "dbs_test", schema "shop").
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { clickSel, clickText, fill, launch, pageText, screenshot, sleep, until, waitText } from '../lib.mjs';

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
    await screenshot(b, `FAIL-58-${name}`);
    throw e;
  }
}

const NEW_SCHEMA = `e2e_new_${Date.now() % 100000}`;
const dialogOpen = () => b.execute(() => !!document.querySelector('[role=dialog][aria-labelledby]') && [...document.querySelectorAll('[role=dialog] h2')].some((h) => h.innerText.trim() === 'Open database'));
/** Option names grouped by section, in display order. */
const sections = () =>
  b.execute(() =>
    Object.fromEntries([...document.querySelectorAll('[role=dialog] [role=listbox] [role=group]')].map((g) => [g.dataset.section, [...g.querySelectorAll('[role=option]')].map((o) => o.dataset.name)])),
  );
const activeOption = () =>
  b.execute(() => {
    const input = document.querySelector('[role=dialog] input[role=combobox]');
    return document.getElementById(input?.getAttribute('aria-activedescendant') ?? '')?.dataset.name ?? null;
  });
const keyInSearch = (key) =>
  b.execute((key) => document.querySelector('[role=dialog] input[role=combobox]')?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })), key);

describe('open database picker', () => {
  test('connect; the toolbar button opens the picker with the search box focused', () =>
    fail('open', async () => {
      await clickText(b, 'Connect from URL');
      await fill(b, 'Import from URL', 'postgresql://dbs_test:dbs_test@postgres:5432/dbs_test?sslmode=disable');
      await clickText(b, 'OK', { exact: true });
      await until(async () => (await pageText(b)).includes('customers'), 'object tree');
      await clickSel(b, 'header button[aria-label="Open database"]');
      await until(dialogOpen, 'picker dialog');
      await until(() => b.execute(() => document.activeElement?.getAttribute('placeholder') === 'Search for database…'), 'search focused');
      const s = await sections();
      assert.ok(s.user.includes('shop'), 'user schema listed');
      assert.ok(s.user.includes('public'), 'public listed');
      assert.ok(s.system.includes('pg_catalog') && s.system.includes('information_schema'), 'system schemas grouped');
      assert.ok(!s.user.includes('pg_catalog'), 'system schema not among user schemas');
      assert.ok((s.other ?? []).includes('postgres'), 'other databases on the server');
      assert.ok(!(s.other ?? []).includes('dbs_test'), 'connected database not repeated');
    }));

  test('typing filters, Enter opens; Escape cancels; Ctrl+K reopens', () =>
    fail('keyboard', async () => {
      await fill(b, 'Search for database…', 'pub');
      await until(async () => (await activeOption()) === 'public', 'public highlighted');
      await keyInSearch('Enter');
      await until(async () => !(await dialogOpen()), 'closed after Enter');
      await until(() => b.execute(() => !![...document.querySelectorAll('[role=listbox][aria-label="Databases"] [role=option][aria-selected=true]')].find((o) => o.innerText.trim() === 'public')), 'public active in the schema rail');
      await b.keys(['Control', 'k']);
      await until(dialogOpen, 'Ctrl+K opens the picker');
      await keyInSearch('Escape');
      await until(async () => !(await dialogOpen()), 'Escape closes');
      await b.keys(['Control', 'k']);
      await until(dialogOpen, 'reopened');
      await fill(b, 'Search for database…', 'sho');
      await until(async () => (await activeOption()) === 'shop', 'shop highlighted');
      await keyInSearch('Enter');
      await until(async () => (await pageText(b)).includes('customers'), 'shop tree back');
    }));

  test('New… creates a schema through the safety gate and lists it', () =>
    fail('new', async () => {
      await b.keys(['Control', 'k']);
      await until(dialogOpen, 'picker');
      await clickText(b, 'New…', { exact: true });
      await fill(b, 'New schema', NEW_SCHEMA);
      await clickText(b, 'OK', { exact: true });
      await sleep(500);
      if ((await pageText(b)).includes('Review before running')) await clickText(b, 'Run anyway', { exact: true });
      await until(async () => ((await sections()).user ?? []).includes(NEW_SCHEMA), 'new schema listed');
      await until(async () => (await activeOption()) === NEW_SCHEMA, 'new schema highlighted');
      await keyInSearch('Escape');
      await until(async () => !(await dialogOpen()), 'closed');
    }));
});
