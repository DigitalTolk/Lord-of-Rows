// SSH tunnel through the real UI: docker-compose `sshd` bastion → postgres.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { clickText, dblclickText, fill, launch, pageText, resultsText, runSql, screenshot, sleep, until, waitText, clickSel } from '../lib.mjs';

let b;
before(async () => {
  b = await launch();
  await waitText(b, 'Create a new connection');
});
after(async () => b?.deleteSession());

const fail = (name, fn) => async () => {
  try {
    await fn();
  } catch (e) {
    await screenshot(b, `FAIL-${name}`);
    throw e;
  }
};

async function sshForm(name, env) {
  await clickText(b, 'Create a new connection');
  await clickSel(b, 'button[title="PostgreSQL"]');
  await fill(b, 'Name', name);
  await fill(b, 'Host/IP', 'postgres'); // as resolved by the SSH server
  await fill(b, 'User', 'dbs_test');
  await fill(b, 'Password', 'dbs_test');
  await fill(b, 'Database', 'dbs_test');
  if (env) await fill(b, 'Tag', env.toLowerCase());
  await clickText(b, 'Over SSH', { exact: true });
  await fill(b, 'SSH host', 'sshd');
  await fill(b, 'SSH user', 'tunnel');
  await fill(b, 'SSH password', 'tunnelpw');
}

test('SSH: unknown host key asks for confirmation, then tunnel works', fail('ssh-trust', async () => {
  await sshForm('E2E via SSH');
  await clickText(b, 'Test', { exact: true });
  await waitText(b, 'Trust this SSH host?');
  const text = await pageText(b);
  assert.match(text, /SHA256:/, 'fingerprint shown');
  await clickText(b, 'OK', { exact: true });
  await waitText(b, 'Connected to PostgreSQL');
  await clickText(b, 'Connect', { exact: true });
  await until(async () => (await pageText(b)).includes('revenue_by_country'), 'tree via tunnel');
  await clickSel(b, 'button[aria-label="New SQL query"]');
  await sleep(800);
  await runSql(b, 'select count(*) as n from customers');
  await until(async () => /\b500\b/.test(await resultsText(b)), 'query through tunnel');
}));

test('SSH: declining an unknown host key does not connect', fail('ssh-decline', async () => {
  // Fresh connection to a *different* host alias of the same server → unknown again.
  await clickSel(b, 'button[aria-label="Open another connection"]');
  await clickText(b, 'Create a new connection');
  await clickSel(b, 'button[title="PostgreSQL"]');
  await fill(b, 'Host/IP', 'postgres');
  await fill(b, 'User', 'dbs_test');
  await fill(b, 'Password', 'dbs_test');
  await clickText(b, 'Over SSH', { exact: true });
  await fill(b, 'SSH host', 'bastion'); // network alias of the same sshd
  await fill(b, 'SSH user', 'tunnel');
  await fill(b, 'SSH password', 'tunnelpw');
  await clickText(b, 'Test', { exact: true });
  await waitText(b, 'Trust this SSH host?');
  await clickText(b, 'Cancel', { exact: true });
  await waitText(b, 'SSH host key not trusted');
  assert.ok(!(await pageText(b)).includes('Connected to PostgreSQL'));
  await clickSel(b, 'button[aria-label="Close"]');
}));

test('SSH: production over a plaintext DB link is allowed when tunnelled', fail('ssh-prod', async () => {
  await sshForm('E2E Prod via SSH', 'Production');
  await clickText(b, 'Connect', { exact: true });
  await waitText(b, 'PRODUCTION');
  await until(async () => (await pageText(b)).includes('customers'), 'connected');
}));

test('SSH: known host reconnects without a prompt; wrong SSH password is rejected', fail('ssh-known', async () => {
  await clickSel(b, 'button[aria-label="Open another connection"]');
  await dblclickText(b, 'E2E via SSH');
  await sleep(1500);
  assert.ok(!(await pageText(b)).includes('Trust this SSH host?'), 'no prompt for a known host');
  await until(async () => (await pageText(b)).includes('revenue_by_country'), 'connected again');
  await clickSel(b, 'button[aria-label="Open another connection"]');
  await clickText(b, 'Create a new connection');
  await clickSel(b, 'button[title="PostgreSQL"]');
  await fill(b, 'Host/IP', 'postgres');
  await fill(b, 'User', 'dbs_test');
  await fill(b, 'Password', 'dbs_test');
  await clickText(b, 'Over SSH', { exact: true });
  await fill(b, 'SSH host', 'sshd');
  await fill(b, 'SSH user', 'tunnel');
  await fill(b, 'SSH password', 'nope-nope');
  await clickText(b, 'Test', { exact: true });
  await waitText(b, 'SSH authentication failed');
  assert.ok(!(await pageText(b)).includes('nope-nope'), 'password never echoed');
  await clickSel(b, 'button[aria-label="Close"]');
}));
