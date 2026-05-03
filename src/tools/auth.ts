import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiRequest, formatError, textResult, jsonResult } from '../api.js';

interface UserInfo {
  id: string;
  name: string;
  email: string;
  plan?: string;
  created_at?: string;
}

const AUTH_REQUIRED_ERROR = {
  error_code: 'DAILEY_AUTH_REQUIRED',
  message: 'Not authenticated',
  remediation: 'Run `dailey auth setup` in your terminal',
  help_url: 'https://docs.dailey.cloud/auth',
};

export function registerAuthTools(server: McpServer) {
  server.tool(
    'dailey_whoami',
    'Show current user info (name, email, plan)',
    {},
    async () => {
      const res = await apiRequest<UserInfo>('GET', '/customers/me');
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return jsonResult(AUTH_REQUIRED_ERROR);
        }
        return textResult(formatError(res));
      }

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

  server.tool(
    'dailey_auth_status',
    'Check authentication status — returns whether the MCP server is authenticated and the account details if so',
    {},
    async () => {
      const res = await apiRequest<UserInfo>('GET', '/customers/me');

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return jsonResult({
            authenticated: false,
            source: null,
            recommended_action: 'Run `dailey auth setup` in your terminal',
          });
        }
        // Non-auth error — surface it but don't claim unauthenticated
        return jsonResult({
          authenticated: false,
          source: null,
          recommended_action: `API error (${res.status}) — run \`dailey auth setup\` if your token is missing or expired`,
        });
      }

      const u = res.data;

      // Infer the token source from the environment the MCP server was started with.
      // DAILEY_API_TOKEN wins; email+password means a refreshed session JWT; otherwise
      // it must be a dk_ API key set some other way.
      let source: 'api_key' | 'env_token' | 'session' = 'session';
      const envToken = process.env.DAILEY_API_TOKEN || '';
      if (envToken.startsWith('dk_')) {
        source = 'api_key';
      } else if (envToken) {
        source = 'env_token';
      } else if (process.env.DAILEY_EMAIL) {
        source = 'session';
      }

      return jsonResult({
        authenticated: true,
        source,
        account: u.name,
        email: u.email,
        recommended_action: null,
      });
    },
  );
}
