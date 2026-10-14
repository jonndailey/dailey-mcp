import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type Call = { method: string; path: string; body?: any };
const calls: Call[] = [];
let reply: (c: Call) => { ok: boolean; status: number; data: any } = () => ({ ok: true, status: 200, data: {} });
const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });

mock.module('../src/api.js', { namedExports: {
  apiRequest: async (method: string, path: string, body?: any) => { const c = { method, path, body }; calls.push(c); return reply(c); },
  textResult,
  jsonResult: (d: unknown) => textResult(JSON.stringify(d, null, 2)),
  formatError: (res: any) => `Error (${res.status})`,
  isValidProjectId: (id: string) => /^[0-9a-f-]{8,}$/i.test(id),
  invalidProjectIdResult: (id: string) => textResult(`invalid project id: ${id}`),
} });
const { registerSchedulesTools } = await import('../src/tools/schedules.js');

function makeFakeServer() {
  const handlers = new Map<string, (args: any) => Promise<{ content: Array<{ type: 'text'; text: string }> }>>();
  const descriptions = new Map<string, string>();
  const server = { tool: (name: string, desc: string, _schema: unknown, h: any) => { handlers.set(name, h); descriptions.set(name, desc); } };
  return { server, handlers, descriptions, run: async (name: string, args: any) => (await handlers.get(name)!(args)).content[0].text };
}

const PID = 'c0c0eaaf-25a4-11f1-9bf3-fa163e580ccd';
const SID = '3f2b8c1e-5a4d-4e6f-9a1b-0c2d3e4f5a6b';
let fake: ReturnType<typeof makeFakeServer>;

beforeEach(() => {
  calls.length = 0;
  reply = () => ({ ok: true, status: 200, data: {} });
  fake = makeFakeServer();
  registerSchedulesTools(fake.server as any);
});

test('list: off project explains how to turn on', async () => {
  reply = () => ({ ok: true, status: 200, data: { enabled: false, schedules: [], hosts: [], credentials: [], signature_seen: false } });
  const text = await fake.run('dailey_schedules_list', { project_id: PID });
  assert.deepEqual(calls[0], { method: 'GET', path: `/projects/${PID}/schedules`, body: undefined });
  assert.match(text, /Dailey Schedules is off for this project/);
  assert.match(text, /dailey_schedules_enable/);
});

test('list: schedules, pending hosts, credentials without values, signature status', async () => {
  reply = () => ({ ok: true, status: 200, data: {
    enabled: true, signature_seen: false,
    schedules: [{ id: SID, name: 'send-reminders', source: 'platform', kind: 'visit', cron: '0 18 * * *', every_text: 'every day at 6pm', timezone: 'UTC', enabled: 1, paused_reason: null, pending_confirmation: 0, next_run_at: '2026-10-15T18:00:00.000Z', last_run_at: null, last_status: null, consecutive_failures: 0, method: 'POST', query_keys: [], body_bytes: 0, path: '/api/tasks/send-reminders' }],
    hosts: [{ host: 'api.example.com', confirmed: false, confirmed_at: null }],
    credentials: [{ id: 'c1', name: 'partner-api', host: 'api.example.com', kind: 'header', param_name: 'X-Api-Key', created_at: '2026-10-14', value: 'TOPSECRET' }],
  } });
  const text = await fake.run('dailey_schedules_list', { project_id: PID });
  assert.match(text, /send-reminders/);
  assert.match(text, /every day at 6pm/);
  assert.doesNotMatch(text, /every every/);
  assert.match(text, /api\.example\.com: waiting for your confirmation/);
  assert.match(text, /dailey_schedules_host_confirm/);
  assert.match(text, /partner-api: header X-Api-Key for api\.example\.com/);
  assert.doesNotMatch(text, /TOPSECRET/);
  assert.match(text, /not seen your app confirm a signature check yet/);
});

test('list: confirmed signature is reported', async () => {
  reply = () => ({ ok: true, status: 200, data: { enabled: true, schedules: [], hosts: [], credentials: [], signature_seen: true } });
  assert.match(await fake.run('dailey_schedules_list', { project_id: PID }), /has confirmed it checks/);
});

test('route_not_found becomes not available', async () => {
  reply = () => ({ ok: false, status: 404, data: { error: 'Not found', code: 'route_not_found' } });
  assert.equal(await fake.run('dailey_schedules_list', { project_id: PID }), 'Dailey Schedules is not available on your account yet.');
});

test('bad ids never reach the API', async () => {
  assert.match(await fake.run('dailey_schedules_list', { project_id: '../../admin' }), /invalid project id/);
  assert.match(await fake.run('dailey_schedules_history', { project_id: PID, schedule_id: '../x' }), /not a valid schedule id/);
  assert.match(await fake.run('dailey_schedules_history', { project_id: PID, run_id: 'a%2Fb' }), /not a valid run id/);
  assert.match(await fake.run('dailey_schedules_history', { project_id: PID, run_id: '........' }), /not a valid run id/);
  assert.equal(calls.length, 0);
});

test('preview posts every/cron/timezone and lists next runs', async () => {
  reply = () => ({ ok: true, status: 200, data: { cron: '0 9 * * 1-5', timezone: 'America/New_York', next_runs: ['2026-10-15T13:00:00.000Z'] } });
  const text = await fake.run('dailey_schedules_preview', { project_id: PID, every: 'weekday at 9am', timezone: 'America/New_York' });
  assert.deepEqual(calls[0], { method: 'POST', path: `/projects/${PID}/schedules/preview`, body: { every: 'weekday at 9am', timezone: 'America/New_York' } });
  assert.match(text, /cron 0 9 \* \* 1-5/);
  assert.match(text, /2026-10-15T13:00:00\.000Z/);
});

test('preview 400 shows the server sentence', async () => {
  const s = 'I could not understand "x". Try something like "day at 6pm" or "hour".';
  reply = () => ({ ok: false, status: 400, data: { error: s } });
  assert.equal(await fake.run('dailey_schedules_preview', { project_id: PID, every: 'x' }), s);
});

test('history: list with schedule filter and limit, reasons, no preview', async () => {
  reply = () => ({ ok: true, status: 200, data: [{ id: 'r1', schedule_id: SID, item_id: null, run_trigger: 'cron', scheduled_for: '2026-10-14T18:00:00.000Z', started_at: null, finished_at: null, status: 'failed', attempt: 1, reason: 'not_running', reason_message: 'Your app is not running right now.', http_status: null, duration_ms: 0, error: null, preview: 'HIDDEN' }] });
  const text = await fake.run('dailey_schedules_history', { project_id: PID, schedule_id: SID, limit: 10 });
  assert.equal(calls[0].path, `/projects/${PID}/schedules/runs?schedule_id=${SID}&limit=10`);
  assert.match(text, /Your app is not running right now\./);
  assert.doesNotMatch(text, /HIDDEN/);
});

test('history: empty list', async () => {
  reply = () => ({ ok: true, status: 200, data: [] });
  assert.equal(await fake.run('dailey_schedules_history', { project_id: PID }), 'No runs yet.');
  assert.equal(calls[0].path, `/projects/${PID}/schedules/runs`);
});

test('history: one run shows the redacted preview', async () => {
  reply = () => ({ ok: true, status: 200, data: { id: 'r1', schedule_id: SID, item_id: null, run_trigger: 'manual', scheduled_for: 'x', started_at: null, finished_at: null, status: 'succeeded', attempt: 1, reason: null, reason_message: null, http_status: 200, duration_ms: 40, error: null, preview: '{"sent":3}' } });
  const text = await fake.run('dailey_schedules_history', { project_id: PID, run_id: SID });
  assert.equal(calls[0].path, `/projects/${PID}/schedules/runs/${SID}`);
  assert.match(text, /Response preview \(first 2 KB, secrets removed\):\n\{"sent":3\}/);
});

test('descriptions use the product name and no em dashes', () => {
  assert.equal(fake.descriptions.size, 20);
  for (const [name, d] of fake.descriptions) {
    assert.match(d, /Dailey Schedules/, name);
    assert.doesNotMatch(d, /—/, name);
    assert.doesNotMatch(d, /Dailey OS/, name);
  }
});

test('enable: says what the app gets, never prints the app key', async () => {
  reply = () => ({ ok: true, status: 200, data: { enabled: true, api_url: 'https://os-stg.dailey.cloud/api/schedules/v1', key: 'dsk_SECRET_ONCE' } });
  const text = await fake.run('dailey_schedules_enable', { project_id: PID });
  assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].path, `/projects/${PID}/schedules/enable`);
  assert.doesNotMatch(text, /dsk_SECRET_ONCE/);
  for (const v of ['DAILEY_SCHEDULES_SECRET', 'DAILEY_SCHEDULES_API_URL', 'DAILEY_SCHEDULES_KEY']) assert.match(text, new RegExp(v));
  assert.match(text, /restart/i);
});

test('enable twice: server sentence', async () => {
  reply = () => ({ ok: false, status: 400, data: { error: 'Dailey Schedules is already on for this project.' } });
  assert.equal(await fake.run('dailey_schedules_enable', { project_id: PID }), 'Dailey Schedules is already on for this project.');
});

test('disable needs confirm: true and says what stops and how to resume', async () => {
  assert.match(await fake.run('dailey_schedules_disable', { project_id: PID }), /confirm: true/);
  assert.equal(calls.length, 0);
  reply = () => ({ ok: true, status: 200, data: { enabled: false } });
  const text = await fake.run('dailey_schedules_disable', { project_id: PID, confirm: true });
  assert.equal(calls[0].path, `/projects/${PID}/schedules/disable`);
  assert.match(text, /turned off/);
  assert.match(text, /dailey_schedules_resume/);
});

test('create: own-app path, sends only given fields, shows next runs', async () => {
  reply = () => ({ ok: true, status: 201, data: { id: SID, next_runs: ['2026-10-15T22:00:00.000Z'], pending_confirmation: false } });
  const text = await fake.run('dailey_schedules_create', { project_id: PID, name: 'send-reminders', every: 'day at 6pm', timezone: 'America/New_York', visit: { path: '/api/tasks/send-reminders', method: 'POST' } });
  assert.deepEqual(calls[0], { method: 'POST', path: `/projects/${PID}/schedules`, body: { name: 'send-reminders', every: 'day at 6pm', timezone: 'America/New_York', visit: { path: '/api/tasks/send-reminders', method: 'POST' } } });
  assert.match(text, /Created send-reminders/);
  assert.match(text, new RegExp(SID));
  assert.match(text, /2026-10-15T22:00:00\.000Z/);
  assert.match(text, /verify/i);
});

test('create: new external host is pending and explains confirmation', async () => {
  reply = () => ({ ok: true, status: 201, data: { id: SID, next_runs: [], pending_confirmation: true } });
  const text = await fake.run('dailey_schedules_create', { project_id: PID, name: 'ping-partner', every: 'hour', visit: { url: 'https://api.example.com/hook' } });
  assert.match(text, /will not run until you confirm/);
  assert.match(text, /dailey_schedules_host_confirm/);
  assert.match(text, /api\.example\.com/);
});

test('create: both or neither of path and url is refused locally', async () => {
  assert.match(await fake.run('dailey_schedules_create', { project_id: PID, name: 'x', every: 'hour', visit: {} }), /path in your app or a url/);
  assert.match(await fake.run('dailey_schedules_create', { project_id: PID, name: 'x', every: 'hour', visit: { path: '/a', url: 'https://b.com' } }), /either a path or a url, not both/);
  assert.equal(calls.length, 0);
});

test('update, delete, pause, resume, run now hit the right routes', async () => {
  reply = (c) => ({ ok: true, status: c.path.endsWith('run-now') ? 202 : 200, data: c.path.endsWith('run-now') ? { run_id: 'r9' } : { id: SID, next_runs: ['2026-10-16T00:00:00.000Z'], deleted: true, paused: true } });
  await fake.run('dailey_schedules_update', { project_id: PID, schedule_id: SID, cron: '0 0 * * *' });
  assert.deepEqual(calls.at(-1), { method: 'PATCH', path: `/projects/${PID}/schedules/${SID}`, body: { cron: '0 0 * * *' } });
  assert.match(await fake.run('dailey_schedules_delete', { project_id: PID, schedule_id: SID }), /confirm: true/);
  await fake.run('dailey_schedules_delete', { project_id: PID, schedule_id: SID, confirm: true });
  assert.deepEqual(calls.at(-1), { method: 'DELETE', path: `/projects/${PID}/schedules/${SID}`, body: undefined });
  await fake.run('dailey_schedules_pause', { project_id: PID, schedule_id: SID });
  assert.equal(calls.at(-1)!.path, `/projects/${PID}/schedules/${SID}/pause`);
  await fake.run('dailey_schedules_resume', { project_id: PID, schedule_id: SID });
  assert.equal(calls.at(-1)!.path, `/projects/${PID}/schedules/${SID}/resume`);
  const t = await fake.run('dailey_schedules_run_now', { project_id: PID, schedule_id: SID });
  assert.equal(calls.at(-1)!.path, `/projects/${PID}/schedules/${SID}/run-now`);
  assert.match(t, /r9/); assert.match(t, /dailey_schedules_history/);
});

test('write tools refuse bad schedule ids before any request', async () => {
  for (const t of ['update', 'delete', 'pause', 'resume', 'run_now']) {
    for (const id of ['..', 'a%2Fb', '../x']) {
      assert.match(await fake.run(`dailey_schedules_${t}`, { project_id: PID, schedule_id: id, confirm: true }), /not a valid schedule id/);
    }
  }
  assert.equal(calls.length, 0);
});

test('repo schedule edit refusal and resume plan refusal pass through', async () => {
  reply = () => ({ ok: false, status: 400, data: { error: 'This schedule comes from your code (dailey.yaml). Change it there and deploy.' } });
  assert.match(await fake.run('dailey_schedules_update', { project_id: PID, schedule_id: SID, every: 'hour' }), /dailey\.yaml/);
  reply = () => ({ ok: false, status: 400, data: { error: 'Your plan includes 3 schedules, and this project\'s account is using all of them.' } });
  assert.match(await fake.run('dailey_schedules_resume', { project_id: PID, schedule_id: SID }), /includes 3 schedules/);
});

test('409 off and run-now limit messages', async () => {
  reply = () => ({ ok: false, status: 409, data: { error: 'Turn on Dailey Schedules for this project first.' } });
  assert.match(await fake.run('dailey_schedules_run_now', { project_id: PID, schedule_id: SID }), /dailey_schedules_enable/);
  reply = () => ({ ok: false, status: 400, data: { error: 'You have used all the manual runs for now. Try again later.' } });
  assert.equal(await fake.run('dailey_schedules_run_now', { project_id: PID, schedule_id: SID }), 'You have used all the manual runs for now. Try again later.');
});

test('disable description says schedules stay paused and must be resumed', () => {
  const d = fake.descriptions.get('dailey_schedules_disable')!;
  assert.match(d, /stay paused/); assert.match(d, /dailey_schedules_resume/);
});

test('update sends every, timezone and visit via onlyDefined; pause and resume say so', async () => {
  reply = () => ({ ok: true, status: 200, data: { id: SID, next_runs: ['2026-10-16T00:00:00.000Z'], paused: true } });
  await fake.run('dailey_schedules_update', { project_id: PID, schedule_id: SID, every: 'hour', timezone: 'America/Chicago', visit: { path: '/api/x', method: undefined } });
  assert.deepEqual(calls.at(-1)!.body, { every: 'hour', timezone: 'America/Chicago', visit: { path: '/api/x' } });
  assert.match(await fake.run('dailey_schedules_pause', { project_id: PID, schedule_id: SID }), /^Paused\. Resume with dailey_schedules_resume/);
  assert.match(await fake.run('dailey_schedules_resume', { project_id: PID, schedule_id: SID }), /^Resumed\./);
});

test('item add and cancel (by id or dedupe key, encoded)', async () => {
  reply = () => ({ ok: true, status: 201, data: { id: 'i1', run_at: '2026-10-19T21:00:00.000Z', delayed: true, pending_confirmation: false } });
  const dedupe_key = ['appt', '42', 'remind'].join('-'); // built at runtime to keep scanners quiet
  const t = await fake.run('dailey_schedules_item_add', { project_id: PID, at: '2026-10-19T17:00', timezone: 'America/New_York', visit: { path: '/api/remind' }, dedupe_key });
  assert.deepEqual(calls[0].body, { at: '2026-10-19T17:00', timezone: 'America/New_York', visit: { path: '/api/remind' }, dedupe_key });
  assert.match(t, /2026-10-19T21:00:00\.000Z/);
  assert.match(t, /moved to the next free slot/);
  const n = calls.length;
  assert.match(await fake.run('dailey_schedules_item_add', { project_id: PID, at: 'x', visit: { path: '/a' }, dedupe_key: 'appt 42/remind' }), /dedupe key/);
  assert.match(await fake.run('dailey_schedules_item_add', { project_id: PID, at: 'x', visit: {} }), /path in your app or a url/);
  assert.equal(calls.length, n);
  reply = () => ({ ok: true, status: 200, data: { cancelled: true } });
  const dc = fake.descriptions.get('dailey_schedules_item_cancel')!;
  assert.match(dc, /cannot be undone/); assert.match(dc, /dedupe_key.*cannot be (used|reused)|cannot be reused/s); assert.match(dc, /confirm: true/);
  const k = calls.length;
  assert.match(await fake.run('dailey_schedules_item_cancel', { project_id: PID, item: 'appt-42-remind' }), /confirm: true/);
  assert.equal(calls.length, k);
  reply = () => ({ ok: false, status: 404, data: { error: 'Not found.' } });
  assert.equal(await fake.run('dailey_schedules_item_cancel', { project_id: PID, item: 'appt-42-remind', confirm: true }), 'We could not find that one-time visit.');
  reply = () => ({ ok: true, status: 200, data: { cancelled: true } });
  await fake.run('dailey_schedules_item_cancel', { project_id: PID, item: 'appt-42-remind', confirm: true });
  assert.equal(calls.at(-1)!.path, `/projects/${PID}/schedules/items/appt-42-remind`);
  assert.equal(calls.at(-1)!.method, 'DELETE');
  await fake.run('dailey_schedules_item_cancel', { project_id: PID, item: 'appt:42', confirm: true });
  assert.equal(calls.at(-1)!.path, `/projects/${PID}/schedules/items/appt%3A42`);
  const m = calls.length;
  for (const bad of ['..', 'a b/c', '']) await fake.run('dailey_schedules_item_cancel', { project_id: PID, item: bad, confirm: true });
  assert.equal(calls.length, m);
});

test('item add pending host explains confirmation', async () => {
  reply = () => ({ ok: true, status: 201, data: { id: 'i1', run_at: 'T', delayed: false, pending_confirmation: true } });
  const t = await fake.run('dailey_schedules_item_add', { project_id: PID, at: 'x', visit: { url: 'https://api.example.com/p' } });
  assert.match(t, /api\.example\.com/); assert.match(t, /dailey_schedules_host_confirm/);
});

test('credential add never echoes the value and warns about the conversation', async () => {
  const VALUE = 'sk_live_VALUE_123';
  reply = () => ({ ok: true, status: 201, data: { id: 'c1', name: 'partner-api', host: 'api.example.com', kind: 'header', param_name: 'X-Api-Key' } });
  const t = await fake.run('dailey_schedules_credential_add', { project_id: PID, name: 'partner-api', host: 'api.example.com', kind: 'header', param_name: 'X-Api-Key', value: VALUE });
  assert.deepEqual(calls[0].body, { name: 'partner-api', host: 'api.example.com', kind: 'header', param_name: 'X-Api-Key', value: VALUE });
  assert.doesNotMatch(t, new RegExp(VALUE));
  assert.match(t, /Saved credential partner-api/);
  const d = fake.descriptions.get('dailey_schedules_credential_add')!;
  assert.match(d, /passes through this AI conversation/); assert.match(d, /dashboard/);
  const n = calls.length;
  assert.match(await fake.run('dailey_schedules_credential_add', { project_id: PID, name: 'p', host: 'api.example.com:443', kind: 'header', param_name: 'X', value: VALUE }), /host name/);
  assert.match(await fake.run('dailey_schedules_credential_add', { project_id: PID, name: 'Bad Name', host: 'api.example.com', kind: 'header', param_name: 'X', value: VALUE }), /lowercase/);
  assert.equal(calls.length, n);
});

test('credential remove needs confirm and checks the name', async () => {
  assert.match(await fake.run('dailey_schedules_credential_remove', { project_id: PID, name: 'partner-api' }), /confirm: true/);
  assert.equal(calls.length, 0);
  assert.match(await fake.run('dailey_schedules_credential_remove', { project_id: PID, name: '..', confirm: true }), /lowercase/);
  assert.equal(calls.length, 0);
  reply = () => ({ ok: true, status: 200, data: { deleted: true } });
  await fake.run('dailey_schedules_credential_remove', { project_id: PID, name: 'partner-api', confirm: true });
  assert.deepEqual(calls.at(-1), { method: 'DELETE', path: `/projects/${PID}/schedules/credentials/partner-api`, body: undefined });
});

test('host confirm needs confirm, encodes host, shows the signing secret once with the warning', async () => {
  assert.match(await fake.run('dailey_schedules_host_confirm', { project_id: PID, host: 'api.example.com' }), /confirm: true/);
  assert.equal(calls.length, 0);
  assert.match(await fake.run('dailey_schedules_host_confirm', { project_id: PID, host: 'https://api.example.com/x', confirm: true }), /just the host name/i);
  assert.match(await fake.run('dailey_schedules_host_confirm', { project_id: PID, host: '..', confirm: true }), /host name/i);
  assert.equal(calls.length, 0);
  const once = ['dss', 'host', 'once'].join('_'); // built at runtime, not a real secret
  reply = () => ({ ok: true, status: 200, data: { confirmed: true, signing_secret: once } });
  const t = await fake.run('dailey_schedules_host_confirm', { project_id: PID, host: 'API.Example.com.', confirm: true });
  assert.equal(calls.at(-1)!.path, `/projects/${PID}/schedules/hosts/API.Example.com./confirm`);
  assert.ok(t.includes(once));
  assert.match(t, /shown once/i);
  assert.match(t, /now in this conversation/);
  await fake.run('dailey_schedules_host_confirm', { project_id: PID, host: 'api.example.com:443', confirm: true });
  assert.equal(calls.at(-1)!.path, `/projects/${PID}/schedules/hosts/api.example.com%3A443/confirm`);
});

test('host confirm when already confirmed has no secret to show', async () => {
  reply = () => ({ ok: true, status: 200, data: { confirmed: true, signing_secret: null } });
  const t = await fake.run('dailey_schedules_host_confirm', { project_id: PID, host: 'api.example.com', confirm: true });
  assert.match(t, /already confirmed/);
  assert.match(t, /rotate to get a new secret/);
  assert.doesNotMatch(t, /shown once/);
});

test('host 404 says the address was not found', async () => {
  reply = () => ({ ok: false, status: 404, data: { error: 'Not found.' } });
  assert.match(await fake.run('dailey_schedules_host_confirm', { project_id: PID, host: 'x.example.com', confirm: true }), /find that address/);
  assert.match(await fake.run('dailey_schedules_host_rotate_secret', { project_id: PID, host: 'x.example.com', confirm: true }), /find that address/);
});

test('host rotate secret: revoke_now passes through, secret block shown, destructive needs confirm', async () => {
  assert.match(await fake.run('dailey_schedules_host_rotate_secret', { project_id: PID, host: 'api.example.com' }), /confirm: true/);
  assert.match(await fake.run('dailey_schedules_host_rotate_secret', { project_id: PID, host: 'api.example.com', revoke_now: true }), /confirm: true/);
  assert.equal(calls.length, 0);
  reply = () => ({ ok: true, status: 200, data: { signing_secret: 'dss_NEW', revoke_now: true } });
  const t = await fake.run('dailey_schedules_host_rotate_secret', { project_id: PID, host: 'api.example.com', revoke_now: true, confirm: true });
  assert.deepEqual(calls.at(-1)!.body, { revoke_now: true });
  assert.equal(calls.at(-1)!.path, `/projects/${PID}/schedules/hosts/api.example.com/rotate-secret`);
  assert.match(t, /dss_NEW/);
  assert.match(t, /old secret stopped working now/);
  reply = () => ({ ok: true, status: 200, data: { signing_secret: 'dss_NEW2', revoke_now: false } });
  const t2 = await fake.run('dailey_schedules_host_rotate_secret', { project_id: PID, host: 'api.example.com', confirm: true });
  assert.deepEqual(calls.at(-1)!.body, { revoke_now: false });
  assert.match(t2, /24 hours/);
});

test('rotate app secret and app key: restart note, key never printed', async () => {
  assert.match(await fake.run('dailey_schedules_rotate_secret', { project_id: PID, revoke_now: true }), /confirm: true/);
  assert.match(await fake.run('dailey_schedules_rotate_key', { project_id: PID }), /confirm: true/);
  assert.equal(calls.length, 0);
  reply = () => ({ ok: true, status: 200, data: { restarted: true } });
  const t1 = await fake.run('dailey_schedules_rotate_secret', { project_id: PID, confirm: true });
  assert.deepEqual(calls.at(-1)!.body, { revoke_now: false });
  assert.match(t1, /24 hours/); assert.match(t1, /restarting/);
  reply = () => ({ ok: true, status: 200, data: { restarted: false } });
  const t2 = await fake.run('dailey_schedules_rotate_secret', { project_id: PID, revoke_now: true, confirm: true });
  assert.match(t2, /next deploy/);
  reply = () => ({ ok: true, status: 200, data: { key: 'dsk_ONCE_KEY', restarted: true } });
  const t3 = await fake.run('dailey_schedules_rotate_key', { project_id: PID, confirm: true });
  assert.doesNotMatch(t3, /dsk_ONCE_KEY/);
  assert.match(t3, /old key stopped working/);
});

test('test endpoint: needs confirm, warns, reports protected or open, 429 sentence', async () => {
  const d = fake.descriptions.get('dailey_schedules_test_endpoint')!;
  assert.match(d, /wrong signature/); assert.match(d, /not protected|does the work/);
  const warn = await fake.run('dailey_schedules_test_endpoint', { project_id: PID, schedule_id: SID });
  assert.match(warn, /wrong signature/); assert.match(warn, /5 times a day/); assert.match(warn, /confirm: true/);
  assert.equal(calls.length, 0);
  reply = () => ({ ok: true, status: 200, data: { protected: true, status: 401 } });
  assert.match(await fake.run('dailey_schedules_test_endpoint', { project_id: PID, schedule_id: SID, confirm: true }), /refused the test request \(401\)/);
  assert.equal(calls.at(-1)!.path, `/projects/${PID}/schedules/${SID}/test-endpoint`);
  reply = () => ({ ok: true, status: 200, data: { protected: false, status: 200 } });
  const te = () => fake.run('dailey_schedules_test_endpoint', { project_id: PID, schedule_id: SID, confirm: true });
  assert.match(await te(), /accepted a request with a wrong signature; anyone who finds this path can trigger it/);
  reply = () => ({ ok: true, status: 200, data: { protected: false, status: 302 } });
  assert.match(await te(), /accepted a request with a wrong signature/);
  reply = () => ({ ok: true, status: 200, data: { protected: true, status: 403 } });
  assert.match(await te(), /refused the test request \(403\)/);
  reply = () => ({ ok: true, status: 200, data: { protected: false, status: 500 } });
  assert.match(await te(), /did not refuse it with 401 \(answered 500\); it may not check signatures/);
  reply = () => ({ ok: false, status: 429, data: { error: 'You have used all the endpoint tests for today. Try again tomorrow.' } });
  assert.equal(await fake.run('dailey_schedules_test_endpoint', { project_id: PID, schedule_id: SID, confirm: true }), 'You have used all the endpoint tests for today. Try again tomorrow.');
});

test('no new tool leaks the app key, credential value or signing secret outside the once block', async () => {
  const SECRETS = ['dsk_LEAK_KEY', 'sk_LEAK_CRED'];
  reply = () => ({ ok: true, status: 200, data: { key: SECRETS[0], restarted: true, value: SECRETS[1], id: 'c', name: 'n', host: 'h', kind: 'header', param_name: 'X' } });
  const outs = [
    await fake.run('dailey_schedules_rotate_key', { project_id: PID, confirm: true }),
    await fake.run('dailey_schedules_credential_add', { project_id: PID, name: 'n', host: 'h.example.com', kind: 'header', param_name: 'X', value: SECRETS[1] }),
  ];
  for (const o of outs) for (const s of SECRETS) assert.ok(!o.includes(s));
});

test('dailey_os_guide includes the Dailey Schedules section only with the flag', async () => {
  const { registerPlatformTools } = await import('../src/tools/platform.js');
  const prev = process.env.DAILEY_SCHEDULES_TOOLS;
  try {
    for (const [flag, expect] of [[undefined, false], ['1', true]] as const) {
      if (flag === undefined) delete process.env.DAILEY_SCHEDULES_TOOLS; else process.env.DAILEY_SCHEDULES_TOOLS = flag;
      const f = makeFakeServer();
      registerPlatformTools(f.server as any);
      const text = await f.run('dailey_os_guide', {});
      assert.equal(/### Dailey Schedules/.test(text), expect);
      if (expect) {
        assert.match(text, /Dailey-Schedules-Signature/);
        assert.match(text, /Dailey-Schedules-Verified: v1/);
        assert.match(text, /<slug>\.internal/);
        assert.match(text, /answer 401/);
        assert.match(text, /dailey_schedules_enable/);
        assert.match(text, /dailey_schedules_disable/);
        assert.doesNotMatch(text.slice(text.indexOf('### Dailey Schedules'), text.indexOf('### Usage')), /\u2014/);
      }
    }
  } finally {
    if (prev === undefined) delete process.env.DAILEY_SCHEDULES_TOOLS; else process.env.DAILEY_SCHEDULES_TOOLS = prev;
  }
});
