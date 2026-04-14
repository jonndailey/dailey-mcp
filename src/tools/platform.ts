import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface PlatformCapability {
  id: string;
  label: string;
  status: string;
  summary: string;
  interfaces?: string[];
  details?: Record<string, unknown>;
}

interface PlatformOverview {
  project: {
    id: string;
    name: string;
    slug: string;
    status: string;
    url: string;
  };
  safety: {
    model: string;
    guarantees: string[];
    restrictions: string[];
  };
  capabilities: PlatformCapability[];
  next_step?: string;
}

export function registerPlatformTools(server: McpServer) {
  server.tool(
    'dailey_platform_info',
    'Show the safe platform capabilities available to a project',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      const res = await apiRequest<PlatformOverview>('GET', `/projects/${project_id}/platform`);
      if (!res.ok) return textResult(formatError(res));

      const data = res.data;
      const lines = [
        `Platform: ${data.project.name}`,
        `Slug:       ${data.project.slug}`,
        `Status:     ${data.project.status}`,
        `URL:        ${data.project.url}`,
        '',
        `Safety Model`,
        `Mode: ${data.safety.model}`,
      ];

      for (const line of data.safety.guarantees || []) {
        lines.push(`- ${line}`);
      }

      if ((data.safety.restrictions || []).length > 0) {
        lines.push('');
        lines.push('Restrictions');
        for (const line of data.safety.restrictions || []) {
          lines.push(`- ${line}`);
        }
      }

      lines.push('');
      lines.push('Capabilities');
      for (const capability of data.capabilities || []) {
        lines.push(`- ${capability.label} [${capability.status}]`);
        lines.push(`  ${capability.summary}`);
        if (capability.interfaces && capability.interfaces.length > 0) {
          lines.push(`  Interfaces: ${capability.interfaces.join(', ')}`);
        }
        for (const [key, value] of Object.entries(capability.details || {})) {
          if (value === null || value === undefined || value === '') continue;
          if (Array.isArray(value) && value.length === 0) continue;
          lines.push(`  ${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
        }
      }

      if (data.next_step) {
        lines.push('');
        lines.push(`Next Step: ${data.next_step}`);
      }

      return textResult(lines.join('\n'));
    },
  );
}
