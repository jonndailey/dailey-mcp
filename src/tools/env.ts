import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface EnvVar {
  key: string;
  updated_at?: string;
}

export function registerEnvTools(server: McpServer) {
  server.tool(
    'dailey_env_vars',
    'List, set, or delete environment variables for a project',
    {
      project_id: z.string().describe('The project ID'),
      action: z.enum(['list', 'set', 'delete']).describe('Action: list, set, or delete'),
      key: z.string().optional().describe('Environment variable key (required for set/delete)'),
      value: z.string().optional().describe('Environment variable value (required for set)'),
    },
    async ({ project_id, action, key, value }) => {
      if (action === 'list') {
        const res = await apiRequest<{ env_vars: EnvVar[] }>('GET', `/projects/${project_id}/env`);
        if (!res.ok) return textResult(formatError(res));

        const vars = res.data.env_vars;
        if (!vars || vars.length === 0) {
          return textResult('No environment variables set.');
        }

        const lines = [
          `Environment Variables (${vars.length})`,
          '─'.repeat(60),
        ];
        for (const v of vars) {
          lines.push(`${v.key}${v.updated_at ? `  updated=${v.updated_at}` : ''}`);
        }
        lines.push('');
        lines.push('Values stay hidden here by design. Use the env set/delete actions to manage them safely.');
        return textResult(lines.join('\n'));
      }

      if (action === 'set') {
        if (!key || value === undefined) {
          return textResult('Error: key and value are required for set action.');
        }
        // Try PUT first (update), fall back to POST (create)
        const putRes = await apiRequest('PUT', `/projects/${project_id}/env/${encodeURIComponent(key)}`, { value });
        if (putRes.ok) {
          return textResult(`Environment variable ${key} updated.`);
        }
        // If PUT fails (var doesn't exist yet), try POST
        const postRes = await apiRequest('POST', `/projects/${project_id}/env`, { key, value });
        if (!postRes.ok) return textResult(formatError(postRes));
        return textResult(`Environment variable ${key} set.`);
      }

      if (action === 'delete') {
        if (!key) {
          return textResult('Error: key is required for delete action.');
        }
        const res = await apiRequest('DELETE', `/projects/${project_id}/env/${encodeURIComponent(key)}`);
        if (!res.ok) return textResult(formatError(res));
        return textResult(`Environment variable ${key} deleted.`);
      }

      return textResult('Error: Invalid action. Use list, set, or delete.');
    },
  );
}
