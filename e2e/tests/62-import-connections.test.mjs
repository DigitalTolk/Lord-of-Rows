// "Import connections…" on the launcher: a DBeaver data-sources.json found in its default
// Linux location (synthetic, written before launch) and a pasted list of connection URLs.
// Checks the preview (engine, env pill, group, unsupported rows disabled, "already exists"),
// the import result, and that imported connections land in their groups.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { clickText, launch, pageText, screenshot, until, waitText } from '../lib.mjs';

const DATA_HOME = process.env.XDG_DATA_HOME ?? path.join(process.env.HOME, '.local/share');
const DBEAVER_DIR = path.join(DATA_HOME, 'DBeaverData/workspace6/General/.dbeaver');

const DBEAVER = {
  folders: { 'E2E Imported': {} },
  connections: {
    'postgres-jdbc-e2e1': {
      provider: 'postgresql',
      driver: 'postgres-jdbc',
      name: 'E2E DBeaver Prod',
      folder: 'E2E Imported',
      configuration: {
        host: 'pg-prod.example.com',
        port: '5432',
        database: 'billing',
        user: 'billing',
        type: 'prod',
        handlers: { ssl: { enabled: true, properties: { sslMode: 'verify-full' } } },
      },
    },
    'mysql8-e2e2': {
      provider: 'mysql',
      driver: 'mysql8',
      name: 'E2E DBeaver Dev',
      folder: 'E2E Imported',
      configuration: { host: 'mysql-dev.example.com', port: '3306', database: 'events', user: 'dev', type: 'dev' },
    },
    'oracle-e2e3': {
      provider: 'oracle',
      driver: 'oracle_thin',
      name: 'E2E DBeaver Oracle',
      configuration: { host: 'erp.example.com', port: '1521', database: 'ORCL', type: 'dev' },
    },
  },
};

const URLS = ['# E2E import', 'postgres://e2e_url@pg-url.example.com:5432/url_app?sslmode=require', 'mysql://e2e_url@localhost/url_local'].join('\n');

let b;
before(async () => {
  fs.mkdirSync(DBEAVER_DIR, { recursive: true });
  fs.writeFileSync(path.join(DBEAVER_DIR, 'data-sources.json'), JSON.stringify(DBEAVER, null, 2));
  b = await launch();
  await waitText(b, 'Create a new connection');
});
after(async () => {
  await b?.deleteSession();
  fs.rmSync(path.join(DBEAVER_DIR, 'data-sources.json'), { force: true });
});

async function fail(name, fn) {
  try {
    await fn();
  } catch (e) {
    await screenshot(b, `FAIL-${name}`);
    throw e;
  }
}

/** Text of the import dialog. */
const dialogText = () => b.execute(() => document.querySelector('[role=dialog]')?.innerText ?? '');

/** State of a row checkbox (by the connection name). */
const rowBox = (name) =>
  b.execute((name) => {
    const el = document.querySelector(`[role=dialog] input[type=checkbox][aria-label="Import ${name}"]`);
    return el ? { checked: el.checked, disabled: el.disabled } : null;
  }, name);

/** Visible launcher rows, by their name line. */
const rowNames = () =>
  b.execute(() => [...document.querySelectorAll('[role=listbox] [role=option]')].filter((e) => e.offsetParent !== null).map((e) => e.querySelector('.font-medium')?.innerText ?? ''));

async function openImport() {
  await clickText(b, 'Import connections…', { exact: true });
  await until(async () => (await dialogText()).includes('Found on this computer'), 'import dialog');
}

describe('import connections', () => {
  test('DBeaver: detected with a count, preview, import into the original group', () =>
    fail('import-dbeaver', async () => {
      await openImport();
      await until(async () => (await dialogText()).includes('DBeaver: 3 connections found'), 'detected DBeaver source');
      await clickText(b, 'DBeaver: 3 connections found');
      await until(async () => (await rowBox('E2E DBeaver Prod')) !== null, 'preview rows');
      const text = await dialogText();
      assert.match(text, /pg-prod\.example\.com:5432 : billing/);
      assert.match(text, /PRODUCTION/i);
      assert.match(text, /E2E Imported/);
      assert.match(text, /Will skip: unsupported engine Oracle/);
      assert.deepEqual(await rowBox('E2E DBeaver Prod'), { checked: true, disabled: false });
      assert.deepEqual(await rowBox('E2E DBeaver Dev'), { checked: true, disabled: false });
      assert.deepEqual(await rowBox('E2E DBeaver Oracle'), { checked: false, disabled: true });
      assert.match(text, /Passwords are not imported from DBeaver/);

      await clickText(b, 'Import 2 connections', { exact: true });
      await until(async () => (await dialogText()).includes('Imported 2 connections'), 'result summary');
      await clickText(b, 'Done', { exact: true });
      await until(async () => (await rowNames()).includes('E2E DBeaver Prod'), 'imported connection in the launcher');
      const inGroup = await b.execute(() => {
        const g = document.querySelector(`[role=listbox] [role=group][aria-labelledby="conn-group-${encodeURIComponent('E2E Imported')}"]`);
        return g ? [...g.querySelectorAll('[role=option]')].map((e) => e.querySelector('.font-medium')?.innerText ?? '') : [];
      });
      assert.ok(inGroup.includes('E2E DBeaver Prod') && inGroup.includes('E2E DBeaver Dev'), `grouped: ${inGroup}`);
      const env = await b.execute(() => [...document.querySelectorAll('[role=option]')].find((e) => e.innerText.includes('E2E DBeaver Prod'))?.dataset.env);
      assert.equal(env, 'production', 'production stays production');
    }));

  test('the same source again: rows are marked "already exists" and unchecked', () =>
    fail('import-dbeaver-again', async () => {
      await openImport();
      await clickText(b, 'DBeaver: 3 connections found');
      await until(async () => (await rowBox('E2E DBeaver Prod')) !== null, 'preview rows');
      assert.match(await dialogText(), /Already exists/);
      assert.deepEqual(await rowBox('E2E DBeaver Prod'), { checked: false, disabled: false });
      await clickText(b, 'Cancel', { exact: true });
      await until(async () => !(await dialogText()), 'dialog closed');
    }));

  test('pasted connection URLs', () =>
    fail('import-urls', async () => {
      await openImport();
      await clickText(b, 'Paste connection URLs', { exact: true });
      await until(
        () =>
          b.execute((value) => {
            const label = [...document.querySelectorAll('[role=dialog] label')].find((l) => l.innerText.trim() === 'Connection URLs, one per line');
            const el = label && document.getElementById(label.htmlFor);
            if (!el) return false;
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          }, URLS),
        'URL textarea',
      );
      await clickText(b, 'Preview', { exact: true });
      await until(async () => (await rowBox('url_app@pg-url.example.com')) !== null, 'URL preview rows');
      const text = await dialogText();
      assert.match(text, /Connection URLs: 2 connections/);
      assert.match(text, /pg-url\.example\.com:5432 : url_app/);
      assert.ok(!text.includes('#'), 'comment lines are not rows');
      await clickText(b, 'Import 2 connections', { exact: true });
      await until(async () => (await dialogText()).includes('Imported 2 connections'), 'result summary');
      await clickText(b, 'Done', { exact: true });
      await until(async () => {
        const names = await rowNames();
        return names.includes('url_app@pg-url.example.com') && names.includes('url_local@localhost');
      }, 'URL connections in the launcher');
      assert.ok((await pageText(b)).includes('url_local@localhost'));
    }));

  test('the command palette opens the import dialog', () =>
    fail('import-palette', async () => {
      await b.keys(['Control', 'p']); // Ctrl+P / Ctrl+Shift+P open the palette
      await until(() => b.execute(() => !!document.querySelector('[aria-label="Command palette"]')), 'palette');
      await b.execute(() => {
        const input = document.querySelector('[aria-label="Command palette"] input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Import connections');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await clickText(b, 'Import connections…', { exact: true, selector: '[role=option]' });
      await until(async () => (await dialogText()).includes('Found on this computer'), 'import dialog from the palette');
      await clickText(b, 'Cancel', { exact: true });
    }));
});
