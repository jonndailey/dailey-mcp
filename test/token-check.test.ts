import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTokenChecker, hashToken, TOKEN_CACHE_TTL_MS } from '../src/token-check.js';

// Fake customer-api. GET /api/customers/me answers by token so every verdict
// path of the hosted bearer gate (security review 2026-10-15, H3) runs offline.
const hits: Array<{ method: string; url: string; auth: string }> = [];
let capi: http.Server;
let apiUrl: string;

function reply(res: http.ServerResponse, status: number, body: string, type = 'application/json'): void {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

before(async () => {
  capi = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    hits.push({ method: req.method || '', url: req.url || '', auth });
    const tok = auth.replace(/^Bearer /, '');
    if (req.url !== '/api/customers/me') return reply(res, 404, '{"error":"not found"}');
    if (tok.startsWith('good')) return reply(res, 200, JSON.stringify({ id: 'cust_1', email: 'a@example.com' }));
    if (tok === 'forbidden') return reply(res, 403, '{"error":"Token audience not permitted for this service"}');
    if (tok === 'no-customer') return reply(res, 404, '{"error":"Customer not found"}');
    if (tok.startsWith('broken')) return reply(res, 502, '{"error":"bad gateway"}');
    if (tok === 'html') return reply(res, 200, '<!doctype html><title>SPA shell</title>', 'text/html');
    if (tok === 'slow') { setTimeout(() => reply(res, 200, '{"id":"cust_slow"}'), 300); return; }
    return reply(res, 401, '{"error":"Invalid or expired token"}');
  });
  await new Promise<void>((r) => capi.listen(0, '127.0.0.1', () => r()));
  apiUrl = `http://127.0.0.1:${(capi.address() as { port: number }).port}/api`;
});
after(() => { capi.closeAllConnections(); capi.close(); });

const hitsFor = (tok: string) => hits.filter((h) => h.auth === `Bearer ${tok}`).length;

test('default cache TTL is 60 s', () => {
  assert.equal(TOKEN_CACHE_TTL_MS, 60_000);
});

test('hashToken is the sha256 hex of the raw token (raw tokens are never stored)', () => {
  assert.equal(hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('a valid token is checked once with GET /customers/me, then served from cache', async () => {
  const c = createTokenChecker({ apiUrl });
  assert.equal(await c.check('good-1'), 'valid');
  assert.equal(await c.check('good-1'), 'valid');
  assert.equal(await c.check('good-1', hashToken('good-1')), 'valid');
  assert.equal(hitsFor('good-1'), 1, 'second and third checks must be cache hits');
  const h = hits.find((x) => x.auth === 'Bearer good-1')!;
  assert.equal(h.method, 'GET');
  assert.equal(h.url, '/api/customers/me');
});

test('a token the API rejects (401) is cached as invalid', async () => {
  const c = createTokenChecker({ apiUrl });
  assert.equal(await c.check('junk-1'), 'invalid');
  assert.equal(await c.check('junk-1'), 'invalid');
  assert.equal(hitsFor('junk-1'), 1);
});

test('403 (wrong audience) and 404 (no customer account) are invalid', async () => {
  const c = createTokenChecker({ apiUrl });
  assert.equal(await c.check('forbidden'), 'invalid');
  assert.equal(await c.check('no-customer'), 'invalid');
});

test('upstream errors are unavailable and never cached', async () => {
  const c = createTokenChecker({ apiUrl });
  assert.equal(await c.check('broken-1'), 'unavailable');
  assert.equal(await c.check('broken-1'), 'unavailable');
  assert.equal(hitsFor('broken-1'), 2, 'a 5xx must not be remembered');
});

test('a 200 that is not the customer JSON (misrouted API URL) is unavailable, never valid', async () => {
  const c = createTokenChecker({ apiUrl });
  assert.equal(await c.check('html'), 'unavailable');
});

test('an unreachable API is unavailable', async () => {
  const c = createTokenChecker({ apiUrl: 'http://127.0.0.1:1/api' });
  assert.equal(await c.check('good-unreachable'), 'unavailable');
});

test('a slow API times out as unavailable', async () => {
  const c = createTokenChecker({ apiUrl, timeoutMs: 50 });
  assert.equal(await c.check('slow'), 'unavailable');
});

test('cache entries expire after the TTL', async () => {
  const c = createTokenChecker({ apiUrl, ttlMs: 20 });
  assert.equal(await c.check('good-ttl'), 'valid');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(await c.check('good-ttl'), 'valid');
  assert.equal(hitsFor('good-ttl'), 2);
});

test('concurrent checks of one new token share a single upstream call', async () => {
  const c = createTokenChecker({ apiUrl });
  const verdicts = await Promise.all(Array.from({ length: 5 }, () => c.check('good-burst')));
  assert.deepEqual(verdicts, ['valid', 'valid', 'valid', 'valid', 'valid']);
  assert.equal(hitsFor('good-burst'), 1);
});

test('the cache-miss budget bounds upstream calls while cached tokens keep working', async () => {
  const c = createTokenChecker({ apiUrl, lookupLimit: 2 });
  assert.equal(await c.check('good-budget'), 'valid');
  assert.equal(await c.check('junk-budget-1'), 'invalid');
  // Budget spent: a third unseen token is refused without an upstream call.
  assert.equal(await c.check('junk-budget-2'), 'unavailable');
  assert.equal(hitsFor('junk-budget-2'), 0);
  // Already-validated tokens are unaffected by a flood of new junk ones.
  assert.equal(await c.check('good-budget'), 'valid');
  assert.equal(hitsFor('good-budget'), 1);
});

test('the cache is size-bounded', async () => {
  const c = createTokenChecker({ apiUrl, maxEntries: 2 });
  for (const t of ['good-m1', 'good-m2', 'good-m3', 'good-m4']) assert.equal(await c.check(t), 'valid');
  assert.ok(c.size() <= 2, `cache grew to ${c.size()}`);
});
