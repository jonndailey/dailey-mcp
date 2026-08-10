import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createHttpServer, MAX_INFLIGHT, getInflight } from '../src/http.js';

let server: Server; let base: string;
before(async () => {
  server = createHttpServer();
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
after(() => server.close());

test('healthz is open', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
});

test('POST /mcp without bearer → 401 with WWW-Authenticate', async () => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  assert.equal(
    r.headers.get('www-authenticate'),
    'Bearer resource_metadata="https://mcp.dailey.cloud/.well-known/oauth-protected-resource"',
  );
  const body = await r.json();
  assert.equal(body.jsonrpc, '2.0');
});

test('GET /mcp → 405 (stateless)', async () => {
  const r = await fetch(`${base}/mcp`, { headers: { Authorization: 'Bearer x' } });
  assert.equal(r.status, 405);
});

test('wrong content-type → 415', async () => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer x', 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415);
});

test('oauth-protected-resource metadata served', async () => {
  const r = await fetch(`${base}/.well-known/oauth-protected-resource`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.resource, 'https://mcp.dailey.cloud');
  assert.deepEqual(j.authorization_servers, ['https://core.dailey.cloud']);
});

test('tools/list works with any bearer (no capi call), excludes admin/switch/transfer, includes whoami', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer dummy-token' } },
  });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.length > 40);
  assert.ok(tools.tools.every((t) => !t.name.startsWith('dailey_admin')));
  const names = tools.tools.map((t) => t.name);
  // includeLocalAuth is TRUE on the remote surface — dailey_whoami must be reachable.
  assert.ok(names.includes('dailey_whoami'), 'dailey_whoami should be on the remote surface');
  // includeAccountSwitch and includeAdmin are FALSE on the remote surface.
  assert.ok(!names.includes('dailey_use_account'), 'dailey_use_account must not be on the remote surface');
  assert.ok(!names.includes('dailey_project_transfer_plan'), 'dailey_project_transfer_plan must not be on the remote surface');
  await client.close();
});

test('per-token rate limit trips at 61st request in a minute', async () => {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ratelimit-test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }),
    });
    assert.notEqual(r.status, 429, `request ${i + 1}/60 should not be rate-limited`);
  }
  const r61 = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ratelimit-test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 60, method: 'ping' }),
  });
  assert.equal(r61.status, 429);
  assert.ok(r61.headers.get('retry-after'), 'Retry-After header should be present on 429');
});

test('whoami round-trip with a real token', { skip: !process.env.DAILEY_TEST_TOKEN }, async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.DAILEY_TEST_TOKEN}` } },
  });
  await client.connect(transport);
  const out = await client.callTool({ name: 'dailey_whoami', arguments: {} });
  assert.ok(JSON.stringify(out).length > 0);
  await client.close();
});

test('in-flight cap constants and cleanup', () => {
  assert.equal(MAX_INFLIGHT, 50, 'MAX_INFLIGHT should be 50');
  assert.equal(getInflight(), 0, 'inflight counter should be 0 after all requests completed (no leak)');
});
