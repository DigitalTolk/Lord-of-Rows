// Company rollout: an access provider preconfigured in providers.json (here the user-level
// file in the app data folder; the system-wide file uses the same format) shows up as
// "Managed by your organization", can be used to sign in, and can't be edited or removed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startMockAccessProvider } from '../fixtures/mock-access-provider.mjs';
import { clickText, launch, pageText, screenshot, until, waitText } from '../lib.mjs';

const DATA_HOME = process.env.XDG_DATA_HOME ?? path.join(process.env.HOME, '.local/share');
const APP_DIR = path.join(DATA_HOME, 'dev.lordoftherows.app');
const FILE = path.join(APP_DIR, 'providers.json');

let b;
let ph;
before(async () => {
  ph = await startMockAccessProvider({ dbHost: process.env.DBS_IT_PG_HOST ?? 'postgres' });
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify([{ kind: 'access-api', name: 'Company access', url: ph.url }, { kind: 'access-api', name: 'Broken', url: 'http://not-allowed.example.com' }]));
  b = await launch();
  await waitText(b, 'Create a new connection');
});
after(async () => {
  await b?.deleteSession();
  await ph?.close();
  fs.rmSync(FILE, { force: true });
});

describe('managed access provider', () => {
  test('preconfigured provider: managed, usable, not removable', async () => {
    try {
      await clickText(b, 'Access', { selector: '[role=tab]' });
      // Pick it (an earlier spec may have left another provider selected).
      await until(
        () =>
          b.execute(() => {
            const sel = document.querySelector('select[aria-label="Access provider"]');
            const opt = sel && [...sel.options].find((o) => o.textContent === 'Company access');
            if (!opt) return false;
            if (sel.value !== opt.value) {
              Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value);
              sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return true;
          }),
        'managed provider in the switcher',
      );
      await waitText(b, 'Managed by your organization');
      const text = await pageText(b);
      assert.ok(!text.includes('Broken'), 'invalid entries (plain http to a remote host) are skipped');
      const hasRemove = await b.execute(() => [...document.querySelectorAll('button')].some((x) => x.innerText.trim() === 'Remove provider' && x.offsetParent !== null));
      assert.equal(hasRemove, false);
      await clickText(b, 'Sign in to Company access');
      await waitText(b, 'dev@example.com', 30000);
    } catch (e) {
      await screenshot(b, 'FAIL-66-managed');
      throw e;
    }
  });
});
