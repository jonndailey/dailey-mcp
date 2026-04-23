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
    'List, set, set_many, or delete environment variables for a project. Use set_many to write multiple vars in a single call (one permission prompt, one Secret sync) — especially useful when an app needs 3+ build-time vars like Supabase/Vite/Next.',
    {
      project_id: z.string().describe('The project ID'),
      action: z.enum(['list', 'set', 'set_many', 'delete']).describe('Action: list, set (single), set_many (bulk), or delete'),
      key: z.string().optional().describe('Environment variable key (required for set/delete)'),
      value: z.string().optional().describe('Environment variable value (required for set)'),
      env_vars: z.record(z.string()).optional().describe('Flat object of env vars for set_many, e.g. { FOO: "bar", BAZ: "qux" }'),
    },
    async ({ project_id, action, key, value, env_vars }) => {
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

      if (action === 'set_many') {
        if (!env_vars || Object.keys(env_vars).length === 0) {
          return textResult('Error: env_vars object is required for set_many action.');
        }
        const res = await apiRequest<{ set: boolean; count: number; keys: string[] }>(
          'POST',
          `/projects/${project_id}/env`,
          { env_vars },
        );
        if (!res.ok) return textResult(formatError(res));
        const d = res.data || {} as any;
        return textResult(`Set ${d.count ?? Object.keys(env_vars).length} environment variables: ${(d.keys || Object.keys(env_vars)).join(', ')}`);
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
