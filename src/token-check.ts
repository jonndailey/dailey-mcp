import { createHash } from 'node:crypto';
import { API_URL } from './api.js';
import { OWN_VERSION } from './version.js';

// Bearer gate for the hosted (HTTP) entry. Security review 2026-10-15, H3
// (10-14 M3): the server used to accept any `Bearer <string>` for initialize and
// tools/list, and charged junk tokens to the server-wide rate window, so an
// anonymous client rotating random tokens could lock every real user out with
// 429s. Every token is now checked once against the customer-api identity call
// the tools themselves use (GET /customers/me) and the verdict is cached for
// 60 s, keyed by sha256(token). Raw tokens are never stored.
//
// The cache only decides who may talk to this server. Every tool call still
// sends the token to the customer-api, which remains the sole authorizer, so a
// token revoked inside the TTL still fails on its first real call.

export type TokenVerdict = 'valid' | 'invalid' | 'unavailable';

export const TOKEN_CACHE_TTL_MS = 60_000;
// Upstream checks (cache misses) per minute, whole process. Validated tokens are
// cached, so this budget is "new tokens per minute"; it bounds what a flood of
// random tokens can cost the customer-api now that each unseen token costs a call.
const LOOKUP_LIMIT = 300;
const CACHE_MAX_ENTRIES = 10_000;
const LOOKUP_TIMEOUT_MS = 5_000;

export interface TokenCheckerOptions {
  apiUrl?: string;
  ttlMs?: number;
  lookupLimit?: number;
  maxEntries?: number;
  timeoutMs?: number;
}

export interface TokenChecker {
  check(token: string, tokenHash?: string): Promise<TokenVerdict>;
  size(): number;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createTokenChecker(opts: TokenCheckerOptions = {}): TokenChecker {
  const apiUrl = opts.apiUrl ?? API_URL;
  const ttlMs = opts.ttlMs ?? TOKEN_CACHE_TTL_MS;
  const lookupLimit = opts.lookupLimit ?? LOOKUP_LIMIT;
  const maxEntries = Math.max(1, opts.maxEntries ?? CACHE_MAX_ENTRIES);
  const timeoutMs = opts.timeoutMs ?? LOOKUP_TIMEOUT_MS;

  const cache = new Map<string, { valid: boolean; expires: number }>();
  const pending = new Map<string, Promise<TokenVerdict>>();
  let lookups = { count: 0, windowStart: Date.now() };

  function remember(tokenHash: string, valid: boolean): void {
    const now = Date.now();
    if (cache.size >= maxEntries) {
      for (const [k, e] of cache) if (e.expires <= now) cache.delete(k);
      // Still full: Map iterates in insertion order, so evict the oldest.
      while (cache.size > 0 && cache.size >= maxEntries) cache.delete(cache.keys().next().value as string);
    }
    cache.set(tokenHash, { valid, expires: now + ttlMs });
  }

  // 2xx with the customer JSON = valid. 401/403/404 are definitive answers about
  // the token (bad or expired, wrong audience, no customer account) = invalid.
  // Anything else (5xx, 429, timeout, a 200 that is not customer JSON because the
  // API URL is misrouted to an HTML page) = unavailable: fail closed, cache nothing.
  async function lookup(token: string): Promise<TokenVerdict> {
    try {
      const res = await fetch(`${apiUrl}/customers/me`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          // Same tags as apiRequest(): this is MCP traffic for this customer.
          'X-Dailey-Source': 'mcp',
          'X-Dailey-Client-Version': OWN_VERSION,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        await res.body?.cancel();
        return 'invalid';
      }
      if (!res.ok) {
        await res.body?.cancel();
        console.warn(`[token-check] customer-api /customers/me answered ${res.status}`);
        return 'unavailable';
      }
      const body = await res.json().catch(() => null) as { id?: unknown } | null;
      const id = body && typeof body === 'object' ? body.id : undefined;
      if ((typeof id === 'string' && id) || typeof id === 'number') return 'valid';
      console.warn('[token-check] customer-api /customers/me answered 2xx without a customer id');
      return 'unavailable';
    } catch (err) {
      console.warn(`[token-check] customer-api unreachable: ${(err as Error).name}`);
      return 'unavailable';
    }
  }

  return {
    async check(token: string, tokenHash: string = hashToken(token)): Promise<TokenVerdict> {
      const now = Date.now();
      const hit = cache.get(tokenHash);
      if (hit && hit.expires > now) return hit.valid ? 'valid' : 'invalid';
      if (hit) cache.delete(tokenHash);
      const inFlight = pending.get(tokenHash);
      if (inFlight) return inFlight;
      if (now - lookups.windowStart >= 60_000) lookups = { count: 0, windowStart: now };
      if (++lookups.count > lookupLimit) return 'unavailable';
      const p = lookup(token)
        .then((verdict) => {
          if (verdict !== 'unavailable') remember(tokenHash, verdict === 'valid');
          return verdict;
        })
        .finally(() => pending.delete(tokenHash));
      pending.set(tokenHash, p);
      return p;
    },
    size(): number {
      return cache.size;
    },
  };
}
