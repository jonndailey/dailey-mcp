import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, textResult, formatError, isValidProjectId, invalidProjectIdResult } from '../api.js';

export function registerSupportTools(server: McpServer) {
  server.tool(
    'dailey_support',
    'Send a bug report to the Dailey OS support team (jonny@dailey.llc). Use this when you have diagnosed an issue that requires platform-level investigation — a build failure you cannot explain, unexpected pod behavior, database connectivity, storage errors, or anything that looks like an infrastructure problem rather than a code problem. The tool automatically collects recent build logs, pod logs, and env var keys (no values) and includes them in the report. Returns a confirmation once the report is sent.',
    {
      project_id: z.string().describe('The project ID'),
      description: z.string().describe('What is going wrong — be specific. Include what the user was trying to do, what actually happened, and any error messages or unexpected behavior you observed.'),
      error_text: z.string().optional().describe('Full error text, stack trace, or log excerpt relevant to the issue'),
      steps_tried: z.string().optional().describe('What troubleshooting steps have already been attempted'),
      severity: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Impact level: low (minor inconvenience), medium (feature broken), high (app down), critical (data loss or security). Default: medium'),
    },
    async ({ project_id, description, error_text, steps_tried, severity }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      const body: Record<string, unknown> = { description };
      if (error_text) body.error_text = error_text;
      if (steps_tried) body.steps_tried = steps_tried;
      if (severity) body.severity = severity;

      const res = await apiRequest<{ ok: boolean; message: string }>(
        'POST',
        `/projects/${project_id}/support`,
        body,
      );
      if (!res.ok) return textResult(formatError(res));

      return textResult([
        `✓ ${res.data.message}`,
        '',
        'The report includes:',
        '  • Your description and any error text provided',
        '  • Last 3 build logs (truncated)',
        '  • Recent pod logs',
        '  • Env var keys (no values)',
        '',
        'You can expect a response at the email on your account.',
      ].join('\n'));
    },
  );
}
