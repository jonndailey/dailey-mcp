import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Regression: every 403 from the customer-api used to be mapped to the generic
// `DAILEY_AUTH_REQUIRED / Not authenticated` object, hiding real permission
// errors such as capi's 403 "backup does not belong to this project" or
// "no_manager_grant". 401 keeps the auth guidance; 403 must surface the
// server's own reason, falling back to "You don't have permission to do that".

process.env.DAILEY_API_TOKEN ||= 'test-token';
process.env.DAILEY_API_URL ||= 'http://capi.test/api';

const { formatError, remediationFor, serverErrorMessage, permissionDenied, PERMISSION_DENIED_FALLBACK, setActiveAccount } =
  await import('../src/api.js');
const { registerAuthTools } = await import('../src/tools/auth.js');
const { registerAccountTools } = await import('../src/tools/accounts.js');

type Handler = (args: any) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
function makeFakeServer() {
  const handlers = new Map<string, Handler>();
  const server = { tool: (name: string, _d: string, _s: unknown, h: Handler) => { handlers.set(name, h); } };
  return { server, get: (name: string) => handlers.get(name)! };
}

const realFetch = globalThis.fetch;
function stubFetch(status: number, body: unknown) {
  globalThis.fetch = (async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; setActiveAccount(undefined); });

// ── formatError ─────────────────────────────────────────────────────────

test('formatError: 401 keeps the structured auth guidance', () => {
  const parsed = JSON.parse(formatError({ ok: false, status: 401, data: { error: 'Invalid or expired token' } }));
  assert.equal(parsed.error_code, 'DAILEY_AUTH_REQUIRED');
  assert.equal(parsed.message, 'Not authenticated');
  assert.match(parsed.remediation, /dailey login/);
});

test('formatError: 403 surfaces the server error instead of "Not authenticated"', () => {
  const out = formatError({ ok: false, status: 403, data: { error: 'backup does not belong to this project' } });
  assert.match(out, /^Error \(403\): backup does not belong to this project/);
  assert.doesNotMatch(out, /Not authenticated|DAILEY_AUTH_REQUIRED/);
  assert.match(out, /Remediation: .*not allowed/);
});

test('formatError: 403 with a code-style error leads with the human message', () => {
  const out = formatError({
    ok: false,
    status: 403,
    data: { error: 'account_inactive', message: 'Account access has been revoked. Contact support for a review.' },
  });
  assert.match(out, /Error \(403\): Account access has been revoked\. Contact support for a review\. \(account_inactive\)/);
});

test('formatError: 403 keeps detail text (email verification)', () => {
  const out = formatError({
    ok: false,
    status: 403,
    data: { error: 'Email verification required', detail: 'Please verify your email address.', code: 'EMAIL_NOT_VERIFIED' },
  });
  assert.match(out, /Email verification required: Please verify your email address\./);
});

test('formatError: 403 with no body falls back to a clear permission message', () => {
  for (const data of [{}, '', '<html>403 Forbidden</html>', null]) {
    const out = formatError({ ok: false, status: 403, data });
    assert.match(out, new RegExp(`^Error \\(403\\): ${PERMISSION_DENIED_FALLBACK}`), `body ${JSON.stringify(data)}`);
  }
});

test('formatError: other statuses are unchanged', () => {
  assert.match(formatError({ ok: false, status: 404, data: { error: 'Project not found' } }), /^Error \(404\): Project not found$/);
  assert.match(formatError({ ok: false, status: 429, data: { error: 'slow down' } }), /Rate limited/);
});

// ── remediationFor ──────────────────────────────────────────────────────

test('remediationFor: 401 points at login, plain 403 does not', () => {
  assert.match(remediationFor(401, {}) || '', /dailey login/);
  const h403 = remediationFor(403, { error: 'no_manager_grant' }) || '';
  assert.doesNotMatch(h403, /Run `dailey login`/);
  assert.match(h403, /not allowed/);
});

test('remediationFor: 403 audience mismatch and read-only key get specific hints', () => {
  assert.match(remediationFor(403, { error: 'Token audience not permitted for this service' }) || '', /dailey login/);
  assert.match(remediationFor(403, { error: 'This API key is read-only; this action requires elevation.', code: 'STEP_UP_REQUIRED' }) || '', /read-only/);
});

test('remediationFor: storage SignatureDoesNotMatch on 403 still wins over the generic hint', () => {
  assert.match(remediationFor(403, { error: 'SignatureDoesNotMatch' }) || '', /Storage creds/);
});

// ── helpers ─────────────────────────────────────────────────────────────

test('serverErrorMessage / permissionDenied shapes', () => {
  assert.equal(serverErrorMessage({ error: 'x y' }), 'x y');
  assert.equal(serverErrorMessage({}), null);
  assert.equal(serverErrorMessage('   '), null);
  const pd = permissionDenied({ error: 'nope', code: 'EMAIL_NOT_VERIFIED' });
  assert.deepEqual(pd, { error_code: 'DAILEY_PERMISSION_DENIED', status: 403, message: 'nope', server_code: 'EMAIL_NOT_VERIFIED' });
  assert.equal(permissionDenied(undefined).message, PERMISSION_DENIED_FALLBACK);
});

// ── tool handlers that special-cased 401/403 ───────────────────────────

test('dailey_whoami: 401 -> auth required, 403 -> server reason', async () => {
  const { server, get } = makeFakeServer();
  registerAuthTools(server as any);

  stubFetch(401, { error: 'Invalid or expired token' });
  assert.equal(JSON.parse((await get('dailey_whoami')({})).content[0].text).error_code, 'DAILEY_AUTH_REQUIRED');

  stubFetch(403, { error: 'no_manager_grant' });
  const r = JSON.parse((await get('dailey_whoami')({})).content[0].text);
  assert.equal(r.error_code, 'DAILEY_PERMISSION_DENIED');
  assert.equal(r.message, 'no_manager_grant');
});

test('dailey_auth_status: 403 is not reported as a plain sign-in problem', async () => {
  const { server, get } = makeFakeServer();
  registerAuthTools(server as any);

  stubFetch(401, { error: 'Invalid or expired token' });
  const unauth = JSON.parse((await get('dailey_auth_status')({})).content[0].text);
  assert.equal(unauth.authenticated, false);
  assert.equal(unauth.status, undefined);

  setActiveAccount('acme');
  stubFetch(403, { error: 'no_manager_grant' });
  const denied = JSON.parse((await get('dailey_auth_status')({})).content[0].text);
  assert.equal(denied.status, 403);
  assert.equal(denied.authorized, false);
  assert.equal(denied.error, 'no_manager_grant');
  assert.match(denied.recommended_action, /acting as "acme".*clear: true/);
});

test('dailey_accounts / dailey_use_account: 403 surfaces the server reason', async () => {
  const { server, get } = makeFakeServer();
  registerAccountTools(server as any);

  stubFetch(403, { error: 'manager_insufficient_role' });
  const list = JSON.parse((await get('dailey_accounts')({})).content[0].text);
  assert.equal(list.error_code, 'DAILEY_PERMISSION_DENIED');
  assert.equal(list.message, 'manager_insufficient_role');

  stubFetch(403, {});
  const use = JSON.parse((await get('dailey_use_account')({ account: 'acme' })).content[0].text);
  assert.equal(use.ok, false);
  assert.equal(use.message, PERMISSION_DENIED_FALLBACK);

  stubFetch(401, { error: 'Invalid or expired token' });
  const use401 = JSON.parse((await get('dailey_use_account')({ account: 'acme' })).content[0].text);
  assert.equal(use401.error_code, 'DAILEY_AUTH_REQUIRED');
});
