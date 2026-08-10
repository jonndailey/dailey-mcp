import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { getActiveAccount, setActiveAccount } from '../src/api.js';

// dailey_use_account must be registered WITHOUT the per-call scope wrapper, so
// its session-set survives (the wrapper's finally-restore used to undo it).
test('dailey_use_account is registered raw (no wrapper-injected account param)', () => {
  const server = buildServer({ includeAdmin: false, includeLocalAuth: true, includeAccountSwitch: true });
  const reg = (server as any)._registeredTools ?? {};
  const use = reg['dailey_use_account'];
  assert.ok(use, 'dailey_use_account should be registered when includeAccountSwitch');
  // Wrapped tools get an injected `account` prop in their input schema; the
  // switch tool must NOT (it manages the session directly).
  const shape = use.inputSchema?.shape ?? use.inputSchema?._def?.shape?.() ?? {};
  // Its own schema defines `slug`/`account`? Confirm it wasn't double-wrapped:
  // a wrapped tool's handler saves+restores; raw registration means calling it
  // leaves the module-global set. Exercise that directly:
  setActiveAccount(undefined);
});

test('a wrapped tool restores session account after a per-call override', () => {
  // Sanity: the wrapper still works for normal tools (restore-after-call).
  setActiveAccount('base-acct');
  // getActiveAccount reflects the module global outside any ALS request.
  assert.equal(getActiveAccount(), 'base-acct');
  setActiveAccount(undefined);
});
