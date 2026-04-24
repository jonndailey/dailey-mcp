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
    'Recall records with a safe read-only SQL query (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH). Mutating SQL (INSERT / UPDATE / DELETE / DDL) is rejected by the server. For writes, use the `dailey db import` CLI command — invoke `dailey_cli_suggest_import` to construct it. For ad-hoc DBA work, use `dailey db connect`.',
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
    'dailey_db_validate',
    'Validate a SQL migration BEFORE deploying it. Catches security issues (SQL injection vectors, privilege escalation, system catalog access) and semantic issues (CREATE TABLE without IF NOT EXISTS when table exists, ALTER ADD COLUMN when column already exists).',
    {
      project_id: z.string().describe('The project ID'),
      sql: z.string().describe('SQL migration to validate (can contain multiple statements separated by ;)'),
    },
    async ({ project_id, sql }) => {
      const res = await apiRequest<any>('POST', `/projects/${project_id}/database/validate`, { sql });
      if (!res.ok) return textResult(formatError(res));

      const d = res.data;
      const lines = [
        `Migration validation`,
        '─'.repeat(40),
        `Valid:    ${d.valid ? '✓' : '✗'}`,
        `Warnings: ${d.has_warnings ? 'yes' : 'no'}`,
        `Summary:  ${d.summary || '-'}`,
      ];

      if (d.statements?.length) {
        lines.push('');
        lines.push('Statements:');
        for (const s of d.statements) {
          const marker = s.valid ? (s.warning ? '⚠' : '✓') : '✗';
          lines.push(`  ${marker} ${s.sql}${s.sql.length >= 80 ? '...' : ''}`);
          if (s.error) lines.push(`     error: ${s.error}`);
          if (s.warning) lines.push(`     warn:  ${s.warning}`);
          if (s.info) lines.push(`     info:  ${s.info}`);
        }
      }

      if (d.errors?.length) {
        lines.push('');
        lines.push('Errors:');
        for (const e of d.errors) lines.push(`  ✗ ${e}`);
      }

      if (d.warnings?.length) {
        lines.push('');
        lines.push('Warnings:');
        for (const w of d.warnings) lines.push(`  ⚠ ${w}`);
      }

      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_db_tunnel',
    'Open, close, or list short-lived database tunnel sessions. A tunnel issues a per-session MySQL/Postgres user for GUI access (e.g., TablePlus, DBeaver). Sessions auto-expire after ~1 hour. IMPORTANT: the tunnel host is a Tailscale CGNAT IP (100.x.x.x) — the client machine must be on the Dailey Tailnet. If not, the connection will time out with no useful error. For data loads that do not require GUI access, prefer `dailey db import` (see `dailey_cli_suggest_import`).',
    {
      project_id: z.string().describe('The project ID'),
      action: z.enum(['open', 'close', 'list']).describe('open | close | list'),
      session_id: z.string().optional().describe('Session ID to close (required for close)'),
    },
    async ({ project_id, action, session_id }) => {
      if (action === 'open') {
        const res = await apiRequest<any>('POST', `/projects/${project_id}/database/tunnel`);
        if (!res.ok) return textResult(formatError(res));
        const d = res.data;
        const isTailnetHost = typeof d.host === 'string' && /^100\./.test(d.host);
        const lines = [
          `Database tunnel opened`,
          '─'.repeat(40),
          `Session ID: ${d.session_id}`,
          `Engine:     ${d.engine}`,
          `Host:       ${d.host}:${d.port}`,
          `Database:   ${d.database}`,
          `Username:   ${d.username}`,
          `Password:   ${d.password}`,
          `Expires at: ${d.expires_at} (${d.ttl_seconds}s)`,
          '',
          `${d.message}`,
        ];
        if (isTailnetHost) {
          lines.push('');
          lines.push('⚠  PREFLIGHT — Tailnet required:');
          lines.push(`   The host ${d.host} is a Tailscale CGNAT address. Verify your client is on`);
          lines.push(`   the Dailey Tailnet before connecting, otherwise your client will hang on`);
          lines.push(`   connect. Quick check from the client: "tailscale status" should list`);
          lines.push(`   an active node, and "ping ${d.host}" should respond.`);
          lines.push('');
          lines.push('   If the client can NOT be put on the Tailnet, use `dailey db import` for');
          lines.push('   bulk data loads (JSON/CSV) or `dailey db recall` for read-only SELECTs —');
          lines.push('   both route through the public API and do not require Tailscale.');
        }
        lines.push('');
        lines.push(`Close with: dailey_db_tunnel action=close session_id=${d.session_id}`);
        return textResult(lines.join('\n'));
      }

      if (action === 'close') {
        if (!session_id) return textResult('Error: session_id is required to close.');
        const res = await apiRequest(
          'DELETE',
          `/projects/${project_id}/database/tunnel/${encodeURIComponent(session_id)}`,
        );
        if (!res.ok) return textResult(formatError(res));
        return textResult(`Tunnel session ${session_id} closed.`);
      }

      if (action === 'list') {
        const res = await apiRequest<{ sessions: any[] }>('GET', `/projects/${project_id}/database/tunnel`);
        if (!res.ok) return textResult(formatError(res));
        const sessions = res.data.sessions || [];
        if (sessions.length === 0) return textResult('No active tunnel sessions.');
        const lines = [`Active tunnel sessions (${sessions.length})`, '─'.repeat(40)];
        for (const s of sessions) {
          lines.push(`• ${s.sessionId} engine=${s.engine} expires=${new Date(s.expiresAt).toISOString()}`);
        }
        return textResult(lines.join('\n'));
      }

      return textResult('Invalid action. Use open, close, or list.');
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

  server.tool(
    'dailey_db_exec',
    'Execute write SQL (DDL/DML) against a project database — CREATE TABLE, ALTER, INSERT, UPDATE, etc. Runs all statements in a single transaction as a short-lived exec user, then drops the user. Works for both MySQL and Postgres (engine auto-detected). Refuses forbidden statements (DROP DATABASE, GRANT, CREATE USER, ATTACH, etc.). If the SQL contains destructive statements (DROP TABLE, TRUNCATE, DELETE without WHERE), set confirm=true to acknowledge. The endpoint writes every invocation to the exec_audit table. After running DDL, you may want to call dailey_db_schema to see the new shape.',
    {
      project_id: z.string().describe('The project ID'),
      sql: z.string().describe('One or more SQL statements separated by ";". Can include CREATE/ALTER/DROP TABLE, INSERT, UPDATE, DELETE, CREATE INDEX, etc. Transactions are automatic.'),
      confirm: z.boolean().optional().describe('Required (true) when sql contains destructive statements like DROP TABLE, TRUNCATE, or DELETE without WHERE. First call without confirm to see the destructive list; re-call with confirm=true to execute.'),
    },
    async ({ project_id, sql, confirm }) => {
      const res = await apiRequest<any>('POST', `/projects/${project_id}/database/exec`, {
        sql,
        confirm: !!confirm,
      });

      if (!res.ok) {
        const body: any = res.data;
        const lines = [formatError(res)];
        if (body?.forbidden?.length) {
          lines.push('', 'Forbidden statements (will never be allowed):');
          for (const f of body.forbidden) lines.push(`  • ${f}`);
        }
        if (body?.destructive?.length) {
          lines.push('', 'Destructive statements detected — re-call with confirm=true to proceed:');
          for (const d of body.destructive) lines.push(`  • ${d}`);
        }
        return textResult(lines.join('\n'));
      }

      const d = res.data;
      const lines = [
        `Execution: ${d.committed ? 'COMMITTED ✓' : (d.phase || 'unknown')}`,
        `Engine:   ${d.engine || 'unknown'}`,
        `Database: ${d.database || 'unknown'}`,
        `Statements: ${d.statement_count ?? (d.results?.length ?? 0)}`,
      ];
      if (d.destructive?.length) {
        lines.push('');
        lines.push('Destructive statements applied:');
        for (const s of d.destructive) lines.push(`  • ${s}`);
      }
      if (d.results?.length) {
        lines.push('');
        lines.push('Per-statement results:');
        for (const r of d.results) {
          if (typeof r.rows === 'number') lines.push(`  ✓ ${r.rows} row(s) returned`);
          else if (typeof r.affected === 'number') lines.push(`  ✓ ${r.affected} row(s) affected`);
          else lines.push(`  ✓ ok`);
        }
      }
      return textResult(lines.join('\n'));
    },
  );
}
