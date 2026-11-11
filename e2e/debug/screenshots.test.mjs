// README screenshots: drives the real app against the demo fixtures only
// (tests/fixtures/demo_pg.sql, demo_mysql.sql and the SQLite fixture from run.sh)
// and saves PNGs into docs/screenshots/. Not part of the regular suite:
//   docker compose run --rm dev bash -c '... e2e/run.sh debug/screenshots.test.mjs'
// Each shot is independent: a failure is logged and the remaining shots still run.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { clickSel, clickText, dblclickText, fill, launch, pageText, resultsText, sleep, until, waitText } from '../lib.mjs';

const OUT = '../docs/screenshots';
const PG_URL = 'postgresql://dbs_test:dbs_test@postgres:5432/dbs_test?sslmode=disable';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let b;
const failures = [];

before(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  b = await launch();
  b.setTimeout?.({ script: 15000 });
  await waitText(b, 'Create a new connection');
  try {
    await b.setWindowRect(0, 0, 1440, 900);
  } catch (e) {
    log('setWindowRect failed:', e.message);
  }
  await sleep(500);
});
after(async () => b?.deleteSession());

/** Hide toasts (and the text caret) so they never end up in a shot. */
async function hideNoise() {
  await b.execute(() => {
    if (document.getElementById('__shots')) return;
    const s = document.createElement('style');
    s.id = '__shots';
    s.textContent = 'div[role=log].fixed > * { display: none !important; } * { caret-color: transparent !important; }';
    document.head.appendChild(s);
  });
}

async function shot(name, settle = 700) {
  await hideNoise();
  await b.execute(() => document.activeElement?.blur?.()).catch(() => {});
  await sleep(settle);
  const path = `${OUT}/${name}.png`;
  // WebKitWebDriver's screenshot hangs on some pages; grab the Xvfb screen instead
  // (no window manager: the app window sits at 0,0 without decorations).
  const { width, height } = await b.getWindowRect().catch(() => ({ width: 1440, height: 900 }));
  execFileSync('import', ['-display', process.env.DISPLAY, '-window', 'root', '-crop', `${width}x${height}+0+0`, '+repage', path]);
  log('saved', path);
}

/** Run one shot's steps; on error, log and keep going. */
async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    failures.push(name);
    log(`FAILED ${name}: ${e.message}`);
    try {
      execFileSync('import', ['-display', process.env.DISPLAY, '-window', 'root', `./artifacts/SHOT-FAIL-${name}.png`]);
      fs.writeFileSync(`./artifacts/SHOT-FAIL-${name}.txt`, await pageText(b));
    } catch {}
    await closeOverlays().catch(() => {});
  }
}

/** Close menus, popovers and dialogs left open by a shot. */
async function closeOverlays() {
  for (let i = 0; i < 4; i++) {
    const open = await b.execute(() => {
      const target = document.querySelector('[role=menu]') ?? document.querySelector('[role=dialog]') ?? document.activeElement ?? document.body;
      for (const t of [target, document.activeElement, document]) t?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      return !!document.querySelector('[role=menu],[role=dialog]');
    });
    if (!open) return;
    await sleep(250);
    await b.execute(() => {
      document.querySelector('[role=dialog] button[aria-label="Close"]')?.click();
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 5, clientY: 895 }));
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 895 }));
    });
    await sleep(250);
  }
}

async function setTheme(want) {
  for (let i = 0; i < 4; i++) {
    const label = await b.execute(() => [...document.querySelectorAll('button[aria-label^="Appearance:"]')].find((e) => e.offsetParent !== null)?.getAttribute('aria-label') ?? '');
    if (label.startsWith(`Appearance: ${want}`)) break;
    await clickSel(b, 'button[aria-label^="Appearance:"]');
    await sleep(300);
  }
  await until(() => b.execute((w) => document.documentElement.classList.contains('dark') === (w === 'Dark'), want), `theme ${want}`);
}

/** Visible connection rows in the launcher. */
const rowNames = () =>
  b.execute(() => [...document.querySelectorAll('[role=listbox] [role=option]')].filter((e) => e.offsetParent !== null).map((e) => e.querySelector('.font-medium')?.innerText ?? ''));

async function contextMenuOnRow(name) {
  await until(
    () =>
      b.execute((name) => {
        const el = [...document.querySelectorAll('[role=listbox] [role=option]')].find((e) => e.querySelector('.font-medium')?.innerText === name);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }));
        return true;
      }, name),
    `context menu on ${name}`,
  );
  await sleep(250);
}

/** Create and save a connection from the launcher form. */
async function newConnection({ engine, name, host, env, db = 'dbs_test', ssl }) {
  await clickText(b, 'Create a new connection');
  await clickSel(b, `button[title="${engine}"]`);
  await fill(b, 'Name', name);
  await fill(b, 'Host/IP', host);
  await fill(b, 'User', 'dbs_test');
  await fill(b, 'Password', 'dbs_test');
  await fill(b, 'Database', db);
  if (env) await fill(b, 'Tag', env);
  if (ssl) await fill(b, 'SSL mode', ssl);
  await clickText(b, 'Save', { exact: true });
  await until(async () => (await rowNames()).includes(name), `saved ${name}`);
}

async function newGroup(name) {
  await clickSel(b, 'button[aria-label="New group"]');
  await fill(b, 'New group', name);
  await clickText(b, 'OK', { exact: true });
  await until(() => b.execute((n) => !![...document.querySelectorAll('[role=listbox] [aria-expanded]')].find((e) => (e.getAttribute('aria-label') ?? '').startsWith(n + ',')), name), `group ${name}`);
}

async function moveToGroup(conn, group) {
  await contextMenuOnRow(conn);
  await clickText(b, 'Move to group', { selector: '[role=menuitem]' });
  await clickText(b, group, { exact: true, selector: '[role=menuitem]' });
  await sleep(300);
}

const panel = '[role=tabpanel]:not([hidden])';

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

async function setDetailField(name, value) {
  await until(
    () =>
      b.execute(
        (name, value) => {
          const p = document.querySelector('[role=tabpanel]:not([hidden]) aside[aria-label="Row details"]');
          const el = p?.querySelector(`[data-field="${name}"] input, [data-field="${name}"] textarea`);
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
  await b.execute((name) => document.querySelector(`aside[aria-label="Row details"] [data-field="${name}"] :is(input, textarea)`)?.blur(), name);
  await sleep(250);
}

async function cellEvent(type, rowText, col) {
  await until(
    () =>
      b.execute(
        (type, rowText, col) => {
          const p = document.querySelector('[role=tabpanel]:not([hidden])') ?? document;
          const header = [...p.querySelectorAll('[role=columnheader]')].map((h) => h.innerText.trim());
          const idx = header.indexOf(col);
          const row = [...p.querySelectorAll('[role=row]')].find((r) => [...r.querySelectorAll('[role=gridcell]')].some((c) => c.innerText.trim() === rowText));
          const cell = row?.querySelectorAll('[role=gridcell]')[idx];
          if (!cell) return false;
          const r = cell.getBoundingClientRect();
          cell.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: type === 'contextmenu' ? 2 : 0, clientX: r.left + 30, clientY: r.top + 8 }));
          return true;
        },
        type,
        rowText,
        col,
      ),
    `cell ${rowText}/${col}`,
  );
  await sleep(200);
}

async function openTable(name) {
  await clickText(b, name, { exact: true, selector: '[role=treeitem]' });
  await sleep(600);
}

async function closeDetailIfOpen() {
  await b.execute(() => document.querySelector('[role=tabpanel]:not([hidden]) aside[aria-label="Row details"] button[aria-label="Close"]')?.click());
  await sleep(200);
}

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

test('README screenshots', { timeout: 600000 }, async () => {
  log('window', JSON.stringify(await b.getWindowRect().catch(() => null)), 'viewport', JSON.stringify(await b.execute(() => [innerWidth, innerHeight])));

  await step('theme-dark', () => setTheme('Dark'));

  await step('launcher', async () => {
    await newConnection({ engine: 'PostgreSQL', name: 'Shop (Postgres)', host: 'postgres', env: 'local' });
    await newConnection({ engine: 'MySQL', name: 'Shop (MySQL)', host: 'mysql', env: 'development' });
    await newConnection({ engine: 'MySQL', name: 'Shop (MariaDB)', host: 'mariadb', env: 'staging' });
    await newConnection({ engine: 'PostgreSQL', name: 'Reporting', host: 'postgres', env: 'staging' });
    await newConnection({ engine: 'PostgreSQL', name: 'Production replica', host: 'postgres', env: 'production', ssl: 'required' });
    await newGroup('Demo');
    await newGroup('Analytics');
    await moveToGroup('Shop (Postgres)', 'Demo');
    await moveToGroup('Shop (MySQL)', 'Demo');
    await moveToGroup('Shop (MariaDB)', 'Demo');
    await moveToGroup('Reporting', 'Analytics');
    await moveToGroup('Production replica', 'Analytics');
    await b.execute(() => document.querySelector('[role=listbox] [role=option]')?.focus());
    await shot('launcher');
  });

  await step('connection-form', async () => {
    await clickText(b, 'Create a new connection');
    await clickSel(b, 'button[title="MySQL"]');
    await fill(b, 'Name', 'Shop (MySQL)');
    await fill(b, 'Host/IP', 'mysql');
    await fill(b, 'User', 'dbs_test');
    await fill(b, 'Password', 'dbs_test');
    await fill(b, 'Database', 'dbs_test');
    await fill(b, 'Tag', 'development');
    await fill(b, 'SSL mode', 'required');
    await shot('connection-form');
    await clickText(b, 'Cancel', { exact: true }).catch(() => clickSel(b, 'button[aria-label="Close"]'));
    await sleep(300);
  });

  await step('connect', async () => {
    await dblclickText(b, 'Shop (Postgres)');
    await until(async () => (await pageText(b)).includes('revenue_by_country'), 'object tree');
  });

  await step('table-workspace', async () => {
    await openTable('customers');
    await waitText(b, 'user1@example.com');
    await clickSel(b, `${panel} button[aria-label="Filter bar"]`);
    await until(() => b.execute(() => !!document.querySelector('[role=tabpanel]:not([hidden]) [role=search]')), 'filter bar');
    await setFilterField('Column', 0, 'country');
    await setFilterField('Operator', 0, 'eq');
    await setFilterField('Value', 0, 'GB');
    await clickText(b, 'Apply', { exact: true });
    await until(async () => /of 72 rows/.test(await resultsText(b)), 'GB customers', 20000);
    await selectRowWithText('user8@example.com');
    await until(() => b.execute(() => !!document.querySelector('[role=tabpanel]:not([hidden]) aside[aria-label="Row details"]')), 'detail panel');
    await shot('table-workspace');
  });

  await step('pending-changes', async () => {
    await selectRowWithText('user22@example.com');
    await setDetailField('name', 'Ada Lovelace');
    await waitText(b, '1 pending change');
    await clickSel(b, 'button[aria-label="Preview pending changes"]');
    await waitText(b, 'UPDATE "shop"."customers"');
    await shot('pending-changes');
    await clickText(b, 'Discard', { exact: true });
    await closeOverlays();
    await until(async () => !(await pageText(b)).includes('1 pending change'), 'discarded');
  });

  await step('context-menu', async () => {
    await clickText(b, 'Clear', { exact: true }).catch(() => {});
    await openTable('orders');
    await waitText(b, 'gift wrap').catch(() => {});
    await closeDetailIfOpen();
    await cellEvent('mousedown', '3', 'id').catch(() => {});
    await b.execute(() => {
      const rows = [...document.querySelectorAll('[role=tabpanel]:not([hidden]) [role=rowheader]')].slice(2, 5);
      rows[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      rows[2]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
    });
    await sleep(200);
    await cellEvent('contextmenu', '5', 'status').catch(async () => {
      const first = await b.execute(() => document.querySelectorAll('[role=tabpanel]:not([hidden]) [role=gridcell]')[1]?.innerText.trim());
      await cellEvent('contextmenu', first, 'id');
    });
    await until(() => b.execute(() => !!document.querySelector('[role=menu][aria-label="Cell actions"]')), 'context menu');
    await clickText(b, 'Copy Rows As', { selector: '[role=menuitem]' });
    await sleep(300);
    await shot('context-menu');
    await closeOverlays();
  });

  await step('query-split', async () => {
    await clickSel(b, 'button[aria-label="New SQL query"]');
    await until(() => b.execute(() => !!document.querySelector('[role=tabpanel]:not([hidden]) .monaco-editor')), 'query editor');
    await sleep(600);
    await clickSel(b, 'button[aria-label="Split editor right"]');
    await until(() => b.execute(() => document.querySelectorAll('[role=tabpanel]:not([hidden]) .monaco-editor').length === 2), 'split');
    await setPane(
      1,
      `-- Revenue by country (refunds excluded)
SELECT c.country,
       count(*)               AS orders,
       round(sum(o.total), 2) AS revenue
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.status <> 'refunded'
GROUP BY c.country
ORDER BY revenue DESC;`,
    );
    await setPane(
      2,
      `-- Top products by units sold
SELECT p.sku, p.title,
       sum(i.qty)                        AS units,
       round(sum(i.qty * i.unit_price), 2) AS sales
FROM order_items i
JOIN products p ON p.id = i.product_id
GROUP BY p.sku, p.title
ORDER BY units DESC
LIMIT 20;`,
    );
    await runPane(1);
    await sleep(800);
    await runPane(2);
    await until(async () => /SKU-/.test(await resultsText(b)) && /revenue/.test(await resultsText(b)), 'both results', 20000);
    await shot('query-split');
  });

  await step('open-database', async () => {
    await b.keys(['Control', 'k']);
    await until(() => b.execute(() => [...document.querySelectorAll('[role=dialog] h2')].some((h) => h.innerText.trim() === 'Open database')), 'picker');
    await sleep(500);
    // Hide schemas left behind by other E2E runs (e2e_new_*) so only the demo shows.
    await b.execute(() => document.querySelectorAll('[role=dialog] [role=option][data-name^="e2e_"]').forEach((o) => (o.style.display = 'none')));
    await shot('open-database');
    await closeOverlays();
  });

  await step('er-diagram', async () => {
    await clickSel(b, 'button[aria-label="ER diagram"]');
    await until(() => b.execute(() => document.querySelectorAll('svg[aria-label="Entity relationship diagram"] path[marker-end]').length >= 3), 'FK edges');
    await shot('er-diagram', 1200);
    await closeOverlays();
  });

  await step('monitor', async () => {
    await clickSel(b, 'button[aria-label="Monitor"]');
    await until(async () => /Sessions \(\d+\)/.test(await pageText(b)), 'sessions');
    await waitText(b, 'Largest tables');
    await shot('monitor', 1200);
    await closeOverlays();
  });

  await step('table-workspace-light', async () => {
    await clickText(b, 'customers', { exact: true, selector: '[role=tab]' });
    await sleep(500);
    await setTheme('Light');
    await selectRowWithText('user8@example.com').catch(() => {});
    await shot('table-workspace-light', 1000);
    await setTheme('Dark');
  });

  log('failures:', failures.join(', ') || 'none');
});
