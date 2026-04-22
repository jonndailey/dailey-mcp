import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface ScaleResponse {
  scaled?: boolean;
  replicas?: number;
  warning?: string;
}

export function registerScaleTools(server: McpServer) {
  server.tool(
    'dailey_scale',
    'Scale project replicas up or down. Surfaces warnings if the DB updated but k8s did not apply (e.g., deployment missing).',
    {
      project_id: z.string().describe('The project ID'),
      replicas: z.number().describe('Number of replicas to scale to'),
    },
    async ({ project_id, replicas }) => {
      const res = await apiRequest<ScaleResponse>('POST', `/projects/${project_id}/scale`, { replicas });
      if (!res.ok) return textResult(formatError(res));

      const lines = [`Project ${project_id} scaled to ${replicas} replica(s).`];
      if (res.data?.warning) {
        lines.push('');
        lines.push(`⚠ Warning: ${res.data.warning}`);
        lines.push('');
        lines.push('Next steps: check dailey_project_resources to see if pods are actually running. If the deployment is missing, trigger a redeploy.');
      }
      return textResult(lines.join('\n'));
    },
  );
}
