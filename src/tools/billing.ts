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
    'Estimate cost impact of scaling a project to N additional replicas. Only the "scale" action is supported today — the action argument is reserved for future cost estimators (e.g., adding storage, adding a DB) and will be removed when we have one canonical estimator.',
    {
      replicas: z.number().describe('Total additional replicas to add across all projects when estimating the scale delta.'),
      action: z.enum(['scale']).optional().describe('Action to estimate. Only "scale" is implemented; omit for the default.'),
    },
    async ({ replicas, action }) => {
      const effectiveAction = action || 'scale';
      const res = await apiRequest<Record<string, unknown>>(
        'GET',
        `/billing/estimate?action=${encodeURIComponent(effectiveAction)}&replicas=${replicas}`,
      );
      if (!res.ok) return textResult(formatError(res));
      return jsonResult(res.data);
    },
  );
}
