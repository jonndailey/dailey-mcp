import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

// Live round trip against the real customer-api (DAILEY_API_URL, or the public
// default). Kept apart from http.test.ts, which points DAILEY_API_URL at a fake
// customer-api; node:test runs each file in its own process, so the two never
// share an API URL.
test('whoami round-trip with a real token', { skip: !process.env.DAILEY_TEST_TOKEN }, async () => {
  const { createHttpServer } = await import('../src/http.js');
  const server: Server = createHttpServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
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
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
