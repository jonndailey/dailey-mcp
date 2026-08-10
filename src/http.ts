import http from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './server.js';
import { requestContext } from './context.js';

const PORT = Number(process.env.PORT || 8080);
const BODY_LIMIT = 1024 * 1024; // 1 MiB
const PER_TOKEN_LIMIT = 60;     // req/min
const GLOBAL_LIMIT = 600;       // req/min
const RESOURCE = 'https://mcp.dailey.cloud';
const AUTH_SERVER = 'https://core.dailey.cloud';

// ── fixed-window rate limiting ──────────────────────────────────────────────
const tokenWindows = new Map<string, { count: number; windowStart: number }>();
let globalWindow = { count: 0, windowStart: Date.now() };
function allow(tokenHash: string): boolean {
  const now = Date.now();
  if (now - globalWindow.windowStart >= 60_000) globalWindow = { count: 0, windowStart: now };
  if (++globalWindow.count > GLOBAL_LIMIT) return false;
  const w = tokenWindows.get(tokenHash);
  if (!w || now - w.windowStart >= 60_000) { tokenWindows.set(tokenHash, { count: 1, windowStart: now }); return true; }
  return ++w.count <= PER_TOKEN_LIMIT;
}
setInterval(() => { // stop the map growing forever
  const cutoff = Date.now() - 120_000;
  for (const [k, w] of tokenWindows) if (w.windowStart < cutoff) tokenWindows.delete(k);
}, 60_000).unref();

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 8);
}

function cors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version');
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(res: http.ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  json(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) { resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

const LANDING = `<!doctype html><title>Dailey OS MCP</title>
<h1>Dailey OS remote MCP endpoint</h1>
<p>Point your MCP client at <code>${RESOURCE}/mcp</code> with header
<code>Authorization: Bearer &lt;your DOS API token&gt;</code> (copy the token from the
<a href="https://os.dailey.cloud">dashboard</a>). Docs: <a href="https://docs.dailey.cloud">docs.dailey.cloud</a>.</p>`;

export function createHttpServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = (req.url || '/').split('?')[0];
    let logSuffix = '';
    const finish = (status: number) => {
      // access log: method path status duration token-hash tool — never bodies/args
      console.log(`${req.method} ${url} ${status} ${Date.now() - started}ms${logSuffix}`);
    };
    res.on('finish', () => finish(res.statusCode));
    try {
      if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }
      if (url === '/healthz') { cors(res); res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
      if (url === '/' && req.method === 'GET') { cors(res); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(LANDING); return; }
      if (url === '/.well-known/oauth-protected-resource') {
        json(res, 200, { resource: RESOURCE, authorization_servers: [AUTH_SERVER], bearer_methods_supported: ['header'] });
        return;
      }
      if (url !== '/mcp') { rpcError(res, 404, -32601, 'Not found'); return; }
      if (req.method !== 'POST') { rpcError(res, 405, -32601, 'Stateless server: only POST /mcp is supported'); return; }

      const auth = req.headers.authorization || '';
      const m = /^Bearer\s+(\S+)$/i.exec(auth);
      if (!m) {
        rpcError(res, 401, -32001, 'Missing bearer token. Get a DOS API token from https://os.dailey.cloud and send Authorization: Bearer <token>.',
          { 'WWW-Authenticate': `Bearer resource_metadata="${RESOURCE}/.well-known/oauth-protected-resource"` });
        return;
      }
      const token = m[1];
      const tokenHash = hashToken(token);
      logSuffix = ` tok=${tokenHash}`;

      if (!/^application\/json/.test(req.headers['content-type'] || '')) {
        rpcError(res, 415, -32600, 'Content-Type must be application/json'); return;
      }
      if (!allow(tokenHash)) {
        rpcError(res, 429, -32000, 'Rate limit exceeded (60/min per token). Slow down.', { 'Retry-After': '30' }); return;
      }
      const raw = await readBody(req);
      if (raw === null) { rpcError(res, 413, -32600, 'Body too large (limit 1 MiB)'); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { rpcError(res, 400, -32700, 'Parse error'); return; }
      const toolName = (parsed as any)?.method === 'tools/call' ? String((parsed as any)?.params?.name ?? '') : '';
      if (toolName) logSuffix += ` tool=${toolName}`;

      // Stateless: fresh server+transport per request; identity lives in ALS.
      const mcp = buildServer({ includeAdmin: false, includeLocalAuth: true, includeAccountSwitch: false });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      cors(res);
      res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
      await requestContext.run({ token }, async () => {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, parsed);
      });
    } catch (err) {
      console.error('handler error:', (err as Error).message);
      if (!res.headersSent) rpcError(res, 500, -32603, 'Internal error');
      else res.end();
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createHttpServer().listen(PORT, () => console.log(`dailey-mcp http listening on :${PORT} (stateless streamable HTTP)`));
}
