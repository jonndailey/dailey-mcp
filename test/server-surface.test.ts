import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';

async function toolNames(opts: Parameters<typeof buildServer>[0]): Promise<string[]> {
  const server = buildServer(opts);
  // McpServer keeps registrations in a private map; list via the underlying
  // server's request handler is heavyweight, so use the public accessor
  // pattern the SDK supports: (server as any)._registeredTools.
  return Object.keys((server as any)._registeredTools ?? {});
}

test('remote surface excludes admin, local-auth, and account-switch tools', async () => {
  const names = await toolNames({ includeAdmin: false, includeLocalAuth: false, includeAccountSwitch: false });
  assert.ok(names.length > 40, `expected >40 tools, got ${names.length}`);
  for (const n of names) {
    assert.ok(!n.startsWith('dailey_admin'), `admin tool leaked: ${n}`);
  }
  // Local auth tools registered by registerAuthTools (src/tools/auth.ts):
  // dailey_whoami, dailey_auth_status, dailey_auth_enable — no `dailey_login`
  // tool actually exists in this codebase.
  assert.ok(!names.includes('dailey_whoami'), 'local auth tool leaked');
  assert.ok(!names.includes('dailey_auth_status'), 'local auth tool leaked');
  assert.ok(!names.includes('dailey_auth_enable'), 'local auth tool leaked');
  assert.ok(!names.includes('dailey_use_account'), 'account switch tool leaked');
  assert.ok(names.some((n) => n.includes('account')), 'account LIST tool should remain');
});

test('stdio surface includes everything', async () => {
  const names = await toolNames({ includeAdmin: true, includeLocalAuth: true, includeAccountSwitch: true });
  assert.ok(names.some((n) => n.startsWith('dailey_admin')), 'admin tools missing on stdio surface');
  assert.ok(names.includes('dailey_use_account'), 'switch tool missing on stdio surface');
  assert.ok(names.includes('dailey_whoami'), 'local auth tools missing on stdio surface');
});
