import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface ResourceConfigResponse {
  cpu?: number;
  memory_mb?: number;
  storage_gb?: number;
  replicas?: number;
  project?: {
    cpu_request?: string;
    cpu_limit?: string;
    memory_request?: string;
    memory_limit?: string;
    storage_limit?: string;
    replicas?: number;
  };
  pool?: {
    plan?: string;
    cpu_total?: number;
    cpu_used?: number;
    memory_total_mb?: number;
    memory_used_mb?: number;
    storage_total_gb?: number;
    storage_used_gb?: number;
  };
}

export function registerResourceConfigTools(server: McpServer) {
  server.tool(
    'dailey_resource_config',
    'Get or set CPU/memory/storage limits for a project. Pool shows remaining plan capacity.',
    {
      project_id: z.string().describe('The project ID'),
      action: z.enum(['get', 'set']).describe('get | set'),
      cpu: z.number().optional().describe('CPU cores (e.g., 0.5, 1, 2). Used by set.'),
      memory_mb: z.number().int().optional().describe('Memory in MB. Used by set.'),
      storage_gb: z.number().optional().describe('Storage in GB. Used by set.'),
      replicas: z.number().int().min(0).max(20).optional().describe('Replicas. Used by set.'),
    },
    async ({ project_id, action, cpu, memory_mb, storage_gb, replicas }) => {
      if (action === 'get') {
        const res = await apiRequest<ResourceConfigResponse>('GET', `/projects/${project_id}/resource-config`);
        if (!res.ok) return textResult(formatError(res));

        const d = res.data;
        const proj = d.project || {};
        const pool = d.pool || {};

        const lines = [
          `Resource config for project ${project_id}`,
          '─'.repeat(50),
          `CPU:      ${d.cpu ?? 0} cores  (limit: ${proj.cpu_limit || '-'}, request: ${proj.cpu_request || '-'})`,
          `Memory:   ${d.memory_mb ?? 0} MB  (limit: ${proj.memory_limit || '-'}, request: ${proj.memory_request || '-'})`,
          `Storage:  ${d.storage_gb ?? 0} GB  (limit: ${proj.storage_limit || '-'})`,
          `Replicas: ${d.replicas ?? 1}`,
          '',
          `Plan: ${pool.plan || 'unknown'}`,
          `CPU pool:     ${pool.cpu_used ?? 0}/${pool.cpu_total ?? 0} cores used`,
          `Memory pool:  ${pool.memory_used_mb ?? 0}/${pool.memory_total_mb ?? 0} MB used`,
          `Storage pool: ${pool.storage_used_gb ?? 0}/${pool.storage_total_gb ?? 0} GB used`,
        ];
        return textResult(lines.join('\n'));
      }

      if (action === 'set') {
        const body: Record<string, number> = {};
        if (cpu !== undefined) body.cpu = cpu;
        if (memory_mb !== undefined) body.memory_mb = memory_mb;
        if (storage_gb !== undefined) body.storage_gb = storage_gb;
        if (replicas !== undefined) body.replicas = replicas;
        if (Object.keys(body).length === 0) {
          return textResult('Error: specify at least one of cpu, memory_mb, storage_gb, replicas.');
        }
        const res = await apiRequest('PUT', `/projects/${project_id}/resource-config`, body);
        if (!res.ok) return textResult(formatError(res));
        const changed = Object.entries(body).map(([k, v]) => `${k}=${v}`).join(', ');
        return textResult(`Resource config updated: ${changed}.\n\nChanges take effect on the next deploy (or use dailey_process_restart).`);
      }

      return textResult('Invalid action. Use get or set.');
    },
  );
}
