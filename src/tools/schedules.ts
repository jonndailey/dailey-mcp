import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, textResult, isValidProjectId, invalidProjectIdResult } from '../api.js';
import {
  schedulesErrorText, describeSchedule, describeRun, nextRunsText, isSafeId, signingSecretBlock, checkHostInput, checkDedupeKey, checkName,
  type Schedule, type Run,
} from './schedules-format.js';

// Dailey Schedules tools (spec 2026-10-14 section 8). All calls go to the owner routes
// /projects/:id/schedules...; account scoping and manager acting-as come from
// buildServer's wrapper (X-Dailey-Account). Registered only when
// DAILEY_SCHEDULES_TOOLS=1 (see server.ts). Copy: plain words, no em dashes.

const projectArg = { project_id: z.string().describe('The project id (from dailey_list_projects).') };
const enc = encodeURIComponent;
const base = (pid: string) => `/projects/${enc(pid)}/schedules`;
const bad = (what: string, id: string) => textResult(`"${id}" is not a valid ${what} id. Get ids from dailey_schedules_list or dailey_schedules_history.`);

export const visitSchema = z.object({
  path: z.string().optional().describe('A path in this project\'s own app, like /api/tasks/send-reminders. Use this or url.'),
  url: z.string().optional().describe('An outside https:// address. The first time you use a new host it waits for your confirmation.'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().describe('Default GET.'),
  body: z.string().optional().describe('Request body (JSON text) up to 64 KB. Stored encrypted.'),
  credential: z.string().optional().describe('Name of a saved credential for the url host (dailey_schedules_credential_add). Not for own-app paths.'),
});

const scheduleArg = { schedule_id: z.string().describe('The schedule id (from dailey_schedules_list).') };
const confirmArg = { confirm: z.boolean().optional().describe('Must be true. Ask the user first.') };
const onlyDefined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const visitProblem = (v: { path?: string; url?: string } | undefined) => {
  if (!v || (!v.path && !v.url)) return 'Give a path in your app or a url.';
  if (v.path && v.url) return 'Give either a path or a url, not both.';
  return null;
};
const hostOf = (url?: string) => { try { return url ? new URL(url).hostname : ''; } catch { return ''; } };
const VERIFY_HINT = 'Make sure the app can verify the Dailey Schedules signature (DAILEY_SCHEDULES_SECRET) and answers 401 without a valid one. dailey_os_guide has the steps.';

type Overview = {
  enabled: boolean; schedules: Schedule[];
  hosts: { host: string; confirmed: boolean; confirmed_at: string | null }[];
  credentials: { name: string; host: string; kind: string; param_name: string }[];
  signature_seen: boolean;
};

export function registerSchedulesTools(server: McpServer) {
  server.tool(
    'dailey_schedules_list',
    'Show Dailey Schedules for a project: whether it is on, every schedule (when it runs, what it visits, next run, paused or waiting for confirmation), addresses that still need your confirmation, saved credentials (names only, never values) and whether the app has been seen checking signatures.',
    { ...projectArg },
    async ({ project_id }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      const res = await apiRequest<Overview>('GET', base(project_id));
      if (!res.ok) return textResult(schedulesErrorText(res));
      const d = res.data;
      if (!d.enabled) return textResult('Dailey Schedules is off for this project. Turn it on with dailey_schedules_enable, then create schedules with dailey_schedules_create.');
      const lines = ['Dailey Schedules is on.', ''];
      lines.push(d.schedules.length ? 'Schedules:' : 'No schedules yet. Create one with dailey_schedules_create.');
      for (const s of d.schedules) lines.push(`  ${describeSchedule(s)}`);
      const pending = d.hosts.filter(h => !h.confirmed);
      if (pending.length) {
        lines.push('', 'Addresses waiting for your confirmation (nothing runs there until you confirm):');
        for (const h of pending) lines.push(`  ${h.host}: waiting for your confirmation. Confirm with dailey_schedules_host_confirm.`);
      }
      if (d.credentials.length) {
        lines.push('', 'Credentials (values are never shown):');
        for (const c of d.credentials) lines.push(`  ${c.name}: ${c.kind} ${c.param_name} for ${c.host}`);
      }
      lines.push('', d.signature_seen
        ? 'Signature check: your app has confirmed it checks Dailey Schedules signatures.'
        : 'Signature check: we have not seen your app confirm a signature check yet. Your app should verify DAILEY_SCHEDULES_SECRET signatures and answer 401 without one (see dailey_os_guide).');
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_schedules_preview',
    'Check a Dailey Schedules timing before saving it: give a plain phrase (every, like "weekday at 9am" or "hour") or a cron expression, plus an optional time zone, and see the cron it becomes and the next 5 run times.',
    {
      ...projectArg,
      every: z.string().optional().describe('Plain phrase, like "day at 6pm", "monday at 9am", "hour". Use this or cron.'),
      cron: z.string().optional().describe('Five-field cron expression, like "30 3 * * *". Use this or every.'),
      timezone: z.string().optional().describe('IANA time zone, like America/New_York. Defaults to UTC.'),
    },
    async ({ project_id, every, cron, timezone }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      const body: Record<string, unknown> = {};
      if (every !== undefined) body.every = every;
      if (cron !== undefined) body.cron = cron;
      if (timezone !== undefined) body.timezone = timezone;
      const res = await apiRequest<{ cron: string; timezone: string; next_runs: string[] }>('POST', `${base(project_id)}/preview`, body);
      if (!res.ok) return textResult(schedulesErrorText(res));
      return textResult(`Runs as cron ${res.data.cron} in ${res.data.timezone}.\n${nextRunsText(res.data.next_runs, res.data.timezone)}`);
    },
  );

  server.tool(
    'dailey_schedules_history',
    'Show Dailey Schedules run history for a project, newest first: status, when it ran, how long it took, HTTP status and a plain reason for any failure. Pass schedule_id to see one schedule, or run_id to see one run with its response preview (first 2 KB, secrets removed).',
    {
      ...projectArg,
      schedule_id: z.string().optional().describe('Only runs of this schedule.'),
      run_id: z.string().optional().describe('Show this one run in detail.'),
      limit: z.number().int().min(1).max(200).optional().describe('How many runs, 1 to 200. Default 50.'),
    },
    async ({ project_id, schedule_id, run_id, limit }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      if (schedule_id !== undefined && !isSafeId(schedule_id)) return bad('schedule', schedule_id);
      if (run_id !== undefined && !isSafeId(run_id)) return bad('run', run_id);
      if (run_id) {
        const res = await apiRequest<Run>('GET', `${base(project_id)}/runs/${enc(run_id)}`);
        if (!res.ok) return textResult(schedulesErrorText(res));
        const r = res.data;
        const lines = [describeRun(r)];
        if (r.preview) lines.push('', 'Response preview (first 2 KB, secrets removed):', r.preview);
        return textResult(lines.join('\n'));
      }
      const qs = new URLSearchParams();
      if (schedule_id) qs.set('schedule_id', schedule_id);
      if (limit) qs.set('limit', String(limit));
      const q = qs.toString();
      const res = await apiRequest<Run[]>('GET', `${base(project_id)}/runs${q ? `?${q}` : ''}`);
      if (!res.ok) return textResult(schedulesErrorText(res));
      if (!res.data.length) return textResult('No runs yet.');
      return textResult(res.data.map(describeRun).join('\n'));
    },
  );

  server.tool(
    'dailey_schedules_enable',
    'Turn on Dailey Schedules for a project. The app gets DAILEY_SCHEDULES_SECRET (to check our signed calls), DAILEY_SCHEDULES_API_URL and DAILEY_SCHEDULES_KEY (to create its own schedules and one-time visits), and restarts to pick them up. Free plan: 3 schedules, at most hourly. Studio: 25, every minute. Managed: 50.',
    { ...projectArg },
    async ({ project_id }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      const res = await apiRequest<{ enabled: boolean; api_url: string; key: string }>('POST', `${base(project_id)}/enable`, {});
      if (!res.ok) return textResult(schedulesErrorText(res));
      // The app key is injected into the app already; it is never printed here.
      return textResult([
        'Dailey Schedules is on for this project.',
        'Your app now has these settings, and restarts to pick them up if it is deployed:',
        '  DAILEY_SCHEDULES_SECRET: checks that calls really come from Dailey Schedules',
        `  DAILEY_SCHEDULES_API_URL: ${res.data.api_url}`,
        '  DAILEY_SCHEDULES_KEY: lets your app create and cancel its own schedules',
        'The values are not shown here. The owner can reveal them in the dashboard under Environment.',
        '',
        `Next: create a schedule with dailey_schedules_create. ${VERIFY_HINT}`,
      ].join('\n'));
    },
  );

  server.tool(
    'dailey_schedules_disable',
    'Turn off Dailey Schedules for a project. Every schedule stops running. Schedules stay saved but stay paused: after turning Dailey Schedules back on, resume each one with dailey_schedules_resume. Ask the user first and pass confirm: true.',
    { ...projectArg, ...confirmArg },
    async ({ project_id, confirm }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      if (confirm !== true) return textResult('This stops every Dailey Schedules schedule in this project. Ask the user, then call again with confirm: true.');
      const res = await apiRequest('POST', `${base(project_id)}/disable`, {});
      if (!res.ok) return textResult(schedulesErrorText(res));
      return textResult('Dailey Schedules is turned off for this project. Schedules stay saved but stay paused; after you turn Dailey Schedules back on, resume each one with dailey_schedules_resume.');
    },
  );

  server.tool(
    'dailey_schedules_create',
    'Create a Dailey Schedules schedule that visits a path in this project\'s app (signed with DAILEY_SCHEDULES_SECRET) or an outside https address. Give a name (lowercase letters, numbers, dashes), and either every (plain phrase like "day at 6pm") or cron, plus an optional IANA time zone. A new outside host waits for the owner\'s confirmation before it runs.',
    {
      ...projectArg,
      name: z.string().describe('Lowercase letters, numbers and dashes, like send-reminders.'),
      every: z.string().optional().describe('Plain phrase, like "weekday at 9am". Use this or cron.'),
      cron: z.string().optional().describe('Five-field cron. Use this or every.'),
      timezone: z.string().optional().describe('IANA time zone. Defaults to UTC.'),
      visit: visitSchema,
      concurrency: z.enum(['forbid', 'allow']).optional().describe('forbid (default) skips a run while the previous one is still going.'),
    },
    async ({ project_id, name, every, cron, timezone, visit, concurrency }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      const p = visitProblem(visit); if (p) return textResult(p);
      const res = await apiRequest<{ id: string; next_runs: string[]; pending_confirmation: boolean }>('POST', base(project_id),
        onlyDefined({ name, every, cron, timezone, visit: onlyDefined(visit), concurrency }));
      if (!res.ok) return textResult(schedulesErrorText(res));
      const lines = [`Created ${name} (id ${res.data.id}).`];
      if (res.data.pending_confirmation) {
        lines.push(`It will not run until you confirm ${hostOf(visit.url) || 'the new address'}. Ask the user, then call dailey_schedules_host_confirm. Confirming shows a signing secret once.`);
      } else {
        lines.push(nextRunsText(res.data.next_runs, timezone));
        if (visit.path) lines.push(VERIFY_HINT);
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_schedules_update',
    'Change when a Dailey Schedules schedule runs (every or cron, time zone) or what it visits. Get the schedule id from dailey_schedules_list. Schedules that come from dailey.yaml are changed in code instead.',
    {
      ...projectArg, ...scheduleArg,
      every: z.string().optional().describe('New plain phrase, like "weekday at 9am". Every and cron are alternatives: give one.'),
      cron: z.string().optional().describe('New five-field cron. Every and cron are alternatives: give one.'),
      timezone: z.string().optional().describe('IANA time zone, like America/New_York.'),
      visit: visitSchema.optional(),
    },
    async ({ project_id, schedule_id, every, cron, timezone, visit }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      if (!isSafeId(schedule_id)) return bad('schedule', schedule_id);
      if (visit) { const p = visitProblem(visit); if (p) return textResult(p); }
      const res = await apiRequest<{ id: string; next_runs: string[] }>('PATCH', `${base(project_id)}/${enc(schedule_id)}`,
        onlyDefined({ every, cron, timezone, visit: visit ? onlyDefined(visit) : undefined }));
      if (!res.ok) return textResult(schedulesErrorText(res));
      return textResult(`Updated.\n${nextRunsText(res.data.next_runs, timezone)}`);
    },
  );

  server.tool(
    'dailey_schedules_delete',
    'Delete a Dailey Schedules schedule and stop its future runs. Its history is kept for the plan\'s history days. Ask the user first and pass confirm: true.',
    { ...projectArg, ...scheduleArg, ...confirmArg },
    async ({ project_id, schedule_id, confirm }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      if (!isSafeId(schedule_id)) return bad('schedule', schedule_id);
      if (confirm !== true) return textResult('This deletes the schedule. Ask the user, then call again with confirm: true.');
      const res = await apiRequest('DELETE', `${base(project_id)}/${enc(schedule_id)}`);
      if (!res.ok) return textResult(schedulesErrorText(res));
      return textResult('Deleted.');
    },
  );

  for (const [tool, verb, desc, done] of [
    ['dailey_schedules_pause', 'pause', 'Pause a Dailey Schedules schedule. It keeps its settings and counts toward the plan limit.', 'Paused. Resume with dailey_schedules_resume.'],
    ['dailey_schedules_resume', 'resume', 'Resume a paused Dailey Schedules schedule (also after an automatic pause). Plan limits are checked again.', 'Resumed. It runs at its next scheduled time.'],
  ] as const) {
    server.tool(tool, desc, { ...projectArg, ...scheduleArg }, async ({ project_id, schedule_id }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      if (!isSafeId(schedule_id)) return bad('schedule', schedule_id);
      const res = await apiRequest('POST', `${base(project_id)}/${enc(schedule_id)}/${verb}`, {});
      if (!res.ok) return textResult(schedulesErrorText(res));
      return textResult(done);
    });
  }

  server.tool(
    'dailey_schedules_run_now',
    'Run a Dailey Schedules schedule once, now, in addition to its normal times. Free: 5 a day per project. Paid plans: 60 an hour per project.',
    { ...projectArg, ...scheduleArg },
    async ({ project_id, schedule_id }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      if (!isSafeId(schedule_id)) return bad('schedule', schedule_id);
      const res = await apiRequest<{ run_id: string }>('POST', `${base(project_id)}/${enc(schedule_id)}/run-now`, {});
      if (!res.ok) return textResult(schedulesErrorText(res));
      return textResult(`Queued run ${res.data.run_id}. It starts within a few seconds. Check it with dailey_schedules_history (run_id ${res.data.run_id}).`);
    },
  );

  const TEST_WARNING = 'This sends one request to this schedule\'s path in your app with a wrong signature, the way a stranger would. If your app checks signatures it answers 401 and nothing happens. If it does not check, it does the work as if the call were real (then it is not protected), so only test when that is safe. You can test 5 times a day.';

  server.tool('dailey_schedules_item_add',
    'Schedule a one-time Dailey Schedules visit at a set time (for example a reminder at 2026-10-19T17:00 in America/New_York). Use dedupe_key (letters, numbers and . _ : -) so the same item is never added twice; cancel it later by id or dedupe_key.',
    {
      ...projectArg,
      at: z.string().describe('ISO date and time, like 2026-10-19T17:00:00-04:00, or 2026-10-19T17:00 with timezone.'),
      timezone: z.string().optional().describe('IANA time zone for a time without an offset.'),
      visit: visitSchema,
      dedupe_key: z.string().optional().describe('Your own key for this item, like appt-42-remind.'),
    },
    async ({ project_id, at, timezone, visit, dedupe_key }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      const p = visitProblem(visit); if (p) return textResult(p);
      if (dedupe_key !== undefined) { const k = checkDedupeKey(dedupe_key); if (k) return textResult(k); }
      const res = await apiRequest<{ id: string; run_at: string; delayed: boolean; pending_confirmation: boolean }>('POST', `${base(project_id)}/items`,
        onlyDefined({ at, timezone, visit: onlyDefined(visit), dedupe_key }));
      if (!res.ok) return textResult(schedulesErrorText(res));
      const lines = [`One-time visit ${res.data.id} set for ${res.data.run_at}.`];
      if (res.data.delayed) lines.push('On the Free plan one-time visits run at most once an hour per project, so this one moved to the next free slot.');
      if (res.data.pending_confirmation) lines.push(`It will not run until you confirm ${hostOf(visit.url) || 'the new address'} with dailey_schedules_host_confirm.`);
      return textResult(lines.join('\n'));
    });

  server.tool('dailey_schedules_item_cancel',
    'Cancel a pending one-time Dailey Schedules visit by its id or its dedupe_key. This cannot be undone, and the dedupe_key cannot be reused afterwards. Ask the user first and pass confirm: true.',
    { ...projectArg, item: z.string().describe('The item id or the dedupe_key you gave it.'), ...confirmArg },
    async ({ project_id, item, confirm }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      if (!item) return textResult('Give the item id or dedupe key.');
      if (!isSafeId(item)) { const k = checkDedupeKey(item); if (k) return textResult(k); }
      if (confirm !== true) return textResult('This cancels the one-time visit and cannot be undone; its dedupe key cannot be reused. Ask the user, then call again with confirm: true.');
      const res = await apiRequest('DELETE', `${base(project_id)}/items/${enc(item)}`);
      if (!res.ok) return textResult(schedulesErrorText(res, 'item'));
      return textResult('Cancelled.');
    });

  server.tool('dailey_schedules_credential_add',
    'Save a credential (an API key or token) that Dailey Schedules sends to ONE outside host, as a header or a query parameter. Schedules use it by name; the value is stored encrypted and never shown again. The value passes through this AI conversation, so for a private way, add it in the dashboard on the project\'s Schedules tab instead.',
    {
      ...projectArg,
      name: z.string().describe('Lowercase letters, numbers and dashes.'),
      host: z.string().describe('Just the host, like api.example.com.'),
      kind: z.enum(['header', 'query']),
      param_name: z.string().describe('Header name (like X-Api-Key) or query parameter name.'),
      value: z.string().describe('The secret value. It is in this conversation, and is never repeated back.'),
    },
    async ({ project_id, name, host, kind, param_name, value }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      const n = checkName(name); if (n) return textResult(n);
      const h = checkHostInput(host, true); if (h) return textResult(h);
      const res = await apiRequest<{ name: string; host: string; kind: string; param_name: string }>('POST', `${base(project_id)}/credentials`, { name, host, kind, param_name, value });
      if (!res.ok) return textResult(schedulesErrorText(res));
      return textResult(`Saved credential ${res.data.name}: ${res.data.kind} ${res.data.param_name} for ${res.data.host}. The value is stored encrypted and will not be shown again. Use it with visit.credential = "${res.data.name}".`);
    });

  server.tool('dailey_schedules_credential_remove',
    'Delete a saved Dailey Schedules credential. Refused while a schedule still uses it. Ask the user first and pass confirm: true.',
    { ...projectArg, name: z.string(), ...confirmArg },
    async ({ project_id, name, confirm }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      const n = checkName(name); if (n) return textResult(n);
      if (confirm !== true) return textResult('This deletes the credential. Ask the user, then call again with confirm: true.');
      const res = await apiRequest('DELETE', `${base(project_id)}/credentials/${enc(name)}`);
      if (!res.ok) return textResult(schedulesErrorText(res));
      return textResult('Deleted.');
    });

  server.tool('dailey_schedules_host_confirm',
    'Confirm an outside host so Dailey Schedules may call it. Until then, schedules that target it do not run. Confirming creates a signing secret for that host, shown once (it will then be in this conversation), which the receiving service uses to check our calls. Ask the user first and pass confirm: true.',
    { ...projectArg, host: z.string().describe('Just the host, like api.example.com.'), ...confirmArg },
    async ({ project_id, host, confirm }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      const h = checkHostInput(host); if (h) return textResult(h);
      if (confirm !== true) return textResult(`Confirming lets Dailey Schedules call ${host.trim()} for this project and shows a signing secret once. Ask the user, then call again with confirm: true.`);
      const res = await apiRequest<{ confirmed: boolean; signing_secret: string | null }>('POST', `${base(project_id)}/hosts/${enc(host.trim())}/confirm`, {});
      if (!res.ok) return textResult(schedulesErrorText(res, 'host'));
      if (!res.data.signing_secret) return textResult(`${host.trim()} was already confirmed. Its signing secret is not shown again; rotate to get a new secret with dailey_schedules_host_rotate_secret.`);
      return textResult(`Confirmed ${host.trim()}. Schedules that target it can run now.\n\n${signingSecretBlock(host.trim(), res.data.signing_secret, 'mcp')}`);
    });

  server.tool('dailey_schedules_host_rotate_secret',
    'Make a new Dailey Schedules signing secret for a confirmed outside host (shown once, so it will be in this conversation). By default the old one keeps working for 24 hours; revoke_now: true stops it at once. Ask the user first and pass confirm: true (also when revoke_now is true).',
    { ...projectArg, host: z.string(), revoke_now: z.boolean().optional(), ...confirmArg },
    async ({ project_id, host, revoke_now, confirm }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      const h = checkHostInput(host); if (h) return textResult(h);
      if (confirm !== true) return textResult('This makes a new signing secret for the host. Ask the user, then call again with confirm: true.');
      const res = await apiRequest<{ signing_secret: string; revoke_now: boolean }>('POST', `${base(project_id)}/hosts/${enc(host.trim())}/rotate-secret`, { revoke_now: revoke_now === true });
      if (!res.ok) return textResult(schedulesErrorText(res, 'host'));
      const overlap = res.data.revoke_now ? 'The old secret stopped working now.' : 'The old secret keeps working for 24 hours.';
      return textResult(`${overlap}\n\n${signingSecretBlock(host.trim(), res.data.signing_secret, 'mcp')}`);
    });

  server.tool('dailey_schedules_rotate_secret',
    'Dailey Schedules: make a new DAILEY_SCHEDULES_SECRET for this project\'s app (the secret it uses to check our signed calls). The app restarts to pick it up. By default the old secret is also accepted for 24 hours; revoke_now: true stops it at once. Ask the user first and pass confirm: true.',
    { ...projectArg, revoke_now: z.boolean().optional(), ...confirmArg },
    async ({ project_id, revoke_now, confirm }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      if (confirm !== true) return textResult('This changes the secret your app uses and restarts it. Ask the user, then call again with confirm: true.');
      const res = await apiRequest<{ restarted: boolean }>('POST', `${base(project_id)}/rotate-secret`, { revoke_now: revoke_now === true });
      if (!res.ok) return textResult(schedulesErrorText(res));
      return textResult([
        revoke_now ? 'New secret made. The old one stopped working now.' : 'New secret made. Calls carry both signatures for 24 hours, so the app keeps working while it switches.',
        res.data.restarted ? 'Your app is restarting to pick up the new value.' : 'Your app is not running right now; it gets the new value on its next deploy.',
      ].join('\n'));
    });

  server.tool('dailey_schedules_rotate_key',
    'Dailey Schedules: make a new DAILEY_SCHEDULES_KEY (the key your app uses to create its own schedules). The old key stops working at once and the app restarts with the new one. The key is not shown. Ask the user first and pass confirm: true.',
    { ...projectArg, ...confirmArg },
    async ({ project_id, confirm }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      if (confirm !== true) return textResult('The old key stops working at once and the app restarts. Ask the user, then call again with confirm: true.');
      const res = await apiRequest<{ key: string; restarted: boolean }>('POST', `${base(project_id)}/rotate-key`, {});
      if (!res.ok) return textResult(schedulesErrorText(res));
      return textResult([
        'New key made and given to your app. The old key stopped working.',
        res.data.restarted ? 'Your app is restarting to pick it up.' : 'Your app is not running right now; it gets the new key on its next deploy.',
        'The key is not shown here. The owner can reveal it in the dashboard under Environment.',
      ].join('\n'));
    });

  server.tool('dailey_schedules_test_endpoint',
    `Check whether a Dailey Schedules path in this project's app refuses calls without a valid signature. ${TEST_WARNING} Only for schedules that visit a path in your app. Ask the user first and pass confirm: true.`,
    { ...projectArg, ...scheduleArg, ...confirmArg },
    async ({ project_id, schedule_id, confirm }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      if (!isSafeId(schedule_id)) return bad('schedule', schedule_id);
      if (confirm !== true) return textResult(`${TEST_WARNING}\nAsk the user, then call again with confirm: true.`);
      const res = await apiRequest<{ protected: boolean; status: number }>('POST', `${base(project_id)}/${enc(schedule_id)}/test-endpoint`, {});
      if (!res.ok) return textResult(schedulesErrorText(res));
      const st = res.data.status;
      if (res.data.protected) return textResult(`Good: your app refused the test request (${st}). It checks Dailey Schedules signatures.`);
      if (st >= 200 && st < 400) return textResult(`Warning: your app accepted a request with a wrong signature; anyone who finds this path can trigger it (answered ${st}). Add signature checking (dailey_os_guide has the steps) and test again.`);
      return textResult(`Your app did not refuse it with 401 (answered ${st}); it may not check signatures. Add signature checking (dailey_os_guide has the steps) and test again.`);
    });
}
