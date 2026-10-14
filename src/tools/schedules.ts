import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, textResult, isValidProjectId, invalidProjectIdResult } from '../api.js';
import {
  schedulesErrorText, describeSchedule, describeRun, nextRunsText, isSafeId, type Schedule, type Run,
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
    'Turn off Dailey Schedules for a project. Every schedule stops running until it is turned on again. Ask the user first and pass confirm: true.',
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
    'Change when a Dailey Schedules schedule runs (every or cron, time zone) or what it visits. Schedules that come from dailey.yaml are changed in code instead.',
    { ...projectArg, ...scheduleArg, every: z.string().optional(), cron: z.string().optional(), timezone: z.string().optional(), visit: visitSchema.optional() },
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
}
