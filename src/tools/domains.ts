import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface Domain {
  domain: string;
  status?: string;
  created_at?: string;
}

export function registerDomainTools(server: McpServer) {
  server.tool(
    'dailey_domains',
    'List, add, or remove custom domains for a project',
    {
      project_id: z.string().describe('The project ID'),
      action: z.enum(['list', 'add', 'remove']).describe('Action: list, add, or remove'),
      domain: z.string().optional().describe('Domain name (required for add/remove)'),
    },
    async ({ project_id, action, domain }) => {
      if (action === 'list') {
        const res = await apiRequest<{ domains: Domain[] }>('GET', `/projects/${project_id}/domains`);
        if (!res.ok) return textResult(formatError(res));

        const domains = res.data.domains;
        if (!domains || domains.length === 0) {
          return textResult('No custom domains configured.');
        }

        const lines = [
          `Custom Domains (${domains.length})`,
          '─'.repeat(50),
        ];
        for (const d of domains) {
          lines.push(`${d.domain}${d.status ? ` (${d.status})` : ''}`);
        }
        return textResult(lines.join('\n'));
      }

      if (action === 'add') {
        if (!domain) {
          return textResult('Error: domain is required for add action.');
        }
        const res = await apiRequest('POST', `/projects/${project_id}/domains`, { domain });
        if (!res.ok) return textResult(formatError(res));
        return textResult(`Domain ${domain} added to project.`);
      }

      if (action === 'remove') {
        if (!domain) {
          return textResult('Error: domain is required for remove action.');
        }
        const res = await apiRequest('DELETE', `/projects/${project_id}/domains`, { domain });
        if (!res.ok) return textResult(formatError(res));
        return textResult(`Domain ${domain} removed from project.`);
      }

      return textResult('Error: Invalid action. Use list, add, or remove.');
    },
  );
}
