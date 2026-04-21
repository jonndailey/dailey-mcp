import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface Build {
  id: string;
  status?: string;
  started_at?: string;
  finished_at?: string;
  commit_sha?: string;
}

interface BuildRow {
  id: string;
  status: string;
  log?: string;
  started_at?: string;
  finished_at?: string;
  commit_sha?: string;
}

export function registerBuildLogsTools(server: McpServer) {
  server.tool(
    'dailey_build_logs',
    'Fetch the full build log for a specific build (or the most recent build if build_id is omitted). Use this after a deploy fails to see the actual compiler/Docker output.',
    {
      project_id: z.string().describe('The project ID'),
      build_id: z.string().optional().describe('Specific build ID (defaults to the most recent build for the project)'),
      tail: z.number().int().min(1).max(5000).optional().describe('Return only the last N lines (default: full log)'),
    },
    async ({ project_id, build_id, tail }) => {
      let targetBuildId = build_id;

      if (!targetBuildId) {
        const historyRes = await apiRequest<{ builds: Build[] }>('GET', `/projects/${project_id}/deploys`);
        if (!historyRes.ok) return textResult(formatError(historyRes));
        const builds = historyRes.data.builds || [];
        if (builds.length === 0) {
          return textResult('No builds found for this project.');
        }
        targetBuildId = builds[0].id;
      }

      const buildRes = await apiRequest<BuildRow>('GET', `/builds/${targetBuildId}`);
      if (!buildRes.ok) return textResult(formatError(buildRes));

      const build = buildRes.data;
      const log = build.log || '';
      const allLines = log.split('\n');
      const shown = tail ? allLines.slice(-tail) : allLines;

      const header = [
        `Build ${build.id}`,
        `Status:   ${build.status || 'unknown'}`,
        `Commit:   ${build.commit_sha || '-'}`,
        `Started:  ${build.started_at || '-'}`,
        `Finished: ${build.finished_at || '-'}`,
        `Lines:    ${allLines.length}${tail ? ` (showing last ${Math.min(tail, allLines.length)})` : ''}`,
        '─'.repeat(60),
      ];

      return textResult([...header, ...shown].join('\n'));
    },
  );
}
