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
  const names = await toolNames({ includeAdmin: false, includeLocalAuth: false, includeAccountSwitch: false, includeLocalFiles: false });
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
  assert.ok(!names.includes('dailey_project_transfer_plan'), 'project-transfer tool leaked to remote surface');
});

test('stdio surface includes everything', async () => {
  const names = await toolNames({ includeAdmin: true, includeLocalAuth: true, includeAccountSwitch: true, includeLocalFiles: true });
  assert.ok(names.some((n) => n.startsWith('dailey_admin')), 'admin tools missing on stdio surface');
  assert.ok(names.includes('dailey_use_account'), 'switch tool missing on stdio surface');
  assert.ok(names.includes('dailey_whoami'), 'local auth tools missing on stdio surface');
  assert.ok(names.includes('dailey_project_transfer_plan'), 'project-transfer tool missing on stdio surface');
});

test('schedules tools appear only with DAILEY_SCHEDULES_TOOLS=1', async () => {
  const prev = process.env.DAILEY_SCHEDULES_TOOLS;
  try {
    delete process.env.DAILEY_SCHEDULES_TOOLS;
    let names = await toolNames({ includeAdmin: false, includeLocalAuth: false, includeAccountSwitch: false });
    assert.ok(!names.some((n) => n.startsWith('dailey_schedules_')), 'schedules tools leaked without the flag');
    process.env.DAILEY_SCHEDULES_TOOLS = '1';
    names = await toolNames({ includeAdmin: false, includeLocalAuth: false, includeAccountSwitch: false });
    for (const n of ['dailey_schedules_list', 'dailey_schedules_preview', 'dailey_schedules_history']) assert.ok(names.includes(n), `${n} missing`);
  } finally {
    if (prev === undefined) delete process.env.DAILEY_SCHEDULES_TOOLS; else process.env.DAILEY_SCHEDULES_TOOLS = prev;
  }
});

// Security review 2026-10-15, H4 (10-14 M2): these two tools read and upload
// LOCAL file paths. On the shared hosted pod "local" means the pod's own
// filesystem, so they must never be registered there.
const LOCAL_FILE_TOOLS = ['dailey_wordpress_migrate', 'dailey_wordpress_import'];

test('hosted surface (the exact http.ts options) excludes the local-file WordPress tools', async () => {
  const names = await toolNames({ includeAdmin: false, includeLocalAuth: true, includeAccountSwitch: false, includeLocalFiles: false });
  for (const t of LOCAL_FILE_TOOLS) assert.ok(!names.includes(t), `${t} leaked to the hosted surface`);
  assert.ok(names.includes('dailey_wp_snapshot'), 'API-only WordPress tools stay on the hosted surface');
});

test('local stdio surface keeps the local-file WordPress tools', async () => {
  const names = await toolNames({ includeAdmin: true, includeLocalAuth: true, includeAccountSwitch: true, includeLocalFiles: true });
  for (const t of LOCAL_FILE_TOOLS) assert.ok(names.includes(t), `${t} missing from the stdio surface`);
});

test('includeLocalFiles omitted (JS caller) fails safe: no local-file tools', async () => {
  const names = await toolNames({ includeAdmin: false, includeLocalAuth: true, includeAccountSwitch: false } as any);
  for (const t of LOCAL_FILE_TOOLS) assert.ok(!names.includes(t), `${t} registered without an explicit includeLocalFiles: true`);
});
