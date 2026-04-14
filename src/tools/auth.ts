import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiRequest, formatError, textResult } from '../api.js';

interface UserInfo {
  id: string;
  name: string;
  email: string;
  plan?: string;
  created_at?: string;
}

export function registerAuthTools(server: McpServer) {
  server.tool(
    'dailey_whoami',
    'Show current user info (name, email, plan)',
    {},
    async () => {
      const res = await apiRequest<UserInfo>('GET', '/customers/me');
      if (!res.ok) return textResult(formatError(res));

      const u = res.data;
      const lines = [
        `User Info`,
        `─────────────────────`,
        `ID:      ${u.id}`,
        `Name:    ${u.name}`,
        `Email:   ${u.email}`,
      ];
      if (u.plan) lines.push(`Plan:    ${u.plan}`);
      if (u.created_at) lines.push(`Created: ${u.created_at}`);
      return textResult(lines.join('\n'));
    },
  );
}
