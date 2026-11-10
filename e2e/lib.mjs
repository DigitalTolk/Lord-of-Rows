// Shared helpers for E2E tests driving the real app over WebDriver.
import { remote } from 'webdriverio';

export const APP = process.env.DBS_APP ?? '/target/debug/dbstudio';

export async function launch() {
  const b = await remote({
    hostname: '127.0.0.1',
    port: 4444,
    logLevel: 'error',
    capabilities: { 'tauri:options': { application: APP } },
  });
  await b.setTimeout({ implicit: 0 });
  return b;
}

/** Wait until `fn` returns truthy (polls), else throw with `what`. */
export async function until(fn, what, timeout = 15000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for: ${what}${last ? ` (${last.message})` : ''}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Visible text of the whole page. */
export async function pageText(b) {
  return b.execute(() => document.body.innerText);
}

export async function waitText(b, text, timeout) {
  return until(async () => (await pageText(b)).includes(text), `text "${text}"`, timeout);
}

/** Click the first visible element (button/[role]) whose trimmed text equals or starts with `text`. */
export async function clickSel(b, css) {
  await until(
    () =>
      b.execute((css) => {
        const dialogs = document.querySelectorAll('[role=dialog]');
        const root = dialogs.length ? dialogs[dialogs.length - 1] : document;
        const el = [...root.querySelectorAll(css)].find((e) => e.offsetParent !== null && !e.disabled);
        if (!el) return false;
        el.click();
        return true;
      }, css),
    `element ${css}`,
  );
  await sleep(250);
}

export async function clickText(b, text, { exact = false, selector = 'button,[role=option],[role=menuitem],[role=treeitem],[role=tab],[role=radio]' } = {}) {
  const ok = await until(
    () =>
      b.execute(
        (text, exact, selector) => {
          const dialogs = document.querySelectorAll('[role=dialog]');
          const root = dialogs.length ? dialogs[dialogs.length - 1] : document;
          const els = [...root.querySelectorAll(selector)].filter((e) => e.offsetParent !== null && !e.disabled);
          const el = els.find((e) => (exact ? e.innerText.trim() === text : e.innerText.trim().startsWith(text)) || e.getAttribute('aria-label') === text);
          if (!el) return false;
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        },
        text,
        exact,
        selector,
      ),
    `clickable "${text}"`,
  );
  await sleep(250);
  return ok;
}

export async function dblclickText(b, text, selector = '[role=option],[role=treeitem]') {
  await until(
    () =>
      b.execute(
        (text, selector) => {
          const el = [...document.querySelectorAll(selector)].find((e) => e.offsetParent !== null && e.innerText.includes(text));
          if (!el) return false;
          el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          return true;
        },
        text,
        selector,
      ),
    `double-clickable "${text}"`,
  );
  await sleep(300);
}

/** Set a React-controlled input found by the row label or placeholder. */
export async function fill(b, labelOrPlaceholder, value) {
  await until(
    () =>
      b.execute(
        (key, value) => {
          const dialogs = document.querySelectorAll('[role=dialog]');
          const root = dialogs.length ? dialogs[dialogs.length - 1] : document;
          const all = [...root.querySelectorAll('input,textarea,select')].filter((e) => e.offsetParent !== null);
          let el = all.find((e) => e.getAttribute('placeholder') === key || e.getAttribute('aria-label') === key);
          if (!el) {
            const label = [...root.querySelectorAll('label')].find((l) => l.querySelector('span')?.innerText.trim() === key);
            el = label?.querySelector('input,textarea,select');
          }
          if (!el) return false;
          const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
          el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
          return true;
        },
        labelOrPlaceholder,
        value,
      ),
    `field "${labelOrPlaceholder}"`,
  );
  await sleep(150);
}

/** Replace the visible query tab's editor contents and run it. */
export async function runSql(b, sql, { all = true } = {}) {
  await until(
    () =>
      b.execute((sql) => {
        const panel = document.querySelector('[role=tabpanel]:not([hidden])');
        const node = panel?.querySelector('.monaco-editor');
        const ed = node && globalThis.__monaco?.editor.getEditors().find((e) => e.getContainerDomNode().contains(node) || node.contains(e.getContainerDomNode()));
        if (!ed) return false;
        ed.setValue(sql);
        return true;
      }, sql),
    'monaco editor',
  );
  await clickText(b, all ? 'Run all' : 'Run', { exact: true });
}

/** Text of the visible results area (grid cells + status). */
export async function resultsText(b) {
  return b.execute(() => document.querySelector('[role=tabpanel]:not([hidden])')?.innerText ?? '');
}

export async function screenshot(b, name) {
  // WebKitWebDriver's screenshot can hang on some pages; never let it block the suite.
  const fs = await import('node:fs');
  const text = await Promise.race([b.execute(() => document.body.innerText).catch((e) => `<<${e.message}>>`), sleep(4000).then(() => '<<timeout>>')]);
  fs.writeFileSync(`./artifacts/${name}.txt`, String(text));
  await Promise.race([b.saveScreenshot(`./artifacts/${name}.png`).catch(() => {}), sleep(5000)]);
}
