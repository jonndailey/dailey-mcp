import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult, jsonResult } from '../api.js';

export function registerBillingTools(server: McpServer) {
  server.tool(
    'dailey_billing',
    'Get current billing info and resource usage',
    {},
    async () => {
      const res = await apiRequest<Record<string, unknown>>('GET', '/billing');
      if (!res.ok) return textResult(formatError(res));
      return jsonResult(res.data);
    },
  );

  server.tool(
    'dailey_billing_estimate',
    'Estimate cost for scaling actions',
    {
      action: z.string().describe('Action to estimate (e.g., "scale")'),
      replicas: z.number().describe('Number of replicas'),
    },
    async ({ action, replicas }) => {
      const res = await apiRequest<Record<string, unknown>>(
        'GET',
        `/billing/estimate?action=${encodeURIComponent(action)}&replicas=${replicas}`,
      );
      if (!res.ok) return textResult(formatError(res));
      return jsonResult(res.data);
    },
  );
}
