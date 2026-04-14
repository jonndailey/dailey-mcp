import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

export function registerScaleTools(server: McpServer) {
  server.tool(
    'dailey_scale',
    'Scale project replicas up or down',
    {
      project_id: z.string().describe('The project ID'),
      replicas: z.number().describe('Number of replicas to scale to'),
    },
    async ({ project_id, replicas }) => {
      const res = await apiRequest('POST', `/projects/${project_id}/scale`, { replicas });
      if (!res.ok) return textResult(formatError(res));
      return textResult(`Project ${project_id} scaled to ${replicas} replica(s).`);
    },
  );
}
