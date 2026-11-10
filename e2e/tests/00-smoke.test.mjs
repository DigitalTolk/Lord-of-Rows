import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch, pageText, waitText } from '../lib.mjs';

let b;
before(async () => (b = await launch()));
after(async () => b?.deleteSession());

test('app launches and shows the connection launcher', async () => {
  await waitText(b, 'Create a new connection');
  const text = await pageText(b);
  assert.match(text, /DB Studio/);
});
