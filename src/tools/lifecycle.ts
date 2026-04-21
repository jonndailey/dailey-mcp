import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface PauseResponse {
  paused?: boolean;
  already_paused?: boolean;
  scaled?: Array<{ process: string; deployment: string }>;
  failures?: Array<{ process: string; deployment: string; error: string }>;
}

interface ResumeResponse {
  resumed?: boolean;
  already_running?: boolean;
  scaled?: Array<{ process: string; deployment: string; replicas: number }>;
  failures?: Array<{ process: string; deployment: string; error: string }>;
}

export function registerLifecycleTools(server: McpServer) {
  server.tool(
    'dailey_pause',
    'Pause a project — scales all processes to 0 replicas but preserves DB, storage, ingress, and the desired replica count. Use this instead of dailey_scale 0 when you want to temporarily stop a project without losing config.',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      const res = await apiRequest<PauseResponse>('POST', `/projects/${project_id}/pause`);
      if (!res.ok) return textResult(formatError(res));

      const data = res.data;
      if (data.already_paused) return textResult('Project was already paused.');

      const scaled = data.scaled || [];
      const failures = data.failures || [];
      const lines = [
        `Project ${project_id} paused.`,
        `Scaled to zero: ${scaled.length} process(es).`,
      ];
      for (const s of scaled) lines.push(`  • ${s.process} (${s.deployment})`);
      if (failures.length) {
        lines.push('');
        lines.push(`⚠ ${failures.length} failure(s):`);
        for (const f of failures) lines.push(`  ✗ ${f.process}: ${f.error}`);
      }
      lines.push('');
      lines.push('Resume later with: dailey_resume project_id=' + project_id);
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_resume',
    'Resume a paused project — scales processes back to their previous replica count.',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      const res = await apiRequest<ResumeResponse>('POST', `/projects/${project_id}/resume`);
      if (!res.ok) return textResult(formatError(res));

      const data = res.data;
      if (data.already_running) return textResult('Project was already running.');

      const scaled = data.scaled || [];
      const failures = data.failures || [];
      const lines = [
        `Project ${project_id} resumed.`,
        `Scaled up: ${scaled.length} process(es).`,
      ];
      for (const s of scaled) lines.push(`  • ${s.process} → ${s.replicas} replica(s)`);
      if (failures.length) {
        lines.push('');
        lines.push(`⚠ ${failures.length} failure(s):`);
        for (const f of failures) lines.push(`  ✗ ${f.process}: ${f.error}`);
      }
      return textResult(lines.join('\n'));
    },
  );
}
