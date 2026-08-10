# Remote MCP Endpoint (mcp.dailey.cloud) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the existing DOS MCP tools over hardened streamable HTTP at `https://mcp.dailey.cloud` (bearer-token auth) without changing the stdio npm package's behavior.

**Architecture:** One repo (`dailey-mcp`), two entries sharing one tool assembly: `src/server.ts` builds an `McpServer` with surface flags; `src/index.ts` (stdio) keeps today's behavior; new `src/http.ts` serves stateless streamable HTTP with per-request AsyncLocalStorage carrying `{token, account?}` so `api.ts` token/account resolution becomes request-scoped remotely and unchanged locally.

**Tech Stack:** TypeScript (existing tsconfig), `@modelcontextprotocol/sdk` (pin exact `1.27.1`), node `http` (no express), node:22-alpine container, `tsx --test` for tests (repo standard).

## Global Constraints (from the spec — verbatim where quoted)

- The server is **credential-free**: no secrets in env/ConfigMap/Secret for this workload; tokens exist only inside a request's ALS store. Never log tokens or tool arguments.
- Remote surface: NO `registerAdminTools`, NO account-SWITCH tool; `registerAuthTools` SHIPS remotely (amended — pure API tools incl. dailey_whoami); account-LIST tool stays and its remote description says to pass `account:` per call.
- Transport: streamable HTTP **stateless** (`sessionIdGenerator: undefined`); `GET /mcp` and `DELETE /mcp` → 405.
- HTTP hardening: body cap 1 MiB → 413; `headersTimeout` 10s; `requestTimeout` 120s; per-token limit 60 req/min → 429; global 600 req/min → 429 + `Retry-After`; POST /mcp requires `Content-Type: application/json`.
- 401 body is JSON-RPC-shaped with header `WWW-Authenticate: Bearer resource_metadata="https://mcp.dailey.cloud/.well-known/oauth-protected-resource"`.
- CORS: `Access-Control-Allow-Origin: *`; allow headers `Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version`; handle `OPTIONS` with 204.
- Access log line: method, path, status, duration ms, sha256(token) first 8 hex chars, tool name for tools/call. Never arguments.
- Dockerfile: node:22-alpine, `USER node`, `npm ci` + `npm audit --omit=dev --audit-level=critical` (build fails on critical), `NODE_ENV=production`, default `PORT=8080`.
- stdio behavior byte-identical: `src/index.ts` still registers everything (admin, auth, account switch) and keeps preflight/version-check logic.
- Commits go to `main` of `jonndailey/dailey-mcp` (repo has no CI deploy; npm publish is manual and NOT part of this plan).

## File Structure

- `src/context.ts` (new) — the ALS store: type, export, helpers. Single responsibility: request-scoped identity.
- `src/api.ts` (modify ~lines 44–66) — `resolveToken`/`setActiveAccount`/`getActiveAccount` consult the ALS store first.
- `src/server.ts` (new) — `buildServer(opts)`: constructs `McpServer` + all registrations, gated.
- `src/index.ts` (modify) — delete its inline construction/registration block; call `buildServer` with all-true flags. No other changes.
- `src/tools/accounts.ts` (modify) — `registerAccountTools(server, opts?)` gains `{ includeSwitch?: boolean; remoteHint?: boolean }` (defaults preserve today's behavior).
- `src/http.ts` (new) — the hardened HTTP entry.
- `test/context.test.ts`, `test/server-surface.test.ts`, `test/http.test.ts` (new).
- `Dockerfile`, `.dockerignore` (new, repo root).

---

### Task 1: Request-scoped identity context (`src/context.ts` + `api.ts` integration)

**Files:**
- Create: `src/context.ts`
- Modify: `src/api.ts` (the `resolveToken`, `setActiveAccount`, `getActiveAccount` bodies, ~lines 44–66)
- Test: `test/context.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `requestContext: AsyncLocalStorage<RequestIdentity>` and `interface RequestIdentity { token: string; account?: string }` from `src/context.ts`. Later tasks import `requestContext` and run handlers inside `requestContext.run({ token }, fn)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/context.test.ts
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
      setTimeout(() => { seen.push(getActiveAccount()); res(); }, 20);
    })),
    new Promise<void>((res) => requestContext.run({ token: 'b' }, () => {
      setActiveAccount('acct-b');
      setTimeout(() => { seen.push(getActiveAccount()); res(); }, 10);
    })),
  ]);
  assert.deepEqual(seen.sort(), ['acct-a', 'acct-b']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --experimental-test-module-mocks test/context.test.ts`
Expected: FAIL — `Cannot find module '../src/context.js'`.

- [ ] **Step 3: Create `src/context.ts`**

```ts
// Request-scoped identity for the remote (HTTP) entry. The stdio entry never
// enters this context, so api.ts falls through to its module-global/env logic
// there — stdio behavior is unchanged by construction.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestIdentity {
  token: string;
  /** Managed-account scope for THIS request only (X-Dailey-Account). */
  account?: string;
}

export const requestContext = new AsyncLocalStorage<RequestIdentity>();
```

- [ ] **Step 4: Integrate in `src/api.ts`**

Add the import at the top of `src/api.ts`:

```ts
import { requestContext } from './context.js';
```

Replace the three function bodies (keep the existing comments above them):

```ts
export function resolveToken(): string {
  const ctx = requestContext.getStore();
  if (ctx) return ctx.token;
  if (ENV_TOKEN) return ENV_TOKEN;
  if (refreshedToken) return refreshedToken;
  return readCliStoredToken() || '';
}
```

```ts
export function setActiveAccount(slugOrId: string | undefined): void {
  const v = slugOrId && slugOrId.trim() ? slugOrId.trim() : undefined;
  const ctx = requestContext.getStore();
  if (ctx) { ctx.account = v; return; } // request-scoped: dies with the request
  activeAccount = v;
}

export function getActiveAccount(): string | undefined {
  const ctx = requestContext.getStore();
  if (ctx) return ctx.account;
  return activeAccount;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test --experimental-test-module-mocks test/context.test.ts`
Expected: PASS (3/3). Note: this also satisfies the spec's `wordpress-live-edit.ts` item with zero edits there — its `setActiveAccount` call now lands in ALS during remote requests.

- [ ] **Step 6: Run the full existing suite to prove stdio semantics unchanged**

Run: `npm test`
Expected: same pass/fail set as before this task (compare against a pre-change run of `npm test`).

- [ ] **Step 7: Commit**

```bash
git add src/context.ts src/api.ts test/context.test.ts
git commit -m "feat(context): request-scoped token/account via AsyncLocalStorage"
```

### Task 2: Extract `buildServer` + surface flags

**Files:**
- Create: `src/server.ts`
- Modify: `src/index.ts` (remove inline `new McpServer(...)` at ~line 128 and the registration block ~lines 179–244; replace with a `buildServer` call)
- Modify: `src/tools/accounts.ts` (add opts param)
- Test: `test/server-surface.test.ts`

**Interfaces:**
- Consumes: all existing `registerXxxTools(server)` functions; `OWN_VERSION` from `./version.js`.
- Produces: `buildServer(opts: BuildOptions): McpServer` and `interface BuildOptions { includeAdmin: boolean; includeLocalAuth: boolean; includeAccountSwitch: boolean; instructions?: string }` from `src/server.ts`. Task 3 calls `buildServer({ includeAdmin: false, includeLocalAuth: true, includeAccountSwitch: false })` (AMENDED: auth.ts tools are pure API calls and ship remotely — see spec amendment).

- [ ] **Step 1: Write the failing test**

```ts
// test/server-surface.test.ts
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
  assert.ok(!names.includes('dailey_login'), 'local auth tool leaked');
  assert.ok(!names.includes('dailey_use_account'), 'account switch tool leaked');
  assert.ok(names.some((n) => n.includes('account')), 'account LIST tool should remain');
});

test('stdio surface includes everything', async () => {
  const names = await toolNames({ includeAdmin: true, includeLocalAuth: true, includeAccountSwitch: true });
  assert.ok(names.some((n) => n.startsWith('dailey_admin')), 'admin tools missing on stdio surface');
  assert.ok(names.includes('dailey_use_account') || names.some((n) => n.includes('use_account')), 'switch tool missing on stdio surface');
});
```

Before finalizing assertions, verify the actual tool names: `grep -n "'dailey_" src/tools/auth.ts src/tools/accounts.ts src/tools/admin.ts | head -20` and adjust the exact strings (`dailey_login`, `dailey_use_account`, `dailey_admin*`) to what is registered. If `(server as any)._registeredTools` is not present in SDK 1.27.1, use the documented alternative: call `server.tool` count via a wrapper — wrap registration by passing a Proxy'd server that records `tool()` names into an array, and assert on that array instead (the Proxy approach works regardless of SDK internals; prefer it if the private map is absent).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --experimental-test-module-mocks test/server-surface.test.ts`
Expected: FAIL — `Cannot find module '../src/server.js'`.

- [ ] **Step 3: Create `src/server.ts`**

Move VERBATIM from `src/index.ts`: the whole import block for `register*` functions (index.ts lines 9–49), the `new McpServer(...)` expression (index.ts ~line 128, including its `name: 'dailey-os', version: OWN_VERSION` args), and the full registration call sequence (~lines 179–244, keeping every comment). Shape:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OWN_VERSION } from './version.js';
// ... all registerXxxTools imports moved verbatim from index.ts ...

export interface BuildOptions {
  includeAdmin: boolean;
  includeLocalAuth: boolean;
  includeAccountSwitch: boolean;
  instructions?: string;
}

export function buildServer(opts: BuildOptions): McpServer {
  const server = new McpServer(
    { name: 'dailey-os', version: OWN_VERSION },
    opts.instructions ? { instructions: opts.instructions } : undefined,
  );

  if (opts.includeLocalAuth) registerAuthTools(server);
  registerAccountTools(server, {
    includeSwitch: opts.includeAccountSwitch,
    remoteHint: !opts.includeAccountSwitch,
  });
  // ... every other register call moved verbatim, in the same order ...
  if (opts.includeAdmin) registerAdminTools(server);
  // ... remainder verbatim ...
  return server;
}
```

- [ ] **Step 4: Add opts to `src/tools/accounts.ts`**

Change the signature (line ~20) to:

```ts
export function registerAccountTools(
  server: McpServer,
  opts: { includeSwitch?: boolean; remoteHint?: boolean } = {},
): void {
  const { includeSwitch = true, remoteHint = false } = opts;
```

Wrap the SECOND `server.tool(` block (the switch tool at ~line 47) in `if (includeSwitch) { ... }`. On the FIRST (list) tool, append to its description string when `remoteHint` is true:

```ts
(remoteHint ? ' NOTE: this server is remote and stateless — there is no session account switching. Pass `account: "<slug>"` on each tool call to operate in a managed account.' : '')
```

- [ ] **Step 5: Rewire `src/index.ts`**

Delete the moved code; in its place:

```ts
import { buildServer } from './server.js';
// ... existing preflight/version-check code stays exactly as-is ...
const server = buildServer({
  includeAdmin: true,
  includeLocalAuth: true,
  includeAccountSwitch: true,
  instructions: newerVersion ? outdatedNotice(newerVersion) : undefined,
});
```

The `hasCredentials`/`getActiveAccount`/`setActiveAccount` imports index.ts still uses for preflight stay.

- [ ] **Step 6: Run tests**

Run: `npx tsx --test --experimental-test-module-mocks test/server-surface.test.ts && npm test`
Expected: new test PASS; full suite unchanged vs baseline.

- [ ] **Step 7: Build + stdio smoke**

Run: `npm run build && printf '' | DAILEY_API_TOKEN=x node dist/index.js` (should start and exit cleanly on stdin EOF, no stack trace).

- [ ] **Step 8: Commit**

```bash
git add src/server.ts src/index.ts src/tools/accounts.ts test/server-surface.test.ts
git commit -m "refactor(server): buildServer with surface flags; account tools gain switch/remote opts"
```

### Task 3: Hardened HTTP entry (`src/http.ts`)

**Files:**
- Create: `src/http.ts`
- Test: `test/http.test.ts`

**Interfaces:**
- Consumes: `buildServer` (Task 2), `requestContext` (Task 1), `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`.
- Produces: a runnable `dist/http.js` honoring `PORT` (default 8080). Exports `createHttpServer(): http.Server` for tests; `if (import.meta.url === pathToFileURL(process.argv[1]).href)` guard starts listening.

- [ ] **Step 1: Write the failing test**

```ts
// test/http.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createHttpServer } from '../src/http.js';

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
  assert.match(r.headers.get('www-authenticate') ?? '', /resource_metadata=/);
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

test('tools/list works with any bearer (no capi call) and excludes admin', async () => {
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
  await client.close();
});

test('per-token rate limit trips at 61st request in a minute', async () => {
  let last = 0;
  for (let i = 0; i < 61; i++) {
    const r = await fetch(`${base}/healthz-limited-probe`, { method: 'POST', headers: { Authorization: 'Bearer ratelimit-test', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => null);
    // use /mcp for the real limiter:
    const r2 = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer ratelimit-test', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }) });
    last = r2.status;
    if (last === 429) break;
  }
  assert.equal(last, 429);
});
```

(Trim the stray `healthz-limited-probe` fetch when writing — the real assertions are on `/mcp`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --experimental-test-module-mocks test/http.test.ts`
Expected: FAIL — `Cannot find module '../src/http.js'`.

- [ ] **Step 3: Implement `src/http.ts`**

```ts
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
```

Note for the implementer: SDK 1.27.1's `StreamableHTTPServerTransport.handleRequest(req, res, parsedBody)` accepts the pre-parsed body as the third argument — check `node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.d.ts` and, if the signature differs (some versions read the stream themselves), pass the raw body through instead per its actual signature. Do not guess: read the .d.ts.

- [ ] **Step 4: Run tests**

Run: `npx tsx --test --experimental-test-module-mocks test/http.test.ts`
Expected: PASS (7/7).

- [ ] **Step 5: Env-gated live-token integration test (append to `test/http.test.ts`)**

```ts
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
```

Run once with a real token from the operator: `DAILEY_TEST_TOKEN=... npx tsx --test --experimental-test-module-mocks test/http.test.ts` → the extra test passes. (Verify the whoami tool's registered name with `grep -rn "dailey_whoami" src/tools/ | head -1` and adjust if it differs.)

- [ ] **Step 6: Full suite + build**

Run: `npm test && npm run build && node -e "import('./dist/http.js')" & sleep 2 && curl -s localhost:8080/healthz && kill %1`
Expected: suite baseline-clean; healthz prints `ok`.

- [ ] **Step 7: Commit**

```bash
git add src/http.ts test/http.test.ts
git commit -m "feat(http): hardened stateless streamable-HTTP entry (bearer auth, rate limits, CORS, PRM stub)"
```

### Task 4: Container + package plumbing

**Files:**
- Create: `Dockerfile`, `.dockerignore`
- Modify: `package.json` (pin SDK exact; add `start:http`; extend `build`)

- [ ] **Step 1: Pin the SDK and add scripts**

```bash
npm pkg set 'dependencies.@modelcontextprotocol/sdk=1.27.1'
npm pkg set 'scripts.start:http=node dist/http.js'
npm install
git diff package.json  # confirm only those changes + lockfile
```

- [ ] **Step 2: Write `Dockerfile`**

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Security gate: fail the build on critical advisories in prod deps.
RUN npm audit --omit=dev --audit-level=critical
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
USER node
EXPOSE 8080
CMD ["node", "dist/http.js"]
```

- [ ] **Step 3: Write `.dockerignore`**

```
node_modules
dist
docs
test
.git
*.md
```

- [ ] **Step 4: Local container smoke**

```bash
docker build -t dailey-mcp-http:dev .
docker run --rm -d -p 18080:8080 --name mcp-smoke dailey-mcp-http:dev
sleep 2
curl -s localhost:18080/healthz            # expect: ok
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:18080/mcp -H 'Content-Type: application/json' -d '{}'   # expect: 401
docker rm -f mcp-smoke
```

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore package.json package-lock.json
git commit -m "build(docker): hardened non-root image for the http entry; pin SDK exact"
```

### Task 5: Deploy to DOS + live verification (operator task — runs on King, not a code subagent)

**Files:** none in this repo (uses the DOS dashboard/MCP tooling + this repo's main).

- [ ] **Step 1: Push main** — `git push origin main` (repo `jonndailey/dailey-mcp`; no CI publishes npm from this — verified, publish is manual).
- [ ] **Step 2: Create the DOS project** via `dailey_create_project` (internal account): name `dailey-mcp-remote`, repo `https://github.com/jonndailey/dailey-mcp`, branch `main` (Dockerfile auto-detected). Resources: 0.1 CPU / 128 MB request, 0.5 / 512 limit.
- [ ] **Step 3: Domain** — attach `mcp.dailey.cloud` via `dailey_domains`; wait for cert.
- [ ] **Step 4: Verify security posture live:**
  - `curl -s https://mcp.dailey.cloud/healthz` → `ok`
  - `curl -s -o /dev/null -w '%{http_code}' -X POST https://mcp.dailey.cloud/mcp -H 'Content-Type: application/json' -d '{}'` → `401` with `WWW-Authenticate` header present (`curl -sI` variant)
  - `curl -s https://mcp.dailey.cloud/.well-known/oauth-protected-resource` → the PRM JSON
  - Confirm the deployment has NO secret envFrom carrying credentials (`kubectl -n <ns> get deploy dailey-mcp-remote -o yaml | grep -A5 envFrom` — only optional platform mounts; the credential-free property).
  - `readOnlyRootFilesystem`: check whether the deploy-service template supports it; if not, record the gap in the EOS note (accepted for v1) rather than hand-editing the live object.
- [ ] **Step 5: Real-client verification** — attach from Cursor (Settings → MCP → URL `https://mcp.dailey.cloud/mcp`, header `Authorization: Bearer <token>`): tool list loads (>40 tools, no admin), `dailey_whoami` returns identity, `dailey_list_projects` returns projects.
- [ ] **Step 6: Documentation** — EOS release note (what shipped, security posture, the credential-free property, phase-2 OAuth pointer) + memory update; add the endpoint to the registry of public surfaces in `Dailey OS Operations.md`.

## Self-review (done at write time)

- **Spec coverage:** every spec section maps: architecture→T2/T3, auth/ALS→T1/T3, security items→T3 (limits/CORS/log/timeouts) + T4 (container/audit/pin) + T5.4 (credential-free check, readOnly gap), hosting→T5, stub PRM→T3, testing→T1/T2/T3 tests + T5 live. Out-of-scope items stay out.
- **Placeholders:** none; the two "verify against actual" notes (tool names, SDK handleRequest signature) instruct reading real files, with exact commands — deliberate anti-guessing guards, not gaps.
- **Type consistency:** `RequestIdentity`/`requestContext` (T1) used in T3; `BuildOptions`/`buildServer` (T2) used in T3; `createHttpServer` (T3) used in its own tests. Names match throughout.
