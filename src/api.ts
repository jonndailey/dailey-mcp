import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { OWN_VERSION } from './version.js';
import { requestContext } from './context.js';

const API_URL = process.env.DAILEY_API_URL || 'https://os.dailey.cloud/api';
const DAILEY_EMAIL = process.env.DAILEY_EMAIL;
const DAILEY_PASSWORD = process.env.DAILEY_PASSWORD;

// Read the token the Dailey CLI stores after `dailey auth login`. The CLI uses
// `conf` ({ projectName: 'dailey' }), which writes <config>/dailey-nodejs/config.json
// (env-paths layout). Reusing it means anyone already logged into the CLI (their
// `dailey whoami` works) gets a working MCP server with NO credentials in the
// client config — the installer's generated config only sets DAILEY_API_URL, so
// without this the server has no auth and exits, surfacing as "Connection closed".
function readCliStoredToken(): string | undefined {
  try {
    const name = 'dailey-nodejs';
    let dir: string;
    if (process.platform === 'darwin') {
      dir = join(homedir(), 'Library', 'Preferences', name);
    } else if (process.platform === 'win32') {
      dir = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), name, 'Config');
    } else {
      dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), name);
    }
    const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    const tok = typeof cfg?.token === 'string' ? cfg.token.trim() : '';
    return tok || undefined;
  } catch {
    return undefined;
  }
}

// An explicit env token (headless/CI) takes precedence and is fixed for the
// process lifetime. Otherwise the token is resolved DYNAMICALLY on every request
// (resolveToken below): the email/password refresh token if present, else the
// active CLI login — re-read from disk each call so a `dailey login` account
// switch is picked up live, without restarting the MCP server. This is what
// keeps multi-account users in sync (no token is baked into the client config).
const ENV_TOKEN = process.env.DAILEY_API_TOKEN || '';
let refreshedToken = '';

export function resolveToken(): string {
  const ctx = requestContext.getStore();
  if (ctx) return ctx.token;
  if (ENV_TOKEN) return ENV_TOKEN;
  if (refreshedToken) return refreshedToken;
  return readCliStoredToken() || '';
}

// Active managed-account context for the "manager / managed-accounts" capability.
// A manager (a Dailey account) can operate inside other accounts that granted
// them a consent-based grant by sending header `X-Dailey-Account: <slug|id>`;
// the server verifies a LIVE grant and scopes the request to that account (no
// re-login). This is SESSION-SCOPED: it persists for the MCP server process
// lifetime, which is what we want — an agent calls `dailey_use_account` once and
// every subsequent tool call operates within that account until it clears or
// switches. When unset, no header is sent (normal self-scoped behavior).
let activeAccount: string | undefined;

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

// Credential preflight lives in index.ts so it can distinguish TTY vs
// MCP-stdio invocation and emit a JSON-RPC-shaped error instead of just
// dying with a stderr line that Claude Code doesn't surface.
export function hasCredentials(): boolean {
  return Boolean(resolveToken() || DAILEY_EMAIL);
}

async function refreshToken(): Promise<string> {
  if (!DAILEY_EMAIL || !DAILEY_PASSWORD) {
    throw new Error('Cannot refresh token: DAILEY_EMAIL and DAILEY_PASSWORD not set');
  }
  const res = await fetch(`${API_URL}/customers/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dailey-Source': 'mcp' },
    body: JSON.stringify({ email: DAILEY_EMAIL, password: DAILEY_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json() as { access_token?: string };
  if (!data.access_token) {
    throw new Error('Token refresh: no access_token in response');
  }
  refreshedToken = data.access_token;
  return refreshedToken;
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
      // Identify MCP-originated traffic so the platform can record a customer's
      // first successful MCP connection (onboarding progress).
      'X-Dailey-Source': 'mcp',
      // Version fingerprint (2026-07-13 stale-client incident): lets the
      // platform see which MCP versions are live in the field. A request with
      // X-Dailey-Source: mcp but NO version header is a pre-1.20.7 client.
      'X-Dailey-Client-Version': OWN_VERSION,
    };
    // Manager / managed-accounts: when an active account is set, scope every
    // request to it. The server verifies a live consent grant; absent header =
    // normal self-scoped behavior.
    const acct = getActiveAccount();
    if (acct) headers['X-Dailey-Account'] = acct;
    const options: RequestInit = { method, headers };
    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }
    return fetch(url, options);
  };

  let res = await makeRequest(resolveToken());

  // Auto-refresh on 401 if credentials are configured
  if (res.status === 401 && DAILEY_EMAIL) {
    try {
      await refreshToken();
      res = await makeRequest(resolveToken());
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
  // 401/403 always returns a structured auth error object as JSON text so MCP
  // clients (and agents reading tool output) get a machine-readable signal with
  // a clear remediation path rather than a generic "Error (401): ..." string.
  if (res.status === 401 || res.status === 403) {
    return JSON.stringify({
      error_code: 'DAILEY_AUTH_REQUIRED',
      message: 'Not authenticated',
      remediation: 'Run `dailey auth setup` in your terminal',
      help_url: 'https://docs.dailey.cloud/auth',
    }, null, 2);
  }

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

// Project IDs are UUID-shaped (hex characters + hyphens) everywhere the platform
// issues them — the same "looks like an ID" gate diagnose.ts already used to
// decide whether to try an ID lookup before falling back to slug/name. Several
// tools interpolate `project_id` straight into a URL path template
// (`/projects/${project_id}/...`) with no encodeURIComponent — an unvalidated
// value containing `../` segments gets collapsed by the WHATWG URL parser
// fetch() uses internally, letting the request escape the intended
// `/api/projects/:id/...` prefix entirely (verified: `../../admin/x` turns
// `https://os.dailey.cloud/api/projects/../../admin/x/database` into
// `https://os.dailey.cloud/admin/x/database`). Validating here, before any
// apiRequest call, closes that off. [dailey-mcp:3]
const PROJECT_ID_PATTERN = /^[0-9a-f-]{8,}$/i;

export function isValidProjectId(id: string): boolean {
  return PROJECT_ID_PATTERN.test(id);
}

export function invalidProjectIdResult(id: string) {
  return textResult(
    `Error: "${id}" is not a valid project ID. Expected a UUID-shaped id (hex characters and hyphens, 8+ chars). If you have a slug or name instead of an ID, resolve it first (e.g. via dailey_list_projects or dailey_diagnose, which accept either).`,
  );
}

export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}
