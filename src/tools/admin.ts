/**
 * Admin-only tools. Gated server-side by requireAdmin (email allowlist).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, textResult, formatError } from '../api.js';

export function registerAdminTools(server: McpServer) {
  server.tool(
    'dailey_admin_onboard',
    'Admin-only. One-shot customer provisioning: registers a new customer through the same flow as public signup (Core user + customer record + namespace + NetworkPolicies), sends the welcome email, and optionally verifies login works. Bypasses the weekly self-serve signup cap. Use this for manual handoffs (acquiring a new customer, onboarding a friend, migrating from another platform). Returns the generated password in the response — save it; the response is the only place it appears in plaintext.',
    {
      email: z.string().describe('Customer email address'),
      name: z.string().describe('Customer display name'),
      plan: z.enum(['free', 'builder', 'pro', 'scale']).optional().describe('Plan tier (default: free). Can be upgraded later.'),
      password: z.string().optional().describe('Optional specific password. If omitted, a strong random one (16 base64url chars) is generated and returned.'),
    },
    async ({ email, name, plan, password }) => {
      const body: any = { email, name };
      if (plan) body.plan = plan;
      if (password) body.password = password;

      const res = await apiRequest<any>('POST', `/admin/onboard`, body);
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      if (!d.success) return textResult(`Onboard failed: ${d.error || 'unknown'}`);

      const lines = [
        `✓ ${d.name || name} onboarded`,
        `Email:       ${d.email || email}`,
        `Password:    ${d.password || '(not returned)'}`,
        `Plan:        ${d.plan || plan || 'free'}`,
        `Customer ID: ${d.customer_id || '-'}`,
        `Slug:        ${d.slug || '-'}`,
      ];
      if (d.already_existed) lines.push('', '(Account already existed — reactivated or plan updated)');
      if (d.login_verified === false) lines.push('', '⚠ Login verification failed — investigate before sharing credentials');
      return textResult(lines.join('\n'));
    },
  );
}
