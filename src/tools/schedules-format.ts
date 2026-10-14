// src/tools/schedules-format.ts
// Dailey Schedules: pure formatting and input checks shared by every dailey_schedules_* tool.
// No network, no imports from api.ts, so it is unit tested directly.
// Copy rules: product name "Dailey Schedules", plain words, no em dashes.

export const NOT_AVAILABLE = 'Dailey Schedules is not available on your account yet.';
export const TURN_ON_FIRST = 'Dailey Schedules is off for this project. Turn it on first with dailey_schedules_enable.';
const NOT_FOUND = 'We could not find that project or schedule in this account. Check the id with dailey_schedules_list.';
const NOT_FOUND_HOST = 'We could not find that address for this project. Check it with dailey_schedules_list.';
const NOT_FOUND_ITEM = 'We could not find that one-time visit.';
const NOT_FOUND_RUN = 'We could not find that run.';
const NOT_FOUND_CREDENTIAL = 'We could not find that credential.';
const HOST_HELP = 'Give just the host name, like api.example.com.';

export type ApiRes = { ok: boolean; status: number; data: unknown };

export type Schedule = {
  id: string; name: string; source: 'repo' | 'platform' | 'app'; kind: string; cron: string; every_text: string | null; timezone: string | null;
  enabled: number | boolean; paused_reason: string | null; pending_confirmation: number | boolean; next_run_at: string | null; last_run_at: string | null;
  last_status: string | null; consecutive_failures: number; method: string; query_keys: string[]; body_bytes: number;
  credential?: string; path?: string; display_url?: string;
};

export type Run = {
  id: string; schedule_id: string | null; item_id: string | null; run_trigger: 'cron' | 'manual' | 'item'; scheduled_for: string;
  started_at: string | null; finished_at: string | null; status: string; attempt: number; reason: string | null; reason_message: string | null;
  http_status: number | null; duration_ms: number | null; error: string | null; preview?: string | null;
};

export function schedulesToolsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DAILEY_SCHEDULES_TOOLS === '1';
}

function serverMessage(data: unknown): string {
  if (data && typeof data === 'object' && typeof (data as any).error === 'string') return (data as any).error;
  return '';
}

export function schedulesErrorText(res: ApiRes, subject: 'schedule' | 'host' | 'item' | 'run' | 'credential' = 'schedule'): string {
  const d: any = res.data;
  if (res.status === 404 && d && typeof d === 'object' && d.code === 'route_not_found') return NOT_AVAILABLE;
  if (res.status === 401) return 'You are not signed in to Dailey Cloud here. Run `dailey login`, then `dailey mcp setup`, and reconnect.';
  if (res.status === 403) {
    const code = serverMessage(d);
    if (code === 'no_manager_grant' || code === 'manager_insufficient_role') return "You do not have access to manage that account's projects.";
    return 'Dailey Schedules could not do that (no access).';
  }
  if (res.status === 404) return subject === 'host' ? NOT_FOUND_HOST : subject === 'item' ? NOT_FOUND_ITEM : subject === 'run' ? NOT_FOUND_RUN : subject === 'credential' ? NOT_FOUND_CREDENTIAL : NOT_FOUND;
  if (res.status === 409) return TURN_ON_FIRST;
  if (res.status >= 502 && res.status <= 504) return 'Dailey Cloud did not answer. Try again in a minute.';
  const msg = serverMessage(d);
  if (res.status === 400 || res.status === 429) return msg || 'Dailey Schedules could not do that.';
  return msg || `Dailey Schedules could not do that (HTTP ${res.status}).`;
}

const PAUSED: Record<string, string> = {
  paused_by_user: 'Paused',
  plan_limit: 'Paused: your plan does not cover this schedule right now',
  failing: 'Paused after 10 failures in a row',
  disabled: 'Off because Dailey Schedules is turned off for this project',
};

export function describeSchedule(s: Schedule): string {
  const every = s.every_text ? s.every_text.replace(/^\s*every\s+/i, '') : '';
  const when = every ? `every ${every}` : `cron ${s.cron}`;
  const tz = s.timezone ? ` (${s.timezone})` : '';
  const target = s.display_url ? s.display_url : (s.path || '');
  const flags: string[] = [];
  if (s.source === 'repo') flags.push('From your code (dailey.yaml)');
  if (s.source === 'app') flags.push('Created by your app');
  if (Number(s.pending_confirmation) === 1) flags.push('Waiting for you to confirm this address');
  if (Number(s.enabled) !== 1 && s.paused_reason) flags.push(PAUSED[s.paused_reason] || 'Paused');
  if (s.credential) flags.push(`credential ${s.credential}`);
  const next = Number(s.enabled) === 1 && s.next_run_at ? ` next ${s.next_run_at}` : '';
  const last = s.last_status ? ` last ${s.last_status}` : '';
  return `${s.name}  ${when}${tz}  ${s.method || 'GET'} ${target}${next}${last}  id ${s.id}${flags.length ? `\n    ${flags.join(' · ')}` : ''}`;
}

export function describeRun(r: Run): string {
  const trig = r.run_trigger === 'manual' ? ' (run now)' : r.run_trigger === 'item' ? ' (one-time)' : '';
  const http = r.http_status ? ` HTTP ${r.http_status}` : '';
  const dur = r.duration_ms != null ? ` ${r.duration_ms} ms` : '';
  const why = r.reason_message ? `  ${r.reason_message}` : '';
  return `${r.scheduled_for}  ${r.status}${trig}${http}${dur} attempt ${r.attempt}${why}  run ${r.id}`;
}

export function nextRunsText(nextRuns: string[], timezone?: string): string {
  if (!nextRuns?.length) return 'No upcoming runs.';
  return [`Next runs${timezone ? ` (${timezone})` : ''}:`, ...nextRuns.map(d => `  ${d}`)].join('\n');
}

export function signingSecretBlock(host: string, secret: string, where: 'mcp' | 'cli'): string {
  if (!secret) throw new Error('signingSecretBlock needs a secret (confirm returns null when the address was already confirmed)');
  const lines = [
    `Signing secret for ${host} (shown once):`,
    '',
    `  ${secret}`,
    '',
    'Save it now. Dailey Schedules will not show it again.',
    `Give it to the service at ${host} so it can check that calls really come from Dailey Schedules.`,
    'Lost it? Rotate it and save the new one.',
  ];
  if (where === 'mcp') lines.push('This secret is now in this conversation. If that is not OK for you, rotate it from the Schedules tab in the dashboard and copy it there.');
  return lines.join('\n');
}

export function isSafeId(id: string): boolean {
  return /^[0-9a-f-]{8,}$/i.test(String(id || '')) && !/^\.+$/.test(String(id));
}

const DEDUPE_HELP = 'The dedupe key can use letters, numbers and . _ : - (up to 120), and cannot look like an id.';
const NAME_HELP = 'Use a name with lowercase letters, numbers and dashes.';

// Item key sent in a URL path: same rule as the server; dot-only keys would be dot-segments.
export function checkDedupeKey(key: string): string | null {
  const k = String(key ?? '');
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(k) || /^\.+$/.test(k) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return DEDUPE_HELP;
  return null;
}

// Credential name: same rule as the server (NAME_RE), so it is also a safe path segment.
export function checkName(name: string): string | null {
  const n = String(name ?? '');
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(n)) return NAME_HELP;
  return null;
}

// Callers must encodeURIComponent the host before putting it in a path.
// Lenient for confirm and rotate (server normalises case, port and trailing dot); strict for credentials add (server refuses ':').
export function checkHostInput(host: string, strict = false): string | null {
  const h = String(host || '').trim();
  if (!h || /^\.+$/.test(h) || (strict ? /[/:@?#\s]/ : /[/@?#\s]/).test(h)) return HOST_HELP;
  return null;
}

export const SCHEDULES_GUIDE = `

### Dailey Schedules (work on a timer)
- Runs work on a schedule ("every weekday at 9am", or cron) or once at a set time, by visiting a path in the app
  or an outside https address. Turn on per project with dailey_schedules_enable (dailey_schedules_disable turns it
  off); the app gets DAILEY_SCHEDULES_SECRET, DAILEY_SCHEDULES_API_URL and DAILEY_SCHEDULES_KEY and restarts.
- Tools: dailey_schedules_enable, _disable, _list, _preview, _create, _update, _delete, _pause, _resume, _run_now,
  _history, _item_add, _item_cancel, _credential_add, _credential_remove, _host_confirm, _host_rotate_secret,
  _rotate_secret, _rotate_key, _test_endpoint.
- Plans: Free 3 schedules, at most hourly, 7 days history. Studio 25, every minute, 30 days. Managed 50, 90 days.
- Every visit to the app is signed. The app MUST check it and answer 401 when it fails:
  headers Dailey-Schedules-Timestamp, Dailey-Schedules-Run-Id, Dailey-Schedules-Attempt, Dailey-Schedules-Signature
  (v1=<hex>, comma separated during a rotation), Dailey-Schedules-Last-Success (may be absent).
  Signed text = these lines joined with a newline: timestamp, METHOD, host, path with query, run id, attempt,
  last success (empty if none), sha256 hex of the raw body. host is <slug>.internal for visits to the app.
  Signature = HMAC-SHA256 with DAILEY_SCHEDULES_SECRET, hex. Accept if any v1= entry matches (constant-time compare),
  the timestamp is within 300 seconds, and the run id was not seen before (keep ids at least 600 seconds,
  store one only after the work commits). After a good check, add the response header Dailey-Schedules-Verified: v1
  so the dashboard can show the check is working once Dailey Schedules reports it.
- Visits arrive with Host set to the project slug. Apps with a host allow-list (Rails config.hosts, Django
  ALLOWED_HOSTS, Vite server.allowedHosts) must allow the slug.
- A new outside host waits for the owner's confirmation (dailey_schedules_host_confirm), which shows that host's
  signing secret once. Credentials for outside hosts are saved with dailey_schedules_credential_add, never in code.
- dailey_schedules_test_endpoint sends one request with a wrong signature to check the app refuses it. Ask first.`;
