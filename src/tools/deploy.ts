import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult, isValidProjectId, invalidProjectIdResult } from '../api.js';

interface LogsResponse {
  logs: string[];
}

interface Build {
  id: string;
  status?: string;
  commit?: string;
  created_at?: string;
  finished_at?: string;
}

export function registerDeployTools(server: McpServer) {
  server.tool(
    'dailey_app_logs',
    'Get application pod logs',
    {
      project_id: z.string().describe('The project ID'),
      tail: z.number().optional().describe('Number of log lines to fetch (default: 100)'),
    },
    async ({ project_id, tail }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      const query = tail ? `?tail=${tail}` : '?tail=100';
      const res = await apiRequest<LogsResponse>('GET', `/projects/${project_id}/logs${query}`);
      if (!res.ok) return textResult(formatError(res));

      const logs = res.data.logs;
      if (!logs || logs.length === 0) {
        return textResult('No logs available.');
      }

      return textResult([`Logs (last ${tail || 100} lines):`, '', ...logs].join('\n'));
    },
  );

  server.tool(
    'dailey_deploy_history',
    'List recent deploys/builds for a project',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      const res = await apiRequest<{ builds: Build[] }>('GET', `/projects/${project_id}/deploys`);
      if (!res.ok) return textResult(formatError(res));

      const builds = res.data.builds;
      if (!builds || builds.length === 0) {
        return textResult('No deploys found.');
      }

      const lines = [
        `Deploy History`,
        `${'Build ID'.padEnd(38)} ${'Status'.padEnd(12)} ${'Commit'.padEnd(12)} Created`,
        '─'.repeat(90),
      ];

      for (const b of builds) {
        lines.push(
          `${(b.id || '').padEnd(38)} ${(b.status || 'unknown').padEnd(12)} ${(b.commit || '-').substring(0, 10).padEnd(12)} ${b.created_at || '-'}`,
        );
      }

      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_rollback_artifact',
    'Record the project current running immutable image before deploying. Requires all replicas ready; returns a digest eligible for exact rollback.',
    { project_id: z.string().describe('The project ID'), process_name: z.string().optional().describe('Required for multi-process projects; snapshot each process separately') },
    async ({ project_id, process_name }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      const res = await apiRequest<any>('POST', `/projects/${project_id}/rollback-artifact`, process_name ? { process_name } : {});
      if (!res.ok) return textResult(formatError(res));
      return textResult(JSON.stringify(res.data));
    },
  );

  server.tool(
    'dailey_rollback',
    'Restore a previously recorded immutable image and verify runtime readiness. Legacy build_id rollback only initiates a mutable-tag deployment and is not verified.',
    {
      project_id: z.string().describe('The project ID'),
      process_name: z.string().optional().describe('Process to restore for exact-image rollback; required for multi-process projects'),
      build_id: z.string().optional().describe('Legacy build ID; use image for verified exact rollback'),
      image: z.string().optional().describe('Full registry/repository@sha256 digest from dailey_rollback_artifact; mutually exclusive with build_id'),
    },
    async ({ project_id, build_id, image, process_name }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      if (Boolean(build_id) === Boolean(image)) return textResult('Provide exactly one of image or build_id.');
      const res = await apiRequest<any>('POST', `/projects/${project_id}/rollback`, image ? { image, ...(process_name ? { process_name } : {}) } : { build_id });
      if (!res.ok) return textResult(formatError(res));
      if (image) {
        if (res.data?.verified !== true || res.data?.image !== image) return textResult('Rollback is not verified. Inspect deployment status before retrying.');
        return textResult(`Rollback verified for project ${project_id}. Running image: ${res.data.image}. Previous image: ${res.data.previous_image}.`);
      }
      return textResult(`Legacy rollback initiated for project ${project_id} to build ${build_id}; exact digest and readiness are not verified.`);
    },
  );

  server.tool(
    'dailey_deploy_rate',
    'Check the deploy rate limit status for a project — deploys used vs. limit this hour, remaining, and minutes until the window resets. Worth calling before kicking off dailey_deploy in a debug loop or when iterating quickly, so you don\'t hit the hourly cap unexpectedly.',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      const res = await apiRequest<any>('GET', `/projects/${project_id}/deploy-rate`);
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      const pct = d.deploys_limit > 0 ? Math.round((d.deploys_used / d.deploys_limit) * 100) : 0;
      const lines = [
        `Deploy rate status`,
        `Used:      ${d.deploys_used} / ${d.deploys_limit} (${pct}%)`,
        `Remaining: ${d.deploys_remaining}`,
        `Resets in: ${d.resets_in_minutes} minute(s)`,
      ];
      if (pct >= 90) lines.push('', '⚠ approaching rate limit — consider waiting');
      return textResult(lines.join('\n'));
    },
  );
}
