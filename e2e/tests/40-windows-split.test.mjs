// Multiple windows (own tabs + own sessions, sessions closed with the window) and
// split editor panes (independent text/run/results, persisted with the tab).
// Runs after 10-workflows / 20-restore: relies on the saved "E2E Postgres" connection.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { clickSel, dblclickText, launch, pageText, screenshot, sleep, until, waitText } from '../lib.mjs';

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

async function connectPg() {
  await dblclickText(b, 'E2E Postgres');
  await until(async () => (await pageText(b)).includes('customers'), 'connected');
}

async function newQueryTab() {
  await clickSel(b, 'button[aria-label="New SQL query"]');
  await until(() => b.execute(() => !!document.querySelector('[role=tabpanel]:not([hidden]) .monaco-editor')), 'query editor');
  await sleep(500);
}

/** Number of Monaco editors in the visible tab. */
const editorCount = () => b.execute(() => document.querySelectorAll('[role=tabpanel]:not([hidden]) .monaco-editor').length);

/** Set the text of editor pane `n` (1 or 2) in the visible tab. */
async function setPane(n, sql) {
  await until(
    () =>
      b.execute(
        (n, sql) => {
          const pane = document.querySelector(`[role=tabpanel]:not([hidden]) section[aria-label="Editor pane ${n}"]`);
          const node = pane?.querySelector('.monaco-editor');
          const ed = node && globalThis.__monaco?.editor.getEditors().find((e) => e.getContainerDomNode().contains(node) || node.contains(e.getContainerDomNode()));
          if (!ed) return false;
          ed.setValue(sql);
          return true;
        },
        n,
        sql,
      ),
    `editor pane ${n}`,
  );
}

const paneText = (n) => b.execute((n) => document.querySelector(`[role=tabpanel]:not([hidden]) section[aria-label="Editor pane ${n}"]`)?.innerText ?? '', n);

async function runPane(n) {
  await until(
    () =>
      b.execute((n) => {
        const pane = document.querySelector(`[role=tabpanel]:not([hidden]) section[aria-label="Editor pane ${n}"]`);
        const btn = [...(pane?.querySelectorAll('button') ?? [])].find((x) => x.innerText.trim() === 'Run all' && !x.disabled);
        if (!btn) return false;
        btn.click();
        return true;
      }, n),
    `Run all in pane ${n}`,
  );
}

/** Postgres sessions opened by the app, counted from the server side. */
async function appBackends() {
  await setPane(1, "select 'n=' || count(*) as c from pg_stat_activity where application_name = 'Lord of the Rows'");
  await runPane(1);
  const m = await until(async () => /n=(\d+)/.exec(await paneText(1)), 'backend count');
  return Number(m[1]);
}

describe('split editor panes', () => {
  test('split right: each pane has its own text, run and results', () =>
    fail('split-run', async () => {
      await connectPg();
      await newQueryTab();
      assert.equal(await editorCount(), 1);
      await clickSel(b, 'button[aria-label="Split editor right"]');
      await until(async () => (await editorCount()) === 2, 'second editor pane');
      await setPane(1, "select 'left-pane-result' as v");
      await setPane(2, "select 'right-pane-result' as v");
      await runPane(2);
      await until(async () => (await paneText(2)).includes('right-pane-result'), 'pane 2 result');
      assert.ok(!(await paneText(1)).includes('right-pane-result'), 'pane 1 results untouched');
      await runPane(1);
      await until(async () => (await paneText(1)).includes('left-pane-result'), 'pane 1 result');
      assert.ok((await paneText(2)).includes('right-pane-result'), 'pane 2 keeps its results');
      assert.equal(await b.execute(() => document.querySelector('[role=tabpanel]:not([hidden]) [data-split]')?.getAttribute('data-split')), 'right');
    }));

  test('Ctrl+\\ closes and reopens the split; second pane text is kept', () =>
    fail('split-toggle', async () => {
      await b.keys(['Control', '\\']);
      await until(async () => (await editorCount()) === 1, 'split closed');
      await b.keys(['Control', '\\']);
      await until(async () => (await editorCount()) === 2, 'split reopened');
      await until(async () => (await paneText(2)).includes('right-pane-result'), 'pane 2 text restored');
      await clickSel(b, 'button[aria-label="Change split orientation"]');
      await until(() => b.execute(() => document.querySelector('[role=tabpanel]:not([hidden]) [data-split]')?.getAttribute('data-split') === 'down'), 'split down');
      await sleep(1500); // workspace is saved after a 1 s debounce
    }));

  test('split layout and both panes are restored after restart', () =>
    fail('split-restore', async () => {
      await b.deleteSession();
      b = await launch();
      await waitText(b, 'Create a new connection');
      await connectPg();
      await until(() => b.execute(() => [...document.querySelectorAll('[role=tablist][aria-label="Open tabs"] [role=tab]')].some((t) => t.innerText.includes('Query'))), 'restored tabs');
      // Open the restored split tab (the last query tab).
      await b.execute(() => {
        const tabs = [...document.querySelectorAll('[role=tablist][aria-label="Open tabs"] [role=tab]')].filter((t) => t.innerText.includes('Query'));
        tabs.at(-1)?.click();
      });
      await until(async () => (await editorCount()) === 2, 'two panes restored');
      assert.equal(await b.execute(() => document.querySelector('[role=tabpanel]:not([hidden]) [data-split]')?.getAttribute('data-split')), 'down');
      await until(async () => (await paneText(1)).includes('left-pane-result') && (await paneText(2)).includes('right-pane-result'), 'pane texts restored');
    }));
});

describe('multiple windows', () => {
  test('window title names the active connection', () =>
    fail('window-title', async () => {
      await until(async () => (await b.getTitle()) === 'Lord of the Rows — E2E Postgres', 'window title');
    }));

  test('New Window opens an independent workspace; closing it disconnects only its sessions', () =>
    fail('new-window', async () => {
      const main = await b.getWindowHandle();
      const base = await appBackends();
      const before = await b.getWindowHandles();
      await clickSel(b, 'button[aria-label="New window"]');
      const handles = await until(async () => {
        const h = await b.getWindowHandles();
        return h.length > before.length ? h : null;
      }, 'second window handle');
      const second = handles.find((h) => !before.includes(h));
      await b.switchToWindow(second);
      // Fresh workspace: launcher, no restored tabs, no sessions.
      await waitText(b, 'Create a new connection');
      assert.equal(await b.execute(() => document.querySelectorAll('[role=tablist][aria-label="Open tabs"] [role=tab]').length), 0);
      assert.equal(await b.getTitle(), 'Lord of the Rows');
      await connectPg();
      await newQueryTab();
      await setPane(1, "select 'from-second-window' as v");
      await runPane(1);
      await until(async () => (await paneText(1)).includes('from-second-window'), 'query in second window');
      await until(async () => (await b.getTitle()) === 'Lord of the Rows — E2E Postgres', 'second window title');

      // The main window sees the extra backend, and still has its own split tab.
      await b.switchToWindow(main);
      await until(async () => (await appBackends()) > base, 'second window session is open on the server');
      assert.equal(await editorCount(), 2);

      // Close the second window: its session (and only its session) is disconnected.
      await b.switchToWindow(second);
      await b.closeWindow();
      await b.switchToWindow(main);
      await until(async () => (await appBackends()) === base, 'second window session closed', 20000);
      await setPane(2, "select 'main-still-connected' as v");
      await runPane(2);
      await until(async () => (await paneText(2)).includes('main-still-connected'), 'main window session still works');
    }));
});
