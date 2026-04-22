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
  if (typeof data === 'object' && data !== null && 'error' in data) {
    return `Error (${res.status}): ${(data as { error: string }).error}`;
  }
  if (typeof data === 'object' && data !== null && 'message' in data) {
    return `Error (${res.status}): ${(data as { message: string }).message}`;
  }
  return `Error (${res.status}): ${JSON.stringify(data)}`;
}

export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}
