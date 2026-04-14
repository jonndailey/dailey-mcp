import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult, jsonResult } from '../api.js';

export function registerUsageTools(server: McpServer) {
  server.tool(
    'dailey_usage',
    'Get resource usage stats for a project',
    {
      project_id: z.string().describe('The project ID'),
      period: z.string().optional().describe('Time period (e.g., 7d, 30d). Default: 7d'),
    },
    async ({ project_id, period }) => {
      const query = `?period=${period || '7d'}`;
      const res = await apiRequest<Record<string, unknown>>('GET', `/projects/${project_id}/usage${query}`);
      if (!res.ok) return textResult(formatError(res));
      return jsonResult(res.data);
    },
  );
}
