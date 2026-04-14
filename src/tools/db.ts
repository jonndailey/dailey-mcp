import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface DatabaseInfo {
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  status?: string;
  size_mb?: number;
  type?: string;
}

interface DatabaseSchemaResponse {
  database: string;
  tables: Array<{
    name: string;
    rows: number;
    size_kb: number;
    columns: Array<{
      name: string;
      type: string;
      nullable: boolean;
      key: string;
      extra: string;
    }>;
  }>;
  total_rows: number;
  total_size_kb: number;
}

interface DatabaseQueryResponse {
  rows?: Array<Record<string, unknown>>;
  row_count?: number;
  duration_ms?: number;
  read_only?: boolean;
  auto_limited?: boolean;
  error?: string;
}

interface DatabaseMigrationsResponse {
  has_migration_table: boolean;
  total_applied: number;
  applied: Array<{ name: string; applied_at?: string }>;
}

export function registerDbTools(server: McpServer) {
  server.tool(
    'dailey_db_info',
    'Get database connection info for a project',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      const res = await apiRequest<DatabaseInfo>('GET', `/projects/${project_id}/database`);
      if (!res.ok) return textResult(formatError(res));

      const db = res.data;
      const lines = [
        `Database Info`,
        '─────────────────────────────',
        `Type:     ${db.type || 'unknown'}`,
        `Status:   ${db.status || 'unknown'}`,
        `Host:     ${db.host || '-'}`,
        `Port:     ${db.port || '-'}`,
        `Database: ${db.database || '-'}`,
        `Username: ${db.username || '-'}`,
        `Password: ${db.password || '-'}`,
      ];
      if (db.size_mb !== undefined) {
        lines.push(`Size:     ${db.size_mb} MB`);
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_db_schema',
    'Inspect the schema of a project database',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      const res = await apiRequest<DatabaseSchemaResponse>('GET', `/projects/${project_id}/database/schema`);
      if (!res.ok) return textResult(formatError(res));

      const schema = res.data;
      const lines = [
        `Schema: ${schema.database}`,
        `Tables: ${schema.tables?.length || 0}`,
        `Rows:   ${schema.total_rows || 0}`,
        `Size:   ${schema.total_size_kb || 0} KB`,
        '',
      ];

      for (const table of schema.tables || []) {
        lines.push(`${table.name} (${table.rows} rows, ${table.size_kb} KB)`);
        for (const column of table.columns || []) {
          const flags = [
            column.key ? `key=${column.key}` : null,
            column.nullable ? 'nullable' : 'required',
            column.extra || null,
          ].filter(Boolean);
          lines.push(`  - ${column.name}: ${column.type}${flags.length ? ` [${flags.join(', ')}]` : ''}`);
        }
        lines.push('');
      }

      return textResult(lines.join('\n').trimEnd());
    },
  );

  server.tool(
    'dailey_db_recall',
    'Recall records with a safe read-only SQL query',
    {
      project_id: z.string().describe('The project ID'),
      sql: z.string().describe('A read-only SQL query such as SELECT, SHOW, or DESCRIBE'),
      limit: z.number().int().min(1).max(1000).optional().describe('Auto-limit for SELECT/WITH queries without LIMIT'),
    },
    async ({ project_id, sql, limit }) => {
      const body: Record<string, unknown> = { sql };
      if (limit !== undefined) body.limit = limit;
      const res = await apiRequest<DatabaseQueryResponse>('POST', `/projects/${project_id}/database/recall`, body);
      if (!res.ok) return textResult(formatError(res));
      if (res.data.error) return textResult(`Error: ${res.data.error}`);

      const rows = res.data.rows || [];
      const lines = [
        `Read-only recall`,
        `Rows:      ${res.data.row_count || 0}`,
        `Duration:  ${res.data.duration_ms || 0}ms`,
        `Mode:      ${res.data.read_only ? 'read-only' : 'unknown'}`,
        `AutoLimit: ${res.data.auto_limited ? 'yes' : 'no'}`,
        '',
      ];

      if (rows.length === 0) {
        lines.push('No rows returned.');
      } else {
        lines.push(JSON.stringify(rows, null, 2));
      }

      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_db_migrations',
    'Show migration status for a project database',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      const res = await apiRequest<DatabaseMigrationsResponse>('GET', `/projects/${project_id}/database/migrations`);
      if (!res.ok) return textResult(formatError(res));

      if (!res.data.has_migration_table) {
        return textResult('No _migrations table found for this project.');
      }

      const lines = [
        `Migrations`,
        `Applied: ${res.data.total_applied}`,
        '',
      ];
      for (const migration of res.data.applied || []) {
        lines.push(`- ${migration.name}${migration.applied_at ? ` (${migration.applied_at})` : ''}`);
      }
      return textResult(lines.join('\n'));
    },
  );
}
