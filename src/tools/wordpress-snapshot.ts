import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, textResult, jsonResult, formatError } from '../api.js';

interface Snapshot {
  id: string;
  created_at: string;
  kind: string;
  status: string;
  env?: string;
  reason?: string;
  label?: string | null;
  db_bytes?: number;
  uploads_bytes?: number;
  content_bytes?: number;
}

interface SnapshotsResponse {
  snapshots: Snapshot[];
}

interface SnapshotStartResponse {
  operation_id: string;
  status_url?: string;
}

interface RestorePreviewPlan {
  steps: string[];
  backupFirst?: boolean;
  sourceLabel?: string;
  targetLabel?: string;
}

interface RestorePreviewResponse {
  plan: RestorePreviewPlan;
  confirm_token: string;
}

interface RestoreExecuteResponse {
  operation_id: string;
}

interface Operation {
  id: string;
  type?: string;
  status?: string;
  current_step?: string;
  verify?: unknown;
  error?: string;
  backup_snapshot_id?: string;
  step_log?: string[];
}

interface OperationResponse {
  operation: Operation;
}

function fmtBytes(bytes?: number): string {
  if (bytes == null) return '-';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

export function registerWordPressSnapshotTools(server: McpServer) {
  server.tool(
    'dailey_wp_snapshots',
    'List WordPress snapshots for a project',
    {
      project_id: z.string().describe('The project ID'),
    },
    async ({ project_id }) => {
      const res = await apiRequest<SnapshotsResponse>('GET', `/projects/${project_id}/wp/snapshots`);
      if (!res.ok) return textResult(formatError(res));

      const snapshots = res.data.snapshots;
      if (!snapshots || snapshots.length === 0) {
        return textResult('No snapshots found for this project.');
      }

      const lines = [
        `Snapshots for project ${project_id}`,
        `${'ID'.padEnd(38)} ${'Created'.padEnd(26)} ${'Reason'.padEnd(10)} ${'Label'.padEnd(24)} ${'Status'.padEnd(12)} ${'DB'.padEnd(10)} Content`,
        '─'.repeat(115),
      ];

      for (const s of snapshots) {
        lines.push(
          `${(s.id || '').padEnd(38)} ${(s.created_at || '-').padEnd(26)} ${(s.reason || 'manual').padEnd(10)} ${((s.label ?? '').slice(0, 24) || '—').padEnd(24)} ${(s.status || '-').padEnd(12)} ${fmtBytes(s.db_bytes).padEnd(10)} ${fmtBytes(s.content_bytes ?? s.uploads_bytes)}`,
        );
      }

      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_wp_snapshot',
    'Create a snapshot (DB + uploads) of a WordPress project',
    {
      project_id: z.string().describe('The project ID'),
      label: z.string().optional().describe('Optional human label; labeled points are kept until deleted (never auto-expire)'),
    },
    async ({ project_id, label }) => {
      const res = await apiRequest<SnapshotStartResponse>('POST', `/projects/${project_id}/wp/snapshot`, label ? { label } : undefined);
      if (!res.ok) return textResult(formatError(res));

      const { operation_id } = res.data;
      return textResult(
        `Snapshot started. operation_id=${operation_id}. Poll with dailey_wp_operation_status (project_id, operation_id).`,
      );
    },
  );

  server.tool(
    'dailey_wp_restore',
    'Restore a WordPress project from a snapshot (DESTRUCTIVE — two-phase). Call WITHOUT confirm_token to get the plan; re-call WITH the returned confirm_token to execute.',
    {
      project_id: z.string().describe('The project ID'),
      snapshot_id: z.string().describe('The snapshot ID to restore'),
      confirm_token: z.string().optional().describe(
        'Token from the plan response. Omit to preview the plan; provide to execute. Bound to this project+snapshot, ~10min TTL.',
      ),
    },
    async ({ project_id, snapshot_id, confirm_token }) => {
      if (!confirm_token) {
        // Phase 1: preview
        const res = await apiRequest<RestorePreviewResponse>(
          'POST',
          `/projects/${project_id}/wp/restore/preview`,
          { snapshot_id },
        );
        if (!res.ok) return textResult(formatError(res));

        const { plan, confirm_token: token } = res.data;
        const lines: string[] = [];

        if (plan.sourceLabel || plan.targetLabel) {
          lines.push(`Restore plan: ${plan.sourceLabel ?? snapshot_id} → ${plan.targetLabel ?? 'this project'}`);
        } else {
          lines.push(`Restore plan for snapshot ${snapshot_id}:`);
        }

        if (plan.backupFirst) {
          lines.push('• Backs up the target first as a rollback point.');
        }

        if (plan.steps && plan.steps.length > 0) {
          lines.push('');
          lines.push('Steps:');
          plan.steps.forEach((step, i) => {
            lines.push(`  ${i + 1}. ${step}`);
          });
        }

        lines.push('');
        lines.push(`confirm_token: ${token}`);
        lines.push('');
        lines.push(
          'This is destructive. To proceed, re-call dailey_wp_restore with the same project_id + snapshot_id and this confirm_token.',
        );

        return textResult(lines.join('\n'));
      }

      // Phase 2: execute
      const res = await apiRequest<RestoreExecuteResponse>(
        'POST',
        `/projects/${project_id}/wp/restore`,
        { snapshot_id, confirm_token, confirmation: 'RESTORE' },
      );

      if (!res.ok) {
        if (res.status === 409) {
          return textResult('A restore is already in progress for this project.');
        }
        // 400 (expired/invalid token) — surface the message
        return textResult(formatError(res));
      }

      const { operation_id } = res.data;
      return textResult(
        `Restore started. operation_id=${operation_id}. Poll with dailey_wp_operation_status.`,
      );
    },
  );

  server.tool(
    'dailey_wp_operation_status',
    'Check the status of a WordPress snapshot/restore operation',
    {
      project_id: z.string().describe('The project ID'),
      operation_id: z.string().describe('The operation ID'),
    },
    async ({ project_id, operation_id }) => {
      const res = await apiRequest<OperationResponse>(
        'GET',
        `/projects/${project_id}/wp/operations/${operation_id}`,
      );
      if (!res.ok) return textResult(formatError(res));

      const op = res.data.operation;
      const lines: string[] = [];

      if (op.type) lines.push(`Type:                ${op.type}`);
      lines.push(`Status:              ${op.status ?? '-'}`);
      if (op.current_step) lines.push(`Current step:        ${op.current_step}`);
      if (op.verify != null) lines.push(`Verify:              ${JSON.stringify(op.verify)}`);
      if (op.error) lines.push(`Error:               ${op.error}`);
      if (op.backup_snapshot_id) lines.push(`Backup snapshot ID:  ${op.backup_snapshot_id}`);

      if (op.step_log && op.step_log.length > 0) {
        const tail = op.step_log.slice(-10);
        lines.push('');
        lines.push('Step log (last 10):');
        for (const entry of tail) {
          lines.push(`  ${entry}`);
        }
      }

      return textResult(lines.join('\n'));
    },
  );
}
