import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';

// The hosted server validates every bearer against the customer-api before it
// counts a request or builds an McpServer (security review 2026-10-15, H3).
// This fake capi answers GET /api/customers/me: 200 for VALID tokens, 502 for
// 'capi-down', 401 for everything else. DAILEY_API_URL must point at it BEFORE
// src/http.ts (and the api.ts it imports) is loaded, hence the dynamic import.
const VALID = new Set(['valid-token', 'ratelimit-token']);
const upstreamHits = new Map<string, number>();
let capi: Server;
let server: Server;
let base: string;
let mod: typeof import('../src/http.js');

function listen(s: Server): Promise<number> {
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));
}

before(async () => {
  capi = http.createServer((req, res) => {
    const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
    upstreamHits.set(tok, (upstreamHits.get(tok) ?? 0) + 1);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' || req.url !== '/api/customers/me') return send(404, { error: 'not found' });
    if (tok === 'capi-down') return send(502, { error: 'bad gateway' });
    if (VALID.has(tok)) return send(200, { id: 'cust_test', name: 'Test', email: 'test@example.com' });
    return send(401, { error: 'Invalid or expired token' });
  });
  const capiPort = await listen(capi);
  process.env.DAILEY_API_URL = `http://127.0.0.1:${capiPort}/api`;
  mod = await import('../src/http.js');
  server = mod.createHttpServer();
  base = `http://127.0.0.1:${await listen(server)}`;
});
after(() => {
  server?.closeAllConnections(); server?.close();
  capi?.closeAllConnections(); capi?.close();
});

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

function post(token: string, body: unknown): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
}

async function connectClient(token: string) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

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

test('wrong content-type → 415 without an upstream token check', async () => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer ct-token', 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415);
  assert.equal(upstreamHits.get('ct-token'), undefined, 'a malformed request must not cost a customer-api call');
});

test('oauth-protected-resource metadata served', async () => {
  const r = await fetch(`${base}/.well-known/oauth-protected-resource`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.resource, 'https://mcp.dailey.cloud');
  assert.deepEqual(j.authorization_servers, ['https://core.dailey.cloud']);
});

test('initialize with an invalid bearer → small 401 with WWW-Authenticate; no rate-limit counter moves', async () => {
  const before = mod.getRateCounters();
  const r = await post('not-a-real-token', INIT);
  assert.equal(r.status, 401);
  const www = r.headers.get('www-authenticate') || '';
  assert.match(www, /^Bearer /);
  assert.match(www, /error="invalid_token"/);
  assert.match(www, /resource_metadata="https:\/\/mcp\.dailey\.cloud\/\.well-known\/oauth-protected-resource"/);
  const text = await r.text();
  assert.ok(text.length < 512, `401 body should be small, got ${text.length} bytes`);
  const body = JSON.parse(text);
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.error.code, -32001);
  assert.equal(upstreamHits.get('not-a-real-token'), 1);
  assert.deepEqual(mod.getRateCounters(), before, 'an unvalidated token must not touch the global or per-token windows');
});

test('tools/list with an invalid bearer → 401, never the tool list', async () => {
  const r = await post('another-junk-token', LIST);
  assert.equal(r.status, 401);
  const text = await r.text();
  assert.ok(!text.includes('dailey_'), 'no tool names may leak to an unauthenticated caller');
});

test('an invalid token is cached: repeated attempts cost one upstream call', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await post('repeat-junk', INIT)).status, 401);
  assert.equal(upstreamHits.get('repeat-junk'), 1);
});

test('customer-api failure → 503 + Retry-After, not cached, no rate-limit counter moves', async () => {
  const before = mod.getRateCounters();
  const r1 = await post('capi-down', INIT);
  assert.equal(r1.status, 503);
  assert.ok(r1.headers.get('retry-after'), 'Retry-After header should be present on 503');
  assert.equal((await post('capi-down', INIT)).status, 503);
  assert.equal(upstreamHits.get('capi-down'), 2, 'an upstream failure must not be cached as a verdict');
  assert.deepEqual(mod.getRateCounters(), before);
});

test('valid bearer: initialize + tools/list work on one cached check; excludes admin/switch/transfer, includes whoami', async () => {
  const before = mod.getRateCounters();
  const client = await connectClient('valid-token');
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
  assert.equal(upstreamHits.get('valid-token'), 1, 'initialize, notifications/initialized and tools/list share one cached check');
  assert.ok(mod.getRateCounters().global > before.global, 'validated requests count toward the global window');
});

test('per-token rate limit trips at 61st request in a minute', async () => {
  for (let i = 0; i < 60; i++) {
    const r = await post('ratelimit-token', { jsonrpc: '2.0', id: i, method: 'ping' });
    assert.notEqual(r.status, 429, `request ${i + 1}/60 should not be rate-limited`);
    assert.notEqual(r.status, 401, `request ${i + 1}/60 carries a valid token`);
  }
  const r61 = await post('ratelimit-token', { jsonrpc: '2.0', id: 60, method: 'ping' });
  assert.equal(r61.status, 429);
  assert.ok(r61.headers.get('retry-after'), 'Retry-After header should be present on 429');
  assert.equal(upstreamHits.get('ratelimit-token'), 1, '61 requests, one upstream check');
});

test('in-flight cap constants and cleanup', () => {
  assert.equal(mod.MAX_INFLIGHT, 50, 'MAX_INFLIGHT should be 50');
  assert.equal(mod.getInflight(), 0, 'inflight counter should be 0 after all requests completed (no leak)');
});
