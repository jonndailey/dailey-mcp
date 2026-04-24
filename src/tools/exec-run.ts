import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, textResult, formatError } from '../api.js';

export function registerExecRunTools(server: McpServer) {
  server.tool(
    'dailey_exec',
    'Run a one-off command inside a running pod for a project (similar to `kubectl exec`). Useful for troubleshooting — inspect files, run `node --version`, `cat /etc/env`, etc. The command is an argv array (not a shell string). Captures up to 1 MB of stdout/stderr and times out at 60s by default (configurable to 300s max). Needs at least one Ready pod. For one-off jobs that run to completion in their own pod (migrations, seeders, backfills) use dailey_run instead — exec attaches to a live pod, run spawns a new Job.',
    {
      project_id: z.string().describe('The project ID'),
      command: z.array(z.string()).describe('Command as argv array, e.g. ["node","--version"] or ["ls","-la","/app"]. Not a shell string.'),
      process: z.string().optional().describe('Process name for multi-process projects (e.g. "worker", "web"). Defaults to the primary pod.'),
      timeout_seconds: z.number().int().optional().describe('Command timeout in seconds (default 60, max 300)'),
    },
    async ({ project_id, command, process: processName, timeout_seconds }) => {
      const body: any = { command };
      if (processName) body.process = processName;
      if (timeout_seconds) body.timeout_seconds = timeout_seconds;

      const res = await apiRequest<any>('POST', `/projects/${project_id}/exec`, body);
      if (!res.ok) return textResult(formatError(res));

      const d = res.data;
      const lines = [
        `exec: ${d.exit_code === 0 ? '✓ exit 0' : `✗ exit ${d.exit_code ?? '?'}`}${d.timed_out ? ' (timed out)' : ''}`,
        `pod:  ${d.pod || '-'}`,
        `duration: ${d.duration_ms ?? '?'}ms`,
      ];
      if (d.stdout) {
        lines.push('', '--- stdout ---');
        lines.push(d.stdout.length > 4000 ? d.stdout.slice(0, 4000) + '\n...[truncated]' : d.stdout);
      }
      if (d.stderr) {
        lines.push('', '--- stderr ---');
        lines.push(d.stderr.length > 2000 ? d.stderr.slice(0, 2000) + '\n...[truncated]' : d.stderr);
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_run',
    'Start a one-off container job using the project\'s deployed image — new pod, own lifecycle, own output. Inherits env, volumes, resources, and imagePullSecrets from the project Deployment so it sees the same DATABASE_URL and secrets as the app. Use for: one-time migrations, data backfills, seeders, cron catch-ups. Returns a job_name you can pass to dailey_run_logs to stream output. Jobs auto-clean 1h after completion. Project must be deployed first (can be paused). If you just want a quick command against a live pod, use dailey_exec instead.',
    {
      project_id: z.string().describe('The project ID'),
      command: z.array(z.string()).describe('Command as argv array, e.g. ["node","prisma/seed.mjs"] or ["python","-m","manage","migrate"]'),
    },
    async ({ project_id, command }) => {
      const res = await apiRequest<any>('POST', `/projects/${project_id}/run`, { command });
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      const lines = [
        `Job started: ${d.job_name}`,
        `Namespace:   ${d.namespace || '-'}`,
        `Image:       ${d.image || '-'}`,
        `Audit ID:    ${d.audit_id || '-'}`,
        '',
        `Stream logs:  dailey_run_logs(project_id, job_name="${d.job_name}")`,
        `Job TTL:      1 hour after completion (auto-cleaned)`,
      ];
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_run_logs',
    'Fetch logs for a one-off job started by dailey_run. Pass the job_name returned by the run call. Returns stdout+stderr combined, up to 1 MB.',
    {
      project_id: z.string().describe('The project ID'),
      job_name: z.string().describe('Job name returned by dailey_run (e.g. "myapp-run-abc12345")'),
    },
    async ({ project_id, job_name }) => {
      const res = await apiRequest<any>('GET', `/projects/${project_id}/run/${job_name}/logs`);
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      const lines = [
        `Job: ${job_name}`,
        `Status: ${d.status || 'unknown'}`,
      ];
      if (d.started_at) lines.push(`Started: ${d.started_at}`);
      if (d.finished_at) lines.push(`Finished: ${d.finished_at}`);
      if (d.exit_code !== undefined && d.exit_code !== null) lines.push(`Exit: ${d.exit_code}`);
      if (d.logs) {
        lines.push('', '--- logs ---');
        const out = typeof d.logs === 'string' ? d.logs : JSON.stringify(d.logs);
        lines.push(out.length > 6000 ? out.slice(0, 6000) + '\n...[truncated]' : out);
      }
      return textResult(lines.join('\n'));
    },
  );
}
