import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface Process {
  name: string;
  type?: string;
  command?: string;
  port?: number;
  replicas?: number;
  cpu_millicores?: number;
  memory_mb?: number;
  timeout_seconds?: number;
  namespace?: string;
  domain?: string;
  status?: string;
}

interface ProcessLogsResponse {
  pods?: Array<{ pod: string; status: string; node: string; restarts: number; log: string }>;
  logs?: string[];
}

interface ProcessMetricsResponse {
  usage?: {
    cpu_millicores?: number;
    memory_mb?: number;
    pods_ready?: number;
    pods_total?: number;
    restarts?: number;
  };
  resources?: {
    cpu_limit_millicores?: number;
    memory_limit_mb?: number;
    replicas?: number;
  };
  pods?: Array<{ name: string; node: string }>;
}

export function registerProcessTools(server: McpServer) {
  server.tool(
    'dailey_processes',
    'List processes defined in a project. For multi-process projects with a dailey.yaml manifest, returns each declared process (web/worker/release) with resource limits and status. For single-container projects (most Dailey OS projects), returns an empty list — use dailey_project_info and dailey_scale for resource management in that case.',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      const res = await apiRequest<{ processes: Process[] }>('GET', `/projects/${project_id}/processes`);
      if (!res.ok) return textResult(formatError(res));

      const procs = res.data.processes || [];
      if (procs.length === 0) {
        return textResult([
          'No processes manifest (dailey.yaml) found — this is a single-container project.',
          '',
          'For single-container projects:',
          '  - dailey_project_info to see current replicas/CPU/memory',
          '  - dailey_scale to change replicas',
          '  - dailey_app_logs to tail runtime logs',
          '  - dailey_app_restart to roll the deployment',
          '',
          'dailey_processes/dailey_process_* are only meaningful when a repo ships a dailey.yaml declaring multiple processes.',
        ].join('\n'));
      }

      const lines = [
        `Processes (${procs.length})`,
        `${'Name'.padEnd(20)} ${'Type'.padEnd(10)} ${'Replicas'.padEnd(9)} ${'CPU'.padEnd(8)} ${'Memory'.padEnd(10)} Status`,
        '─'.repeat(80),
      ];
      for (const p of procs) {
        lines.push(
          `${(p.name || '').padEnd(20)} ${(p.type || '-').padEnd(10)} ${String(p.replicas ?? '-').padEnd(9)} ${String(p.cpu_millicores ?? '-').padEnd(8)} ${String(p.memory_mb ?? '-').padEnd(10)} ${p.status || '-'}`,
        );
        if (p.command) lines.push(`  cmd: ${p.command}`);
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_process_logs',
    'Fetch logs for a specific process in a multi-process project.',
    {
      project_id: z.string().describe('The project ID'),
      process_name: z.string().describe('The process name (from dailey_processes)'),
      tail: z.number().int().min(1).max(2000).optional().describe('Number of log lines to fetch (default: 100)'),
    },
    async ({ project_id, process_name, tail }) => {
      const query = tail ? `?tail=${tail}` : '?tail=100';
      const res = await apiRequest<ProcessLogsResponse>(
        'GET',
        `/projects/${project_id}/processes/${encodeURIComponent(process_name)}/logs${query}`,
      );
      if (!res.ok) return textResult(formatError(res));

      const logs = res.data.logs || [];
      if (logs.length === 0) return textResult(`No logs for process ${process_name}.`);
      return textResult([`Logs for ${process_name} (last ${tail || 100} lines):`, '', ...logs].join('\n'));
    },
  );

  server.tool(
    'dailey_process_restart',
    'Restart a single process (rolling restart). Only affects the named process — other processes keep running.',
    {
      project_id: z.string().describe('The project ID'),
      process_name: z.string().describe('The process name to restart'),
    },
    async ({ project_id, process_name }) => {
      const res = await apiRequest(
        'POST',
        `/projects/${project_id}/processes/${encodeURIComponent(process_name)}/restart`,
      );
      if (!res.ok) return textResult(formatError(res));
      return textResult(`Restart initiated for process ${process_name}. Pods will roll one-by-one.`);
    },
  );

  server.tool(
    'dailey_process_metrics',
    'Get live resource usage and pod health for a process: pods ready, restarts, CPU/memory limits.',
    {
      project_id: z.string().describe('The project ID'),
      process_name: z.string().describe('The process name'),
    },
    async ({ project_id, process_name }) => {
      const res = await apiRequest<ProcessMetricsResponse>(
        'GET',
        `/projects/${project_id}/processes/${encodeURIComponent(process_name)}/metrics`,
      );
      if (!res.ok) return textResult(formatError(res));

      const usage = res.data.usage || {};
      const resources = res.data.resources || {};
      const pods = res.data.pods || [];

      const lines = [
        `Process: ${process_name}`,
        '─'.repeat(40),
        `Pods ready: ${usage.pods_ready ?? 0} / ${usage.pods_total ?? 0}`,
        `Restarts:   ${usage.restarts ?? 0}`,
        `CPU limit:  ${resources.cpu_limit_millicores ?? '-'}m`,
        `Mem limit:  ${resources.memory_limit_mb ?? '-'} MB`,
        `Replicas:   ${resources.replicas ?? '-'}`,
      ];
      if (pods.length > 0) {
        lines.push('');
        lines.push('Pods:');
        for (const pod of pods) lines.push(`  ${pod.name} on ${pod.node}`);
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_process_resources',
    'Update replicas, CPU, or memory limits for a specific process. Omit fields you do not want to change.',
    {
      project_id: z.string().describe('The project ID'),
      process_name: z.string().describe('The process name'),
      replicas: z.number().int().min(0).max(20).optional().describe('Replicas (0-20)'),
      cpu_millicores: z.number().int().min(10).max(8000).optional().describe('CPU limit in millicores (10-8000)'),
      memory_mb: z.number().int().min(64).max(32768).optional().describe('Memory limit in MB (64-32768)'),
    },
    async ({ project_id, process_name, replicas, cpu_millicores, memory_mb }) => {
      const body: Record<string, number> = {};
      if (replicas !== undefined) body.replicas = replicas;
      if (cpu_millicores !== undefined) body.cpu_millicores = cpu_millicores;
      if (memory_mb !== undefined) body.memory_mb = memory_mb;
      if (Object.keys(body).length === 0) {
        return textResult('Error: specify at least one of replicas, cpu_millicores, or memory_mb.');
      }
      const res = await apiRequest(
        'POST',
        `/projects/${project_id}/processes/${encodeURIComponent(process_name)}/resources`,
        body,
      );
      if (!res.ok) return textResult(formatError(res));
      const changed = Object.entries(body).map(([k, v]) => `${k}=${v}`).join(', ');
      return textResult(`Updated process ${process_name}: ${changed}`);
    },
  );
}
