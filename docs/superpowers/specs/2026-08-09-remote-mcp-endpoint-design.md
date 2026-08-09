# Remote MCP endpoint — mcp.dailey.cloud (design)

Approved by Jonny 2026-08-09 (brainstorm in ops session). v1 = bearer-token auth; Core OAuth 2.1 is phase 2, out of scope here.

## Goal
Expose the existing DOS MCP tools over streamable HTTP at `https://mcp.dailey.cloud` so remote-capable clients (Cursor, claude.ai, ChatGPT connectors) attach with a URL + DOS API token — no local install. The npm stdio package (`@daileyos/mcp-server`) keeps working unchanged.

## Decisions (locked)
- **Tool surface:** everything except `registerAdminTools` and the local auth tools (`registerAuthTools` — device-login/config-file flows are meaningless remotely; remote auth IS the bearer token). capi remains the sole authorizer.
- **Tokens:** existing DOS API tokens (same value `DAILEY_API_TOKEN` takes today; users copy from the dashboard). No new token type in v1.
- **Hosting:** normal DOS project (internal account), repo-first from this repo, domain `mcp.dailey.cloud`, 1 replica.
- **Transport:** streamable HTTP, **stateless mode** (`sessionIdGenerator: undefined`) — all tools are request/response; restarts invisible; no session store.

## Architecture
One repo (`dailey-mcp`), two entries sharing one assembly:

- `src/server.ts` (new): `buildServer(opts: { includeAdmin: boolean, includeLocalAuth: boolean }): McpServer` — moves the register-call block out of `index.ts` verbatim; gates `registerAdminTools` on `includeAdmin` and `registerAuthTools` on `includeLocalAuth`. `index.ts` keeps its version-check/active-account behavior and calls `buildServer({ includeAdmin: true, includeLocalAuth: true })` — stdio behavior byte-identical.
- `src/http.ts` (new): node `http` server.
  - `POST /mcp` → SDK `StreamableHTTPServerTransport` (stateless), one `buildServer({ includeAdmin: false, includeLocalAuth: false })` + transport per request (stateless pattern), request handling wrapped in the token context (below).
  - `GET /` → minimal HTML: what this is, how to attach (Cursor/claude.ai snippets), link to docs.
  - `GET /healthz` → 200 `ok`.
  - `GET /.well-known/oauth-protected-resource` → static JSON naming `https://core.dailey.cloud` as the (future) authorization server; contract-correct stub so OAuth-capable clients discover cleanly in phase 2.
  - CORS: `Access-Control-Allow-Origin: *`, allow `Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version`; handle `OPTIONS`.
  - `DELETE /mcp` and `GET /mcp` → 405 (stateless mode has no sessions / no server-push stream).

## Per-request auth (the one real mechanism)
`src/api.ts` gains an `AsyncLocalStorage<{ token: string }>` exported as `tokenContext`. `resolveToken()` checks `tokenContext.getStore()?.token` FIRST, then falls back to today's env/config chain. `http.ts`:
1. Reads `Authorization: Bearer <token>`; missing/malformed → HTTP 401, `WWW-Authenticate: Bearer resource_metadata="https://mcp.dailey.cloud/.well-known/oauth-protected-resource"`, JSON-RPC error body.
2. Valid shape → `tokenContext.run({ token }, () => transport.handleRequest(...))`.
3. No token validation at the MCP layer — a bad token surfaces as capi's 401 through the existing `formatError` path on first tool call.
Zero changes to the 41 tool modules.

## Security
- Admin + local-auth tools never registered on the remote surface.
- In-process per-token rate limit: 60 requests/min (fixed window, `Map<tokenHash, {count, windowStart}>`); over-limit → HTTP 429. Token keys are sha256 truncations — raw tokens never held beyond the request, never logged.
- No request-body logging; access log line = method, path, status, duration, token hash prefix (8 chars).
- `setActiveAccount`/`getActiveAccount` module state is process-global today; the remote entry must NOT use it (account scoping stays per-call via the tools' existing per-call account params — v1.21.0 added per-call account scope, which is what remote uses). `http.ts` never calls `setActiveAccount`.

## Deployment
- `Dockerfile` (new, repo root): node:22-alpine, `npm ci && npm run build`, `CMD ["node", "dist/http.js"]`, `EXPOSE 8080` (`PORT` env honored, default 8080).
- DOS project `dailey-mcp-remote` (internal account) built from this repo's main; domain `mcp.dailey.cloud`; resources 100m/128Mi req, 500m/512Mi lim.
- The container reaches capi via the public `https://os.dailey.cloud/api` (default `DAILEY_API_URL`) — no in-cluster coupling, no netpol work (customer-ns egress to public IPs is allowed).

## Error handling
- 401 (no/malformed bearer) and 429 (rate limit) at HTTP layer with JSON-RPC-shaped bodies.
- Everything else flows through the SDK transport; tool errors keep the existing `formatError`/`remediationFor` copy (already plain-language).
- Uncaught handler errors → 500 JSON-RPC internal error; process stays up (per-request try/catch).

## Testing
1. **Unit** (`test/`): `resolveToken()` prefers tokenContext over env; `buildServer({includeAdmin:false})` registers no `dailey_admin_*` and no login tools; rate limiter windows.
2. **Integration** (local): start `dist/http.js`, connect with `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport` + `Authorization` header, `tools/list` (assert no admin tools, count > 40), call `dailey_whoami` with a real token (env-gated test), assert identity echo.
3. **Live**: deploy → `curl /healthz` → attach from Cursor by URL → tool list + `dailey_whoami` + one read tool (`dailey_list_projects`).

## Out of scope (phase 2+)
Core OAuth 2.1 (authorization-server work in dailey-core, dynamic client registration, PKCE); scoped MCP-specific tokens + revocation UI; docs-site "Add to Cursor" deep-link buttons; MCP registry listings.
