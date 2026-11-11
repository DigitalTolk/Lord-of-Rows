// Access requests through an access provider (passhub kind), against an in-process mock
// passhub (fixtures/mock-passhub.mjs) and the compose PostgreSQL. Covers: adding the
// provider, browser sign-in (PKCE loopback; $BROWSER plays the browser), the database
// picker (DocumentDB / SSM services are not offered), filing a request, the pending →
// provisioning → ready transitions picked up by polling, Connect (password fetched once
// into the keychain, the connection opens), a second Connect reusing it without another
// reveal, the approvals inbox (reject needs a reason), and a revoked request ending the
// saved connection (password wiped, "Expired" in the launcher).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startMockPasshub } from '../fixtures/mock-passhub.mjs';
import { clickText, fill, launch, pageText, screenshot, until, waitText } from '../lib.mjs';

const DB_HOST = process.env.DBS_IT_PG_HOST ?? 'postgres';

let b;
let ph;
before(async () => {
  ph = await startMockPasshub({ dbHost: DB_HOST });
  b = await launch();
  await waitText(b, 'Create a new connection');
});
after(async () => {
  await b?.deleteSession();
  await ph?.close();
});

async function fail(name, fn) {
  try {
    await fn();
  } catch (e) {
    await screenshot(b, `FAIL-64-${name}`);
    throw e;
  }
}

/** Clicks the form control (radio / checkbox) inside the first visible label whose text contains `text`. */
const clickLabel = (text) =>
  until(
    () =>
      b.execute((text) => {
        const dialogs = document.querySelectorAll('[role=dialog]');
        const root = dialogs.length ? dialogs[dialogs.length - 1] : document;
        const l = [...root.querySelectorAll('label')].find((x) => x.offsetParent !== null && x.innerText.includes(text));
        const input = l?.querySelector('input');
        if (!input) return false;
        input.click();
        return true;
      }, text),
    `label "${text}"`,
  );

/** The phase of a request card (data-phase) by its resource name. */
const cardPhase = (name) => b.execute((name) => document.querySelector(`li[aria-label="${name}"][data-phase]`)?.getAttribute('data-phase') ?? null, name);

const openLauncherAccess = async () => {
  if (!(await pageText(b)).includes('Create a new connection')) await clickText(b, 'Open another connection');
  await clickText(b, 'Access', { selector: '[role=tab]' });
};

describe('access requests (passhub provider)', () => {
  test('add the provider and sign in through the browser', () =>
    fail('signin', async () => {
      await clickText(b, 'Access', { selector: '[role=tab]' });
      await waitText(b, 'Database access');
      await fill(b, 'https://access.example.com', ph.url);
      await clickText(b, 'Add provider', { exact: true });
      await clickText(b, 'Sign in to passhub');
      await waitText(b, 'dev@example.com', 30000);
      assert.ok(ph.state.log.includes('POST /api/v1/auth/desktop/token'));
      await waitText(b, 'My requests');
    }));

  test('request access: only connectable databases are offered', () =>
    fail('request', async () => {
      await clickText(b, 'Request access');
      await waitText(b, 'orders-db');
      const text = await b.execute(() => document.querySelector('[role=dialog]')?.innerText ?? '');
      assert.ok(!text.includes('docs-db') && !text.includes('app-secrets'), 'DocumentDB and SSM services are not requestable');
      await clickLabel('orders-db');
      await waitText(b, 'dbs_test');
      await clickLabel('dbs_test');
      await fill(b, 'What do you need the access for? (e.g. the ticket you are working on)', 'E2E: check the orders table');
      await clickText(b, 'Submit request', { exact: true });
      await until(() => cardPhase('orders-db').then((p) => p === 'pending'), 'pending card');
      await waitText(b, 'Waiting for Morgan');
      const r = ph.mine();
      assert.equal(r.accessType, 'read');
      assert.deepEqual(r.targetDatabases, ['dbs_test']);
      assert.equal(r.reason, 'E2E: check the orders table');
    }));

  test('approval and provisioning are picked up by polling; Connect opens the database', () =>
    fail('connect', async () => {
      const id = ph.mine().requestId;
      ph.approve(id);
      await until(() => cardPhase('orders-db').then((p) => p === 'provisioning'), 'provisioning', 20000);
      ph.provision(id);
      await until(() => cardPhase('orders-db').then((p) => p === 'ready'), 'ready', 20000);
      await waitText(b, 'expires in');
      await clickText(b, 'Connect', { exact: true });
      await waitText(b, 'orders-db · dbs_test', 30000);
      await until(async () => !(await pageText(b)).includes('Create a new connection'), 'workspace opened', 30000);
      assert.equal(ph.state.reveals, 1);
    }));

  test('connecting again reuses the saved password (no second reveal)', () =>
    fail('reuse', async () => {
      await openLauncherAccess();
      await until(() => cardPhase('orders-db').then((p) => p === 'ready'), 'ready card');
      await clickText(b, 'Open', { exact: true });
      await until(async () => !(await pageText(b)).includes('Create a new connection'), 'workspace', 30000);
      assert.equal(ph.state.reveals, 1);
    }));

  test('approvals inbox: rejecting requires a reason', () =>
    fail('approvals', async () => {
      await openLauncherAccess();
      await clickText(b, 'Approvals', { selector: '[role=tab]' });
      await waitText(b, 'Investigate a billing ticket');
      await clickText(b, 'Reject', { exact: true });
      const disabled = await b.execute(() => [...document.querySelectorAll('[role=dialog] button')].find((x) => x.innerText.trim() === 'Reject')?.disabled);
      assert.equal(disabled, true);
      await b.execute((v) => {
        const el = document.querySelector('[role=dialog] textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, 'Use the reporting replica instead');
      await clickText(b, 'Reject', { exact: true });
      await waitText(b, 'Nothing to approve right now.');
      const other = ph.state.requests.find((r) => r.requestId === 'req-other');
      assert.equal(other.status, 'rejected');
      assert.equal(other.rejectReason, 'Use the reporting replica instead');
      await clickText(b, 'My requests', { selector: '[role=tab]' });
    }));

  test('a revoked request ends its connection', () =>
    fail('revoke', async () => {
      ph.revoke(ph.mine().requestId);
      await until(() => cardPhase('orders-db').then((p) => p === 'revoked'), 'revoked card', 20000);
      await clickText(b, 'Connections', { selector: '[role=tab]' });
      await until(() => b.execute(() => !!document.querySelector('[role=option][data-expired]')), 'expired row');
      await waitText(b, 'Expired');
      const before = ph.state.reveals;
      // Opening it is refused and leads to a new request instead.
      await b.execute(() => document.querySelector('[role=option][data-expired]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
      await waitText(b, 'Request it again.');
      await waitText(b, 'Request access');
      assert.equal(ph.state.reveals, before);
    }));
});
