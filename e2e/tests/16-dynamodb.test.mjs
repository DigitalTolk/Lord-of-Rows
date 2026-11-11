// DynamoDB workflow against DynamoDB Local (docker compose service `dynamodb`):
// connect with the form, browse a table, run PartiQL, edit an item and commit.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { clickSel, clickText, fill, launch, pageText, resultsText, runSql, screenshot, sleep, until, waitText } from '../lib.mjs';

const EP = process.env.DBS_IT_DYNAMO_ENDPOINT ?? 'http://dynamodb:8000';
const TABLE = 'e2e_orders';
const EXACT = '12345678901234567890.123456789';

/** Raw DynamoDB JSON API call. DynamoDB Local does not verify signatures, so a dummy one is enough for fixtures. */
async function ddb(op, body) {
  const r = await fetch(EP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.0',
      'X-Amz-Target': `DynamoDB_20120810.${op}`,
      Authorization: 'AWS4-HMAC-SHA256 Credential=dbstest/20240101/us-east-1/dynamodb/aws4_request, SignedHeaders=host, Signature=0',
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${op}: ${JSON.stringify(j)}`);
  return j;
}

let b;
before(async () => {
  await ddb('DeleteTable', { TableName: TABLE }).catch(() => {});
  await ddb('CreateTable', {
    TableName: TABLE,
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'N' }],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    BillingMode: 'PAY_PER_REQUEST',
  });
  for (const [pk, sk, status, total] of [['cust#1', '1', 'open', EXACT], ['cust#1', '2', 'shipped', '5'], ['cust#2', '1', 'open', '7.25']]) {
    await ddb('PutItem', { TableName: TABLE, Item: { pk: { S: pk }, sk: { N: sk }, status: { S: status }, total: { N: total } } });
  }
  b = await launch();
  await waitText(b, 'Create a new connection');
});
after(async () => {
  await b?.deleteSession();
  await ddb('DeleteTable', { TableName: TABLE }).catch(() => {});
});

async function fail(name, fn) {
  try {
    await fn();
  } catch (e) {
    await screenshot(b, `FAIL-dynamo-${name}`);
    throw e;
  }
}

describe('DynamoDB', () => {
  test('create a DynamoDB connection (endpoint, region, keys), Test, Connect', () =>
    fail('connect', async () => {
      await clickText(b, 'Create a new connection');
      await clickSel(b, 'button[title="DynamoDB"]');
      await fill(b, 'Name', 'E2E Dynamo');
      await fill(b, 'Endpoint URL', EP);
      await fill(b, 'Region', 'us-east-1');
      await fill(b, 'Access key ID', 'dbstest');
      await fill(b, 'Secret access key', 'dbstestsecret');
      const labels = await b.execute(() => [...document.querySelectorAll('[role=dialog] label > span:first-child')].map((s) => s.innerText.trim()));
      assert.ok(!labels.includes('Port') && !labels.includes('SSL / TLS'), `irrelevant fields hidden: ${labels}`);
      await clickText(b, 'Test', { exact: true });
      await waitText(b, 'Connected to DynamoDB us-east-1');
      await clickText(b, 'Connect', { exact: true });
      await until(async () => (await pageText(b)).includes(TABLE), 'table in object tree');
    }));

  test('open a table: items with keys first and exact numbers', () =>
    fail('open-table', async () => {
      await clickText(b, TABLE, { exact: true, selector: '[role=treeitem]' });
      await waitText(b, 'cust#2');
      await waitText(b, EXACT);
      const header = await b.execute(() => [...document.querySelectorAll('[role=columnheader]')].map((h) => h.innerText.trim()).filter(Boolean));
      assert.deepEqual(header.slice(0, 4), ['pk', 'sk', 'status', 'total'], `columns: ${header}`);
      await until(async () => /3 rows/.test(await resultsText(b)), 'row count');
    }));

  test('run a PartiQL query', () =>
    fail('partiql', async () => {
      await clickSel(b, 'button[aria-label="New SQL query"]');
      await until(() => b.execute(() => !!document.querySelector('[role=tabpanel]:not([hidden]) .monaco-editor')), 'query editor');
      await sleep(500);
      await runSql(b, `SELECT * FROM "${TABLE}" WHERE pk = 'cust#1'`);
      await until(async () => (await resultsText(b)).includes(EXACT) && (await resultsText(b)).includes('shipped'), 'PartiQL rows');
    }));

  test('edit an item in the grid, review, commit', () =>
    fail('edit', async () => {
      await clickText(b, TABLE, { exact: true, selector: '[role=tab]' });
      await waitText(b, 'cust#2');
      await b.execute(() => {
        const header = [...document.querySelectorAll('[role=columnheader]')].map((h) => h.innerText.trim());
        const idx = header.indexOf('status');
        const row = [...document.querySelectorAll('[role=row]')].find((r) => [...r.querySelectorAll('[role=gridcell]')].some((c) => c.innerText.trim() === 'cust#2'));
        row.querySelectorAll('[role=gridcell]')[idx].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      });
      await sleep(300);
      await b.execute(() => {
        const input = document.querySelector('[role=gridcell] input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'closed');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      await waitText(b, '1 pending change');
      await clickSel(b, 'button[aria-label="Preview pending changes"]');
      await waitText(b, `UpdateItem "${TABLE}" KEY {"pk": 'cust#2', "sk": 1} SET "status" = 'closed' IF item exists AND "status" = 'open'`);
      await clickText(b, 'Commit', { exact: true });
      await waitText(b, 'Committed 1 row');
    }));

  test('the edit is really in DynamoDB and nothing else changed', () =>
    fail('verify', async () => {
      const item = (await ddb('GetItem', { TableName: TABLE, Key: { pk: { S: 'cust#2' }, sk: { N: '1' } } })).Item;
      assert.equal(item.status.S, 'closed');
      assert.equal(item.total.N, '7.25');
      const other = (await ddb('GetItem', { TableName: TABLE, Key: { pk: { S: 'cust#1' }, sk: { N: '1' } } })).Item;
      assert.equal(other.total.N, EXACT);
      await clickText(b, 'Query', { selector: '[role=tab]' });
      await runSql(b, `SELECT status FROM "${TABLE}" WHERE pk = 'cust#2' AND sk = 1`);
      await until(async () => /closed/.test(await resultsText(b)), 'edited value via PartiQL');
    }));
});
