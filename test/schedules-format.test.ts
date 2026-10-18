// test/schedules-format.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  schedulesToolsEnabled, schedulesErrorText, describeSchedule, describeRun, nextRunsText,
  signingSecretBlock, isSafeId, checkHostInput, checkDedupeKey, checkName, NOT_AVAILABLE, TURN_ON_FIRST,
} from '../src/tools/schedules-format.js';

const EM = /\u2014/;

test('flag is on only for exactly "1"', () => {
  assert.equal(schedulesToolsEnabled({}), false);
  assert.equal(schedulesToolsEnabled({ DAILEY_SCHEDULES_TOOLS: 'true' }), false);
  assert.equal(schedulesToolsEnabled({ DAILEY_SCHEDULES_TOOLS: '1' }), true);
});

test('route_not_found reads as not available, never as a missing project', () => {
  const t = schedulesErrorText({ ok: false, status: 404, data: { error: 'Not found', code: 'route_not_found' } });
  assert.equal(t, NOT_AVAILABLE);
  assert.match(t, /not available on your account yet/);
});

test('403 grant codes, host 404, and 401', () => {
  const msg = "You do not have access to manage that account's projects.";
  assert.equal(schedulesErrorText({ ok: false, status: 403, data: { error: 'no_manager_grant' } }), msg);
  assert.equal(schedulesErrorText({ ok: false, status: 403, data: { error: 'manager_insufficient_role' } }), msg);
  assert.match(schedulesErrorText({ ok: false, status: 401, data: {} }), /dailey login/);
  assert.doesNotMatch(schedulesErrorText({ ok: false, status: 403, data: { error: 'no_manager_grant' } }), /dailey login/);
  assert.match(schedulesErrorText({ ok: false, status: 404, data: { error: 'Not found.' } }, 'host'), /could not find that address for this project\. Check it with dailey_schedules_list/);
  assert.equal(schedulesErrorText({ ok: false, status: 404, data: { error: 'Not found', code: 'route_not_found' } }, 'host'), NOT_AVAILABLE);
});

test('plain 404, 409, 400, 429, 500 and auth errors', () => {
  assert.match(schedulesErrorText({ ok: false, status: 404, data: { error: 'Not found.' } }), /could not find that project or schedule/i);
  assert.equal(schedulesErrorText({ ok: false, status: 409, data: { error: 'Turn on Dailey Schedules for this project first.' } }), TURN_ON_FIRST);
  assert.equal(schedulesErrorText({ ok: false, status: 400, data: { error: 'Use a name with lowercase letters, numbers and dashes.' } }), 'Use a name with lowercase letters, numbers and dashes.');
  assert.equal(schedulesErrorText({ ok: false, status: 429, data: { error: 'You have used all the endpoint tests for today. Try again tomorrow.' } }), 'You have used all the endpoint tests for today. Try again tomorrow.');
  assert.match(schedulesErrorText({ ok: false, status: 500, data: { error: 'Something went wrong.' } }), /Something went wrong/);
  assert.match(schedulesErrorText({ ok: false, status: 502, data: '<html>' }), /try again in a minute/i);
});

test('schedule lines: own app, external, paused, pending, repo', () => {
  const base = { id: 's1', name: 'send-reminders', source: 'platform', kind: 'visit', cron: '0 18 * * *', every_text: 'day at 6pm', timezone: 'America/New_York', enabled: 1, paused_reason: null, pending_confirmation: 0, next_run_at: '2026-10-15T22:00:00.000Z', last_run_at: null, last_status: null, consecutive_failures: 0, method: 'POST', query_keys: [], body_bytes: 0, path: '/api/tasks/send-reminders' };
  const own = describeSchedule(base as any);
  assert.match(own, /send-reminders/);
  assert.match(own, /every day at 6pm \(America\/New_York\)/);
  assert.match(own, /POST \/api\/tasks\/send-reminders/);
  assert.match(own, /id s1/);
  const ext = describeSchedule({ ...base, path: undefined, display_url: 'https://api.example.com/hook?token=***', credential: 'partner-api' } as any);
  assert.match(ext, /https:\/\/api\.example\.com\/hook\?token=\*\*\*/);
  assert.match(ext, /credential partner-api/);
  assert.match(describeSchedule({ ...base, enabled: 0, paused_reason: 'failing' } as any), /Paused after 10 failures in a row/);
  assert.match(describeSchedule({ ...base, enabled: 0, paused_reason: 'plan_limit' } as any), /your plan does not cover this schedule right now/);
  assert.match(describeSchedule({ ...base, pending_confirmation: 1 } as any), /Waiting for you to confirm this address/);
  assert.match(describeSchedule({ ...base, source: 'repo' } as any), /From your code \(dailey\.yaml\)/);
  assert.match(describeSchedule({ ...base, every_text: null } as any), /cron 0 18 \* \* \*/);
  const dbl = describeSchedule({ ...base, every_text: 'every day at 6pm' } as any);
  assert.match(dbl, /every day at 6pm \(/);
  assert.doesNotMatch(dbl, /every every/);
  for (const s of [own, ext]) assert.doesNotMatch(s, EM);
});

test('run line uses reason_message and never the preview', () => {
  const r = { id: 'r1', schedule_id: 's1', item_id: null, run_trigger: 'cron', scheduled_for: '2026-10-14T22:00:00.000Z', started_at: '2026-10-14T22:00:03.000Z', finished_at: '2026-10-14T22:00:04.000Z', status: 'failed', attempt: 3, reason: 'http_500', reason_message: 'The address answered 500.', http_status: 500, duration_ms: 812, error: null, preview: 'secret-looking body' };
  const line = describeRun(r as any);
  assert.match(line, /failed/);
  assert.match(line, /The address answered 500\./);
  assert.match(line, /812 ms/);
  assert.match(line, /attempt 3/);
  assert.doesNotMatch(line, /secret-looking body/);
  assert.match(describeRun({ ...r, status: 'succeeded', reason: null, reason_message: null, http_status: 200 } as any), /succeeded.*200/);
  assert.match(describeRun({ ...r, run_trigger: 'manual' } as any), /run now/);
});

test('next runs text', () => {
  assert.equal(nextRunsText([]), 'No upcoming runs.');
  assert.match(nextRunsText(['2026-10-15T22:00:00.000Z', '2026-10-16T22:00:00.000Z'], 'America/New_York'), /Next runs \(America\/New_York\):\n  2026-10-15T22:00:00.000Z\n  2026-10-16T22:00:00.000Z/);
});

test('signing secret block warns, says once, names the host', () => {
  const m = signingSecretBlock('api.example.com', 'dss_abc', 'mcp');
  assert.match(m, /shown once/i);
  assert.match(m, /dss_abc/);
  assert.match(m, /api\.example\.com/);
  assert.match(m, /will not show it again/);
  assert.match(m, /now in this conversation/);
  assert.doesNotMatch(m, EM);
  assert.doesNotMatch(signingSecretBlock('api.example.com', 'dss_abc', 'cli'), /conversation/);
});

test('ids and hosts are checked before any request', () => {
  assert.equal(isSafeId('3f2b8c1e-5a4d-4e6f-9a1b-0c2d3e4f5a6b'), true);
  assert.equal(isSafeId('../../admin'), false);
  assert.equal(isSafeId('abc%2Fdef'), false);
  assert.equal(checkHostInput('api.example.com'), null);
  assert.equal(checkHostInput('API.Example.com.'), null);
  assert.equal(checkHostInput('https://api.example.com/x'), 'Give just the host name, like api.example.com.');
  assert.equal(checkHostInput('api.example.com:443'), null);
  assert.equal(checkHostInput('api.example.com:443', true), 'Give just the host name, like api.example.com.');
  assert.equal(checkHostInput('a@b.com'), 'Give just the host name, like api.example.com.');
  assert.equal(checkHostInput('a b.com'), 'Give just the host name, like api.example.com.');
  assert.equal(checkHostInput('.'), 'Give just the host name, like api.example.com.');
  assert.equal(checkHostInput('..'), 'Give just the host name, like api.example.com.');
  assert.equal(isSafeId('..'), false);
  assert.equal(checkDedupeKey('appt-42-remind'), null);
  assert.equal(checkDedupeKey('..') !== null, true);
  assert.equal(checkDedupeKey('appt 42/remind'), 'The dedupe key can use letters, numbers and . _ : - (up to 120), and cannot look like an id.');
  assert.equal(checkDedupeKey('3f2b8c1e-5a4d-4e6f-9a1b-0c2d3e4f5a6b') !== null, true);
  assert.equal(checkHostInput(''), 'Give just the host name, like api.example.com.');
});

test('constants carry no em dash', () => {
  for (const s of [NOT_AVAILABLE, TURN_ON_FIRST]) assert.doesNotMatch(s, EM);
});

test('checkName matches the server name rule', () => {
  const help = 'Use a name with lowercase letters, numbers and dashes.';
  assert.equal(checkName('partner-api'), null);
  assert.equal(checkName('a'.repeat(80)), null);
  assert.equal(checkName('a'.repeat(65)), null);
  assert.equal(checkName('a'.repeat(81)), help);
  assert.equal(checkName('Partner'), help);
  for (const bad of ['.', '..', '_x', 'a_b', 'a/b', '', '-a']) assert.equal(checkName(bad), help);
});

test('dedupe key edges', () => {
  assert.equal(checkDedupeKey('a'.repeat(120)), null);
  assert.notEqual(checkDedupeKey('a'.repeat(121)), null);
  assert.notEqual(checkDedupeKey(''), null);
  assert.notEqual(checkDedupeKey('3F2B8C1E-5A4D-4E6F-9A1B-0C2D3E4F5A6B'), null);
});

test('strict host refuses ? and #', () => {
  assert.notEqual(checkHostInput('a.com?x', true), null);
  assert.notEqual(checkHostInput('a.com#x', true), null);
});

test('more schedule flags and run triggers', () => {
  const base = { id: 's1', name: 'n', source: 'platform', kind: 'visit', cron: '0 18 * * *', every_text: 'day', timezone: null, enabled: 1, paused_reason: null, pending_confirmation: 0, next_run_at: '2026-10-15T22:00:00.000Z', last_run_at: null, last_status: null, consecutive_failures: 0, method: 'GET', query_keys: [], body_bytes: 0, path: '/x' };
  assert.match(describeSchedule({ ...base, source: 'app' } as any), /Created by your app/);
  const pu = describeSchedule({ ...base, enabled: 0, paused_reason: 'paused_by_user' } as any);
  assert.match(pu, /Paused/);
  assert.doesNotMatch(pu, /next 2026/);
  assert.match(describeSchedule({ ...base, enabled: 0, paused_reason: 'disabled' } as any), /turned off for this project/);
  assert.match(describeRun({ id: 'r', run_trigger: 'item', scheduled_for: 'x', status: 'succeeded', attempt: 1 } as any), /one-time/);
});

test('more error statuses', () => {
  assert.match(schedulesErrorText({ ok: false, status: 504, data: null }), /try again in a minute/i);
  assert.match(schedulesErrorText({ ok: false, status: 403, data: {} }), /could not do that/);
  assert.match(schedulesErrorText({ ok: false, status: 500, data: null }), /HTTP 500/);
  assert.match(schedulesErrorText({ ok: false, status: 501, data: null }), /HTTP 501/);
});

test('signing secret block refuses an empty secret', () => {
  assert.throws(() => signingSecretBlock('a.com', '', 'mcp'));
  assert.throws(() => signingSecretBlock('a.com', null as any, 'cli'));
});
