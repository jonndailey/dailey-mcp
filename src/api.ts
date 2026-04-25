const API_URL = process.env.DAILEY_API_URL || 'https://os.dailey.cloud/api';
const DAILEY_EMAIL = process.env.DAILEY_EMAIL;
const DAILEY_PASSWORD = process.env.DAILEY_PASSWORD;

let currentToken = process.env.DAILEY_API_TOKEN || '';

// Credential preflight lives in index.ts so it can distinguish TTY vs
// MCP-stdio invocation and emit a JSON-RPC-shaped error instead of just
// dying with a stderr line that Claude Code doesn't surface.
export function hasCredentials(): boolean {
  return Boolean(currentToken || DAILEY_EMAIL);
}

async function refreshToken(): Promise<string> {
  if (!DAILEY_EMAIL || !DAILEY_PASSWORD) {
    throw new Error('Cannot refresh token: DAILEY_EMAIL and DAILEY_PASSWORD not set');
  }
  const res = await fetch(`${API_URL}/customers/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: DAILEY_EMAIL, password: DAILEY_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json() as { access_token?: string };
  if (!data.access_token) {
    throw new Error('Token refresh: no access_token in response');
  }
  currentToken = data.access_token;
  return currentToken;
}

interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

export async function apiRequest<T = unknown>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<ApiResponse<T>> {
  const makeRequest = async (token: string): Promise<Response> => {
    const url = `${API_URL}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    const options: RequestInit = { method, headers };
    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }
    return fetch(url, options);
  };

  let res = await makeRequest(currentToken);

  // Auto-refresh on 401 if credentials are configured
  if (res.status === 401 && DAILEY_EMAIL) {
    try {
      await refreshToken();
      res = await makeRequest(currentToken);
    } catch {
      // refresh failed, return the original 401
    }
  }

  const text = await res.text();
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = text as unknown as T;
  }

  return { ok: res.ok, status: res.status, data };
}

export function formatError(res: ApiResponse): string {
  const data = res.data;
  let baseMessage: string;
  if (typeof data === 'object' && data !== null && 'error' in data) {
    baseMessage = `Error (${res.status}): ${(data as { error: string }).error}`;
  } else if (typeof data === 'object' && data !== null && 'message' in data) {
    baseMessage = `Error (${res.status}): ${(data as { message: string }).message}`;
  } else {
    baseMessage = `Error (${res.status}): ${JSON.stringify(data)}`;
  }
  const hint = remediationFor(res.status, data);
  return hint ? `${baseMessage}\n→ Remediation: ${hint}` : baseMessage;
}

/**
 * Remediation hints for common error patterns. Customer-feedback Scott Waters
 * platform-wishlist 2026-04-25, section 8: "MCP tool errors should include
 * remediation hints. The agent can show this verbatim to the user."
 *
 * Match order matters — most-specific first. Returns null when nothing maps.
 */
export function remediationFor(status: number, data: unknown): string | null {
  // Extract a searchable message regardless of the body shape.
  const messageParts: string[] = [];
  if (typeof data === 'string') messageParts.push(data);
  if (typeof data === 'object' && data !== null) {
    const d = data as Record<string, unknown>;
    if (typeof d.error === 'string') messageParts.push(d.error);
    if (typeof d.message === 'string') messageParts.push(d.message);
    if (typeof d.detail === 'string') messageParts.push(d.detail);
    if (typeof d.code === 'string') messageParts.push(d.code);
  }
  const haystack = messageParts.join(' ').toLowerCase();

  // ── Pattern-driven hints (more specific) — checked first so that an
  //    AWS-style "SignatureDoesNotMatch" carrying a 403 status maps to the
  //    storage-creds advice, not the generic "token expired" advice. ──
  if (haystack.includes('alreadyexists') && haystack.includes('registry')) {
    return 'Usually transient — retry `dailey_deploy`. The build worker also auto-retries this now.';
  }
  if (haystack.includes('alreadyexists') && (haystack.includes('push') || haystack.includes('blob'))) {
    return 'Usually transient — retry `dailey_deploy`. The build worker also auto-retries this now.';
  }
  if (haystack.includes('signaturedoesnotmatch')) {
    return 'Storage creds may be stale; run `dailey_storage_refresh` or wait for the 24h auto-refresh.';
  }
  if (haystack.includes('containercreating') && (haystack.includes('4 min') || haystack.includes('stuck'))) {
    return 'Image pull or PVC mount; check `dailey_app_logs`.';
  }
  if (haystack.includes('crashloopbackoff')) {
    return 'App is failing on startup; check `dailey_app_logs` for the error, then redeploy.';
  }
  if (haystack.includes('enotfound') || haystack.includes('econnrefused') || haystack.includes('etimedout')) {
    return 'Dailey API may be temporarily unreachable; retry in a minute.';
  }

  // ── Status-code-driven hints (generic fallback) ─────────────────────
  if (status === 423) {
    return 'Account locked. Wait the duration in the message; the platform now sends Retry-After.';
  }
  if (status === 429) {
    return 'Rate limited. Wait the duration; CLI/API auto-honor Retry-After.';
  }
  if (status === 401 || status === 403) {
    return 'Token expired or scope mismatch. Run `dailey login` (CLI) or refresh DAILEY_API_TOKEN.';
  }
  if (status === 502 || status === 503 || status === 504) {
    return 'Dailey API may be temporarily unreachable; retry in a minute.';
  }

  return null;
}

/**
 * Wrap a thrown error with remediation hints when possible. Used for fetch-
 * level failures (DNS, connection refused) that never reach formatError.
 */
export function formatThrownError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const hint = remediationFor(0, message);
  return hint ? `Error: ${message}\n→ Remediation: ${hint}` : `Error: ${message}`;
}

export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}
