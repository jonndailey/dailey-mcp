import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface AiInfoResponse {
  project: { id: string; slug: string };
  ai: {
    enabled: boolean; account_allowed: boolean; env_injected: boolean;
    tiers: string[]; base_url: string; env_vars: string[]; enable_with: string | null;
  };
  compute: {
    enabled: boolean; account_allowed: boolean; env_injected: boolean;
    base_url: string; transcribe_url: string; env_vars: string[]; enable_with: string | null;
  };
  integration: { ai: string; compute: string };
  warnings: string[];
  docs_url: string;
}

export function registerAiTools(server: McpServer) {
  server.tool(
    'dailey_ai_info',
    'Show whether Dailey AI and Dailey Compute (GPU) are enabled for a project, whether their env vars are injected into the pod, and how to wire them up (the DAILEY_AI_*/DAILEY_COMPUTE_* env contract + integration snippets). Use this to see if Compute/AI is on or off for an app and how to implement the patterns. Enable with dailey_ai_enable / dailey_compute_enable.',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      const res = await apiRequest<AiInfoResponse>('GET', `/projects/${project_id}/ai/info`);
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      const onoff = (b: boolean) => (b ? 'ON' : 'off');
      const gateNote = (enabled: boolean, allowed: boolean) =>
        enabled ? '' : (allowed ? '  (account allows it — enable per-project)' : '  (NOT allowed on this account/plan)');
      const lines = [
        `AI + Compute wiring: ${d.project.slug}`,
        '',
        `Dailey AI:       ${onoff(d.ai.enabled)}${gateNote(d.ai.enabled, d.ai.account_allowed)}`,
        `  env injected:  ${d.ai.env_injected ? 'yes' : 'no'}`,
        `  tiers:         ${d.ai.tiers.join(', ')}`,
        `  base url:      ${d.ai.base_url}`,
        `  env vars:      ${d.ai.env_vars.join(', ')}`,
        ...(d.ai.enable_with ? [`  enable:        ${d.ai.enable_with}  (or dailey_ai_enable)`] : []),
        '',
        `Dailey Compute:  ${onoff(d.compute.enabled)}${gateNote(d.compute.enabled, d.compute.account_allowed)}`,
        `  env injected:  ${d.compute.env_injected ? 'yes' : 'no'}`,
        `  transcribe:    ${d.compute.transcribe_url}`,
        `  env vars:      ${d.compute.env_vars.join(', ')}`,
        ...(d.compute.enable_with ? [`  enable:        ${d.compute.enable_with}  (or dailey_compute_enable)`] : []),
        '',
        'Integration patterns:',
        `  AI (OpenAI-compatible): ${d.integration.ai}`,
        `  Compute (transcribe):   ${d.integration.compute}`,
      ];
      if (d.warnings && d.warnings.length) {
        lines.push('');
        for (const w of d.warnings) lines.push(`⚠ ${w}`);
      }
      lines.push('', `Docs: ${d.docs_url}`);
      lines.push('Note: injected env applies on the NEXT deploy — redeploy after enabling.');
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_ai_enable',
    'Enable Dailey AI for a project. Mints a capability-scoped key and injects DAILEY_AI_BASE_URL/KEY/MODEL into the project env (applies on next deploy). The account-level AI feature must be on first; check dailey_ai_info.',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      const res = await apiRequest('POST', `/projects/${project_id}/ai/enable`, {});
      if (!res.ok) return textResult(formatError(res));
      return textResult(`Dailey AI enabled.\n${JSON.stringify(res.data, null, 2)}\n\nRedeploy the project (dailey_deploy) to pick up the DAILEY_AI_* env vars.`);
    },
  );

  server.tool(
    'dailey_compute_enable',
    'Enable Dailey Compute (GPU) for a project. Mints a capability-scoped key and injects DAILEY_COMPUTE_URL/KEY into the project env (applies on next deploy). The account-level Compute feature must be on first; check dailey_ai_info.',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      const res = await apiRequest('POST', `/projects/${project_id}/compute/enable`, {});
      if (!res.ok) return textResult(formatError(res));
      return textResult(`Dailey Compute enabled.\n${JSON.stringify(res.data, null, 2)}\n\nRedeploy the project (dailey_deploy) to pick up the DAILEY_COMPUTE_* env vars.`);
    },
  );
}
