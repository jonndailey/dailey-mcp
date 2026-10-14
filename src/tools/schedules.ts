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
const base = (pid: string) => `/projects/${pid}/schedules`;
const bad = (what: string, id: string) => textResult(`"${id}" is not a valid ${what} id. Get ids from dailey_schedules_list or dailey_schedules_history.`);

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
        const res = await apiRequest<Run>('GET', `${base(project_id)}/runs/${run_id}`);
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
}
