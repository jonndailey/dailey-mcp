import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

export function registerCredentialRevealTools(server: McpServer) {
  server.tool(
    'dailey_reveal_credential',
    'Reveal the actual value of a single project credential (e.g., DB_PASSWORD). Requires password re-auth for audit. Uses DAILEY_PASSWORD env var if set, otherwise provide password argument. Every reveal is logged.',
    {
      project_id: z.string().describe('The project ID'),
      key: z.string().describe('Credential key (e.g., DB_PASSWORD, WORDPRESS_ADMIN_PASSWORD)'),
      password: z.string().optional().describe('Account password for re-auth (falls back to DAILEY_PASSWORD env var)'),
    },
    async ({ project_id, key, password }) => {
      const pw = password || process.env.DAILEY_PASSWORD;
      if (!pw) {
        return textResult(
          'Error: re-auth password required. Set DAILEY_PASSWORD env var or pass password argument. Every reveal is audited.',
        );
      }

      const res = await apiRequest<{ key: string; value: string }>(
        'POST',
        `/projects/${project_id}/credentials/reveal`,
        { key, password: pw },
      );
      if (!res.ok) return textResult(formatError(res));
      return textResult(`${res.data.key}: ${res.data.value}`);
    },
  );
}
