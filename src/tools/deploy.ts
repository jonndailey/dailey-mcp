import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

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
    'dailey_rollback',
    'Rollback a project to a previous build',
    {
      project_id: z.string().describe('The project ID'),
      build_id: z.string().describe('The build ID to rollback to'),
    },
    async ({ project_id, build_id }) => {
      const res = await apiRequest('POST', `/projects/${project_id}/rollback`, { build_id });
      if (!res.ok) return textResult(formatError(res));
      return textResult(`Rollback initiated for project ${project_id} to build ${build_id}.`);
    },
  );
}
