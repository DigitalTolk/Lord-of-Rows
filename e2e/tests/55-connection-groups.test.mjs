// Launcher connection list: groups (create, move into, collapse
// persisted across restarts, rename, colour, delete -> ungrouped), env pills,
// `host : database` subtitles, search and env filter chips, keyboard navigation.
// Runs after 10-workflows: relies on the saved "E2E Postgres" connection (host "postgres", db "dbs_test").
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
    await screenshot(b, `FAIL-${name}`);
    throw e;
  }
}

const GROUP = 'E2E Group';

/** Visible option rows in the launcher, by their name line. */
const rowNames = () =>
  b.execute(() => [...document.querySelectorAll('[role=listbox] [role=option]')].filter((e) => e.offsetParent !== null).map((e) => e.querySelector('.font-medium')?.innerText ?? ''));

/** The group header (role=button, aria-expanded) whose label starts with `name,`. */
const headerState = (name) =>
  b.execute((name) => {
    const h = [...document.querySelectorAll('[role=listbox] [aria-expanded]')].find((e) => (e.getAttribute('aria-label') ?? '').startsWith(name + ','));
    return h ? h.getAttribute('aria-expanded') : null;
  }, name);

/** Right-click a connection row (`kind: 'row'`) or a group header (`kind: 'header'`) by name. */
async function contextMenuOn(kind, name) {
  await until(
    () =>
      b.execute(
        (kind, name) => {
          const el =
            kind === 'row'
              ? [...document.querySelectorAll('[role=listbox] [role=option]')].find((e) => e.querySelector('.font-medium')?.innerText === name)
              : [...document.querySelectorAll('[role=listbox] [aria-expanded]')].find((e) => (e.getAttribute('aria-label') ?? '').startsWith(name + ','));
          if (!el) return false;
          const r = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }));
          return true;
        },
        kind,
        name,
      ),
    `context menu on ${kind} "${name}"`,
  );
  await sleep(250);
}

describe('connection groups', () => {
  test('rows show the env pill and a host : database subtitle', () =>
    fail('groups-row', async () => {
      const text = await b.execute(() => [...document.querySelectorAll('[role=listbox] [role=option]')].find((e) => e.innerText.includes('E2E Postgres'))?.innerText ?? '');
      assert.match(text, /postgres : dbs_test/);
      assert.match(text, /LOCAL|DEVELOPMENT|TESTING|STAGING|PRODUCTION|CUSTOM/i);
    }));

  test('create a group from the toolbar and move a connection in via "Move to group"', () =>
    fail('groups-create', async () => {
      await clickSel(b, 'button[aria-label="New group"]');
      await fill(b, 'New group', GROUP);
      await clickText(b, 'OK', { exact: true });
      await until(async () => (await headerState(GROUP)) !== null, 'new group header');
      await contextMenuOn('row', 'E2E Postgres');
      await clickText(b, 'Move to group', { selector: '[role=menuitem]' });
      await clickText(b, GROUP, { exact: true, selector: '[role=menuitem]' });
      await until(
        () => b.execute((g) => !!document.querySelector(`[role=listbox] [role=group][aria-labelledby="conn-group-${encodeURIComponent(g)}"] [role=option]`), GROUP),
        'connection inside the group',
      );
    }));

  test('collapse state persists across an app restart', () =>
    fail('groups-collapse', async () => {
      await b.execute((name) => {
        const h = [...document.querySelectorAll('[role=listbox] [aria-expanded]')].find((e) => (e.getAttribute('aria-label') ?? '').startsWith(name + ','));
        h?.click();
      }, GROUP);
      await until(async () => (await headerState(GROUP)) === 'false', 'collapsed');
      assert.ok(!(await rowNames()).includes('E2E Postgres'));
      await sleep(500);
      await b.deleteSession();
      b = await launch();
      await waitText(b, 'Create a new connection');
      await until(async () => (await headerState(GROUP)) === 'false', 'still collapsed after restart');
      // Expand again with the keyboard (→ on the focused header).
      await b.execute((name) => {
        const h = [...document.querySelectorAll('[role=listbox] [aria-expanded]')].find((e) => (e.getAttribute('aria-label') ?? '').startsWith(name + ','));
        h?.focus();
        h?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      }, GROUP);
      await until(async () => (await headerState(GROUP)) === 'true', 'expanded with →');
      assert.ok((await rowNames()).includes('E2E Postgres'));
    }));

  test('search hides groups without matches; env chips filter', () =>
    fail('groups-filter', async () => {
      await fill(b, 'Search', 'zzz-no-such-connection');
      await until(async () => (await headerState(GROUP)) === null, 'group hidden while no match');
      await fill(b, 'Search', 'dbs_test');
      await until(async () => (await headerState(GROUP)) !== null, 'group shown for a database match');
      await fill(b, 'Search', '');
      const env = await b.execute(() => [...document.querySelectorAll('[role=option]')].find((e) => e.innerText.includes('E2E Postgres'))?.dataset.env);
      const other = env === 'production' ? 'Local' : 'Prod';
      await clickText(b, other, { exact: true, selector: '[role=group] button[aria-pressed]' });
      await until(async () => !(await rowNames()).includes('E2E Postgres'), `hidden by the ${other} chip`);
      await clickText(b, 'All', { exact: true, selector: '[role=group] button[aria-pressed]' });
      await until(async () => (await rowNames()).includes('E2E Postgres'), 'All restores');
    }));

  test('rename and colour the group, then delete it (connections move to ungrouped)', () =>
    fail('groups-rename-delete', async () => {
      await contextMenuOn('header', GROUP);
      await clickText(b, 'Rename…', { selector: '[role=menuitem]' });
      await fill(b, 'Rename group', GROUP + ' 2');
      await clickText(b, 'OK', { exact: true });
      await until(async () => (await headerState(GROUP + ' 2')) !== null, 'renamed header');

      await contextMenuOn('header', GROUP + ' 2');
      await clickText(b, 'Colour', { selector: '[role=menuitem]' });
      await clickText(b, 'Red', { exact: true, selector: '[role=menuitem]' });
      await until(
        () => b.execute((g) => !!document.querySelector(`[aria-label^="${g},"] svg[style*="color"]`), GROUP + ' 2'),
        'coloured folder icon',
      );

      await contextMenuOn('header', GROUP + ' 2');
      await clickText(b, 'Delete group…', { selector: '[role=menuitem]' });
      await waitText(b, 'No connection is deleted');
      await clickText(b, 'OK', { exact: true });
      await until(async () => (await headerState(GROUP + ' 2')) === null, 'group removed');
      assert.ok((await rowNames()).includes('E2E Postgres'), 'connection kept, now ungrouped');
      assert.ok((await pageText(b)).includes('E2E Postgres'));
    }));
});
