import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { requestContext, mcpToolName, isHostedRequest } from '../src/context.js';

test('mcpToolName accepts a tool name and rejects arguments', () => {
  assert.equal(mcpToolName('dailey_whoami'), 'dailey_whoami');
  assert.equal(mcpToolName('dailey_list_projects; cat /etc/passwd'), undefined);
  assert.equal(mcpToolName('{"name":"dailey_whoami","arguments":{"password":"s3cret"}}'), undefined);
});

test('isHostedRequest is true for HTTP stores (including legacy token-only) and false for stdio usage stores', () => {
  assert.equal(isHostedRequest(), false);
  requestContext.run({ token: 't' }, () => {
    assert.equal(isHostedRequest(), true);
  });
  requestContext.run({ token: 't', transport: 'http', tool: 'dailey_whoami' }, () => {
    assert.equal(isHostedRequest(), true);
  });
  requestContext.run({ token: 't', transport: 'stdio', tool: 'dailey_whoami' }, () => {
    assert.equal(isHostedRequest(), false);
  });
});

const seen: Array<Record<string, string>> = [];
mock.module('node:fs', {
  namedExports: {
    readFileSync: () => { throw new Error('no cli config in tests'); },
  },
});

// api.ts reads env at module load. Set a token, then import.
process.env.DAILEY_API_TOKEN = 'tok-test';
process.env.DAILEY_API_URL = 'http://127.0.0.1:9'; // unused; we mock fetch
const origFetch = globalThis.fetch;
globalThis.fetch = (async (_url: any, init?: any) => {
  seen.push({ ...(init?.headers || {}) });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as any;

const { apiRequest } = await import('../src/api.js');

test('apiRequest sends source, version, and usage headers from the ALS store', async () => {
  seen.length = 0;
  await requestContext.run({ token: 'tok-req', tool: 'dailey_whoami', transport: 'stdio' }, async () => {
    await apiRequest('GET', '/customers/me');
  });
  assert.equal(seen.length, 1);
  const h = seen[0];
  assert.equal(h['X-Dailey-Source'], 'mcp');
  assert.equal(h['X-Dailey-MCP-Tool'], 'dailey_whoami');
  assert.equal(h['X-Dailey-MCP-Transport'], 'stdio');
  assert.ok(h['X-Dailey-Client-Version']);
  assert.equal(h.Authorization, 'Bearer tok-req');
  assert.ok(!JSON.stringify(h).includes('s3cret'));
  assert.ok(!Object.keys(h).some((k) => k.toLowerCase().includes('arg')));
});

test('apiRequest omits the tool header when no tool is in the store', async () => {
  seen.length = 0;
  await requestContext.run({ token: 'tok-req', transport: 'http' }, async () => {
    await apiRequest('GET', '/customers/me');
  });
  assert.equal(seen[0]['X-Dailey-MCP-Transport'], 'http');
  assert.equal(seen[0]['X-Dailey-MCP-Tool'], undefined);
});

test('apiRequest never forwards a junk tool string as a header', async () => {
  seen.length = 0;
  await requestContext.run({
    token: 'tok-req',
    tool: '{"arguments":{"password":"s3cret"}}',
    transport: 'stdio',
  }, async () => {
    await apiRequest('GET', '/customers/me');
  });
  assert.equal(seen[0]['X-Dailey-MCP-Tool'], undefined);
});

test('after hook restores fetch', () => {
  globalThis.fetch = origFetch;
});
