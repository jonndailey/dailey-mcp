import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface Backup {
  key: string;
  timestamp?: string;
  size_mb?: number;
  last_modified?: string;
}

interface BackupsResponse {
  backups?: Backup[];
  total?: number;
  error?: string;
}

export function registerBackupTools(server: McpServer) {
  server.tool(
    'dailey_backups',
    'List, create, or restore backups for a project. Use before risky changes (schema migrations, major redeploys).',
    {
      project_id: z.string().describe('The project ID'),
      action: z.enum(['list', 'create', 'restore', 'download']).describe('list | create | restore | download'),
      backup_key: z.string().optional().describe('Backup key (required for restore/download)'),
    },
    async ({ project_id, action, backup_key }) => {
      if (action === 'list') {
        const res = await apiRequest<BackupsResponse>('GET', `/projects/${project_id}/backups`);
        if (!res.ok) return textResult(formatError(res));

        const backups = res.data.backups || [];
        if (backups.length === 0) {
          const err = res.data.error ? `\n\nNote: ${res.data.error}` : '';
          return textResult(`No backups found for this project.${err}`);
        }

        const lines = [
          `Backups (${backups.length})`,
          `${'Timestamp'.padEnd(24)} ${'Size'.padEnd(10)} Key`,
          '─'.repeat(90),
        ];
        for (const b of backups) {
          lines.push(`${(b.timestamp || '-').padEnd(24)} ${String((b.size_mb ?? 0) + ' MB').padEnd(10)} ${b.key}`);
        }
        lines.push('');
        lines.push('Restore with: dailey_backups action=restore backup_key=<key>');
        return textResult(lines.join('\n'));
      }

      if (action === 'create') {
        const res = await apiRequest<{ triggered?: boolean; message?: string }>(
          'POST',
          `/projects/${project_id}/backups`,
        );
        if (!res.ok) return textResult(formatError(res));
        return textResult(res.data.message || 'Backup triggered.');
      }

      if (action === 'restore') {
        if (!backup_key) return textResult('Error: backup_key is required for restore.');
        const res = await apiRequest<{ restored?: boolean; message?: string }>(
          'POST',
          `/projects/${project_id}/backups/restore`,
          { backup_key },
        );
        if (!res.ok) return textResult(formatError(res));
        return textResult(res.data.message || `Restored from ${backup_key}.`);
      }

      if (action === 'download') {
        if (!backup_key) return textResult('Error: backup_key is required for download.');
        const res = await apiRequest<{ url?: string; expires_in?: number }>(
          'GET',
          `/projects/${project_id}/backups/download?key=${encodeURIComponent(backup_key)}`,
        );
        if (!res.ok) return textResult(formatError(res));
        return textResult(`Download URL (expires in ${res.data.expires_in || 3600}s):\n${res.data.url}`);
      }

      return textResult('Invalid action. Use list, create, restore, or download.');
    },
  );
}
