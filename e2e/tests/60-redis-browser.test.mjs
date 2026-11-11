// Key browser for Redis connections: logical databases as schemas (sidebar tree,
// ⌘K picker), the lazily expanded namespace tree, the SCAN-paged key grid with the
// Key pattern bar, the value panel by type, and staged edits previewed as commands
// and committed through the safety policy (a destructive UNLINK asks first).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { clickSel, clickText, fill, launch, pageText, resultsText, runSql, screenshot, sleep, until, waitText } from '../lib.mjs';

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
    await screenshot(b, `FAIL-60-${name}`);
    throw e;
  }
}

/** aria-labels of the visible key-tree items. */
const treeLabels = () => b.execute(() => [...document.querySelectorAll('[role=tree][aria-label="Databases and keys"] [role=treeitem]')].map((x) => x.getAttribute('aria-label') ?? x.innerText.trim()));
/** Click a key-tree item by aria-label (exact) or label prefix. */
async function clickTree(label, { prefix = false } = {}) {
  await until(
    () =>
      b.execute(
        (label, prefix) => {
          const el = [...document.querySelectorAll('[role=tree][aria-label="Databases and keys"] [role=treeitem]')].find((x) => {
            const l = x.getAttribute('aria-label') ?? x.innerText.trim();
            return prefix ? l.startsWith(label) : l === label;
          });
          if (!el) return false;
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        },
        label,
        prefix,
      ),
    `tree item ${label}`,
  );
  await sleep(300);
}
const gridText = () => b.execute(() => [...document.querySelectorAll('[role=tabpanel]:not([hidden]) [role=gridcell]')].map((c) => c.innerText).join('\n'));
const panelText = () => b.execute(() => document.querySelector('[role=tabpanel]:not([hidden]) aside[aria-label="Key value"]')?.innerText ?? '');

describe('redis key browser', () => {
  test('connect, seed typed keys in db0 and db1; the tree lists databases with key counts', () =>
    fail('seed', async () => {
      await clickText(b, 'Connect from URL');
      await fill(b, 'Import from URL', 'redis://redis:6379/0');
      await clickText(b, 'OK', { exact: true });
      await until(async () => (await treeLabels()).some((l) => l.startsWith('db0, ')), 'db0 in the key tree');
      await clickSel(b, 'button[aria-label="New SQL query"]');
      await until(() => b.execute(() => !!document.querySelector('[role=tabpanel]:not([hidden]) .monaco-editor')), 'query editor');
      await sleep(500);
      await runSql(
        b,
        [
          'SET e2e60:cfg "{\\"theme\\":\\"dark\\",\\"n\\":1}"',
          'SET e2e60:user:1 alice',
          'SET e2e60:user:2 bob',
          'HSET e2e60:h f1 v1 f2 v2',
          'SADD e2e60:s a b',
          'ZADD e2e60:z 1 one 2 two',
          'SELECT 1',
          'SET e2e60:db1:only yes',
          'SELECT 0',
        ].join('\n'),
      );
      await until(async () => /OK/.test(await resultsText(b)), 'seed ran');
      await clickSel(b, 'aside button[aria-label="Refresh"]');
      await until(async () => (await treeLabels()).some((l) => /^db1, \d+ key/.test(l)), 'db1 with a key count');
      const labels = await treeLabels();
      assert.ok(labels.some((l) => /^db0, [\d,]+ keys$/.test(l)), `db0 label: ${labels}`);
      assert.ok((await pageText(b)).includes('· '), 'count shown next to the database name');
    }));

  test('expanding db0 shows namespaces lazily; clicking a namespace opens its key grid', () =>
    fail('tree', async () => {
      await clickTree('db0, ', { prefix: true });
      await until(async () => (await treeLabels()).some((l) => l.startsWith('e2e60:, ')), 'namespace e2e60:');
      // The database click opened the key grid for the whole database.
      await until(async () => b.execute(() => [...document.querySelectorAll('[role=tablist][aria-label="Open tabs"] [role=tab]')].some((t) => t.innerText.trim().startsWith('db0'))), 'db0 tab');
      await clickTree('e2e60:, ', { prefix: true });
      await until(async () => (await gridText()).includes('e2e60:cfg'), 'grid lists e2e60 keys');
      const g = await gridText();
      assert.ok(g.includes('hash · 2 fields'), `hash summary: ${g}`);
      assert.ok(g.includes('set · 2 members') && g.includes('zset · 2 members'), 'set/zset summaries');
      assert.ok(!g.includes('e2e60:db1:only'), 'db1 keys are not in db0');
      // Children of the namespace appear under it: sub-namespace user: and leaf keys.
      await until(async () => (await treeLabels()).some((l) => l.startsWith('e2e60:user:, 2 keys')), 'sub-namespace with count');
    }));

  test('the Key pattern bar narrows the scan server-side', () =>
    fail('pattern', async () => {
      await fill(b, 'Glob, e.g. user:*', 'e2e60:user:*');
      await clickText(b, 'Apply', { exact: true, selector: '[role=tabpanel]:not([hidden]) [role=search] button' });
      await until(async () => {
        const g = await gridText();
        return g.includes('e2e60:user:1') && !g.includes('e2e60:cfg');
      }, 'only user keys');
      await waitText(b, '2 matching keys');
    }));

  test('opening a JSON string key pretty-prints its value', () =>
    fail('json', async () => {
      await clickTree('e2e60:cfg');
      await until(async () => (await panelText()).includes('"theme": "dark"'), 'pretty JSON in the value panel');
    }));

  test('hash field removal is staged, previewed as commands and committed', () =>
    fail('edit', async () => {
      await clickTree('e2e60:h');
      await until(async () => (await panelText()).includes('f1'), 'hash fields');
      await clickSel(b, '[role=tabpanel]:not([hidden]) aside button[aria-label="Remove: f1"]');
      await clickSel(b, 'button[aria-label="Preview pending changes"]');
      await until(async () => (await pageText(b)).includes('HDEL "e2e60:h" f1'), 'command preview');
      assert.ok((await pageText(b)).includes('SELECT 0'), 'preview selects the database first');
      // Commit from the preview popover (a dialog: the helpers search inside it while it is open).
      await clickText(b, 'Commit', { exact: true });
      await until(() => b.execute(() => !document.querySelector('[role=dialog]')), 'preview closed');
      await until(async () => !(await panelText()).includes('f1'), 'field removed after commit');
      assert.ok((await panelText()).includes('f2'));
    }));

  test('deleting a key is destructive: confirmation first, then UNLINK', () =>
    fail('delete', async () => {
      await clickTree('e2e60:s');
      await until(async () => (await panelText()).includes('Delete key'), 'set value panel');
      await clickText(b, 'Delete key', { exact: true });
      await clickSel(b, 'button[aria-label="Commit pending changes"]');
      await waitText(b, 'Review before running');
      assert.ok((await pageText(b)).includes('UNLINK "e2e60:s"'), 'the dialog shows the command');
      await clickText(b, 'Run anyway', { exact: true });
      await until(async () => (await panelText()).includes('key not found') || (await panelText()).includes('Select a key'), 'key gone');
    }));

  test('db1 opens from the tree and from the Open database picker', () =>
    fail('db1', async () => {
      await clickTree('db1, ', { prefix: true });
      await until(async () => (await gridText()).includes('e2e60:db1:only'), 'db1 keys');
      await clickSel(b, 'header button[aria-label="Open database"]');
      await until(() => b.execute(() => [...document.querySelectorAll('[role=dialog] [role=option]')].some((o) => o.dataset.name === 'db0' && /keys?/.test(o.innerText))), 'db0 with its key count');
      await clickText(b, 'db0', { selector: '[role=dialog] [role=option]' });
      await clickText(b, 'Open', { exact: true });
      await until(() => b.execute(() => [...document.querySelectorAll('[aria-label="Schemas"] [role=option], [role=listbox] [role=option]')].some((o) => o.getAttribute('aria-selected') === 'true' && o.getAttribute('title')?.startsWith('db0'))), 'db0 active in the rail');
    }));
});
