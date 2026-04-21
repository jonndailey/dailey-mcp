import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface ServiceLink {
  id: string;
  target_project_id: string;
  target_name?: string;
  target_slug?: string;
  target_status?: string;
  env_key?: string;
  url?: string;
}

export function registerLinkTools(server: McpServer) {
  server.tool(
    'dailey_service_links',
    'Manage service-to-service links. A link injects an env var pointing at another project (e.g., DATABASE_URL=http://mydb). After add/remove, redeploy to pick up env changes.',
    {
      project_id: z.string().describe('The source project ID'),
      action: z.enum(['list', 'add', 'remove']).describe('list | add | remove'),
      target_project_id: z.string().optional().describe('Target project to link to (add)'),
      env_key: z.string().optional().describe('Env var name to inject (add, optional — auto-generated from target name)'),
      link_id: z.string().optional().describe('Link ID to remove (remove)'),
    },
    async ({ project_id, action, target_project_id, env_key, link_id }) => {
      if (action === 'list') {
        const res = await apiRequest<{ links: ServiceLink[] }>('GET', `/projects/${project_id}/links`);
        if (!res.ok) return textResult(formatError(res));

        const links = res.data.links || [];
        if (links.length === 0) return textResult('No service links.');

        const lines = [
          `Service Links (${links.length})`,
          '─'.repeat(70),
        ];
        for (const l of links) {
          lines.push(`• ${l.env_key}=${l.url}  → ${l.target_name} (${l.target_slug}, ${l.target_status})`);
          lines.push(`  link_id: ${l.id}`);
        }
        return textResult(lines.join('\n'));
      }

      if (action === 'add') {
        if (!target_project_id) return textResult('Error: target_project_id is required for add.');
        const body: Record<string, string> = { target_project_id };
        if (env_key) body.env_key = env_key;
        const res = await apiRequest<any>('POST', `/projects/${project_id}/links`, body);
        if (!res.ok) return textResult(formatError(res));
        const l = res.data.link;
        return textResult([
          `Link created: ${l.env_key}=${l.url} → ${l.target_name}`,
          '',
          `Redeploy this project to pick up the new env var: dailey_deploy_multi project_id=${project_id}`,
        ].join('\n'));
      }

      if (action === 'remove') {
        if (!link_id) return textResult('Error: link_id is required for remove.');
        const res = await apiRequest('DELETE', `/projects/${project_id}/links/${link_id}`);
        if (!res.ok) return textResult(formatError(res));
        return textResult(`Link ${link_id} removed. Redeploy to reflect the env change.`);
      }

      return textResult('Invalid action. Use list, add, or remove.');
    },
  );
}
