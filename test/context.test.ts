import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestContext } from '../src/context.js';
import { resolveToken, setActiveAccount, getActiveAccount } from '../src/api.js';

test('resolveToken prefers the ALS store token over env/config', () => {
  requestContext.run({ token: 'tok-from-request' }, () => {
    assert.equal(resolveToken(), 'tok-from-request');
  });
});

test('setActiveAccount inside a request scopes to that request only', () => {
  // Outside any request: module-global behavior (stdio path).
  setActiveAccount(undefined);
  requestContext.run({ token: 't1' }, () => {
    setActiveAccount('acme');
    assert.equal(getActiveAccount(), 'acme');
  });
  // The write above must NOT have leaked to the module global.
  assert.equal(getActiveAccount(), undefined);
});

test('two concurrent request contexts never see each other', async () => {
  const seen: Array<string | undefined> = [];
  await Promise.all([
    new Promise<void>((res) => requestContext.run({ token: 'a' }, () => {
      setActiveAccount('acct-a');
      setTimeout(() => { seen.push(getActiveAccount()); assert.equal(resolveToken(), 'a'); res(); }, 20);
    })),
    new Promise<void>((res) => requestContext.run({ token: 'b' }, () => {
      setActiveAccount('acct-b');
      setTimeout(() => { seen.push(getActiveAccount()); assert.equal(resolveToken(), 'b'); res(); }, 10);
    })),
  ]);
  assert.deepEqual(seen.sort(), ['acct-a', 'acct-b']);
});
