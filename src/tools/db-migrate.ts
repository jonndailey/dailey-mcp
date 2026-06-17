import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

// MigrationRow as returned by the customer-api managed-migrations endpoints.
// callback_token_hash is never returned by the server, and we never echo the
// source password back in tool output (security hard rule).
interface MigrationRow {
  id: string;
  project_id: string;
  engine: string;
  status: string;
  phase?: string;
  message?: string;
  rows_total?: number;
  rows_copied?: number;
  target_user?: string;
  target_db?: string;
  report_json?: unknown;
  error?: string;
  dispatch_count?: number;
  created_at?: string;
  updated_at?: string;
}

interface StartResponse {
  id: string;
  status: string;
}

interface ListResponse {
  migrations: MigrationRow[];
}

interface GetResponse {
  migration: MigrationRow;
}

interface ConfirmResponse {
  id: string;
  status: string;
}

interface CancelResponse {
  id: string;
  status: string;
}

const sshSchema = z
  .object({
    host: z.string().describe('SSH bastion/tunnel host'),
    port: z.number().int().optional().describe('SSH port (default 22)'),
    user: z.string().describe('SSH user'),
    password: z.string().optional().describe('SSH password (do not echo back)'),
    private_key: z.string().optional().describe('SSH private key (PEM)'),
    passphrase: z.string().optional().describe('Passphrase for the private key'),
  })
  .passthrough();

const sourceSchema = z.object({
  host: z.string().describe('Source database host'),
  port: z.number().int().optional().describe('Source database port'),
  database: z.string().describe('Source database name'),
  user: z.string().describe('Source database user'),
  password: z.string().describe('Source database password — never echoed back in tool output'),
  ssh: sshSchema.optional().describe('Optional SSH tunnel config for reaching the source DB'),
});

function progressLines(m: MigrationRow): string[] {
  const lines = [
    `Migration ${m.id}`,
    '─'.repeat(40),
    `Status:    ${m.status || 'unknown'}`,
  ];
  if (m.phase) lines.push(`Phase:     ${m.phase}`);
  if (m.message) lines.push(`Message:   ${m.message}`);
  if (m.rows_total !== undefined && m.rows_total !== null) {
    const copied = m.rows_copied ?? 0;
    lines.push(`Rows:      ${copied}/${m.rows_total} copied`);
  } else if (m.rows_copied !== undefined && m.rows_copied !== null) {
    lines.push(`Rows:      ${m.rows_copied} copied`);
  }
  if (m.target_user) lines.push(`Target user: ${m.target_user}`);
  if (m.target_db) lines.push(`Target db:   ${m.target_db}`);
  if (m.error) lines.push(`Error:     ${m.error}`);
  if (m.report_json) {
    try {
      const parsed = typeof m.report_json === 'string' ? JSON.parse(m.report_json) : m.report_json;
      if (parsed && typeof parsed === 'object') {
        lines.push(`Report:    ${JSON.stringify(parsed)}`);
      }
    } catch {
      // report_json did not parse — skip the summary line.
    }
  }
  return lines;
}

export function registerMigrateTools(server: McpServer) {
  server.tool(
    'dailey_db_migrate_start',
    'Start a managed database migration from an external source DB into a project\'s managed database. Submits the source connection and kicks off an estimate (dry-run) — it does NOT copy data yet. The server derives the target engine from the project\'s managed DB (mysql | postgres); the source DB must be the SAME engine. Returns a migration id and status="estimating". Poll dailey_db_migrate_status until status="awaiting_confirm", review rows_total, then call dailey_db_migrate_confirm to run the real copy. The source password is used only to connect — it is never echoed back in any output.',
    {
      project: z.string().describe('The project ID (or name) to migrate INTO'),
      source: sourceSchema.describe('External source database connection details'),
      allow_non_empty: z.boolean().optional().describe('Allow migrating into a target DB that already has data'),
      row_ceiling: z.number().int().optional().describe('Optional safety cap on total rows to migrate'),
    },
    async ({ project, source, allow_non_empty, row_ceiling }) => {
      const body: Record<string, unknown> = {
        host: source.host,
        database: source.database,
        user: source.user,
        password: source.password,
      };
      if (source.port !== undefined) body.port = source.port;
      if (source.ssh !== undefined) body.ssh = source.ssh;
      if (allow_non_empty !== undefined) body.allow_non_empty = allow_non_empty;
      if (row_ceiling !== undefined) body.row_ceiling = row_ceiling;

      const res = await apiRequest<StartResponse>('POST', `/projects/${project}/migrations`, body);
      if (!res.ok) return textResult(formatError(res));

      const d = res.data;
      const lines = [
        `Migration started`,
        '─'.repeat(40),
        `ID:     ${d.id}`,
        `Status: ${d.status}`,
        '',
        `Estimating now. Poll dailey_db_migrate_status project=${project} id=${d.id} until status=awaiting_confirm,`,
        `then dailey_db_migrate_confirm to run the real copy.`,
      ];
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_db_migrate_status',
    'Check the status/progress of a managed migration. With an id, returns that migration\'s progress fields (status, phase, message, rows_total, rows_copied, target_user, target_db, error). Without an id, lists all migrations for the project. Live progress is rows_copied/rows_total. Terminal statuses are completed | failed | canceled.',
    {
      project: z.string().describe('The project ID (or name)'),
      id: z.string().optional().describe('Migration id. Omit to list all migrations for the project.'),
    },
    async ({ project, id }) => {
      if (!id) {
        const res = await apiRequest<ListResponse>('GET', `/projects/${project}/migrations`);
        if (!res.ok) return textResult(formatError(res));
        const migrations = res.data.migrations || [];
        if (migrations.length === 0) return textResult('No migrations for this project.');
        const lines = [`Migrations (${migrations.length})`, '─'.repeat(40)];
        for (const m of migrations) {
          const rows =
            m.rows_total !== undefined && m.rows_total !== null
              ? ` ${m.rows_copied ?? 0}/${m.rows_total} rows`
              : '';
          lines.push(`• ${m.id} status=${m.status}${m.phase ? ` phase=${m.phase}` : ''}${rows}`);
        }
        return textResult(lines.join('\n'));
      }

      const res = await apiRequest<GetResponse>('GET', `/projects/${project}/migrations/${id}`);
      if (!res.ok) return textResult(formatError(res));
      return textResult(progressLines(res.data.migration).join('\n'));
    },
  );

  server.tool(
    'dailey_db_migrate_confirm',
    'Confirm a managed migration that is awaiting confirmation. This triggers the REAL data copy and mints a temporary target user for the load — it is only valid from status=awaiting_confirm. Returns the id and status="queued". After confirming, poll dailey_db_migrate_status to watch rows_copied/rows_total until a terminal status (completed | failed | canceled).',
    {
      project: z.string().describe('The project ID (or name)'),
      id: z.string().describe('Migration id to confirm (must be awaiting_confirm)'),
    },
    async ({ project, id }) => {
      const res = await apiRequest<ConfirmResponse>('POST', `/projects/${project}/migrations/${id}/confirm`);
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      const lines = [
        `Migration confirmed — real data copy queued`,
        '─'.repeat(40),
        `ID:     ${d.id}`,
        `Status: ${d.status}`,
        '',
        `Poll dailey_db_migrate_status project=${project} id=${d.id} to watch progress to completion.`,
      ];
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_db_migrate_cancel',
    'Cancel a managed migration. Valid from status pending | estimating | awaiting_confirm | queued (409 otherwise). Returns the id and status="canceled".',
    {
      project: z.string().describe('The project ID (or name)'),
      id: z.string().describe('Migration id to cancel'),
    },
    async ({ project, id }) => {
      const res = await apiRequest<CancelResponse>('POST', `/projects/${project}/migrations/${id}/cancel`);
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      const lines = [
        `Migration canceled`,
        '─'.repeat(40),
        `ID:     ${d.id}`,
        `Status: ${d.status}`,
      ];
      return textResult(lines.join('\n'));
    },
  );
}
