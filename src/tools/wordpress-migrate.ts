import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { apiRequest, formatError, textResult, isValidProjectId, invalidProjectIdResult } from '../api.js';
import { putFileToPresignedUrl } from '../upload.js';

interface StartResponse {
  migration_id: string;
  db_upload: { url: string; key: string; headers: Record<string, string>; max_bytes: number };
  content_upload: { url: string; key: string; headers: Record<string, string>; max_bytes: number };
  warning?: string;
}
interface RunResponse { ok: boolean; migration_id: string; new_url: string }
interface StatusResponse { status: string; step?: string; error?: string; log_tail?: string; finished_at?: string }
interface ScanFinding { level: string; code: string; message: string }
interface ScanResponse { ok: boolean; verdict: 'clean' | 'warn' | 'blocked'; findings: ScanFinding[] }

export function registerWordPressMigrateTools(server: McpServer) {
  server.tool(
    'dailey_wordpress_migrate',
    'Migrate an existing WordPress site (from any host) onto Dailey OS, intact. action=migrate uploads a MySQL dump (.sql/.sql.gz) + a wp-content archive (.tar.gz/.zip) from local paths, then runs the import (DB import, serialized-safe URL rewrite, wp-content swap) and reports the final status. WARNING: replaces the target project\'s database and wp-content. action=status checks a previous migration.',
    {
      project_id: z.string().describe('Target project ID (must be a WordPress project with a MySQL DB + volume)'),
      action: z.enum(['migrate', 'status']).describe('migrate = full flow (upload + run + wait) | status = check a migration'),
      db_file: z.string().optional().describe('Local path to the MySQL dump (.sql or .sql.gz) — required for migrate'),
      content_file: z.string().optional().describe('Local path to the wp-content archive (.tar.gz/.tgz/.zip) — required for migrate'),
      old_url: z.string().optional().describe('The site\'s current URL, e.g. https://oldsite.com — required for migrate'),
      table_prefix: z.string().optional().describe('Table prefix if not wp_'),
      allow_unsafe: z.boolean().optional().describe('Proceed even if the pre-migrate scan reports a blocked verdict (non-malware only)'),
      migration_id: z.string().optional().describe('Migration ID — required for status'),
    },
    async ({ project_id, action, db_file, content_file, old_url, table_prefix, allow_unsafe, migration_id }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      if (action === 'status') {
        if (!migration_id) return textResult('migration_id is required for action=status');
        const res = await apiRequest<StatusResponse>('GET', `/projects/${project_id}/migrate/wordpress/${migration_id}`);
        if (!res.ok) return textResult(formatError(res));
        const s = res.data;
        return textResult(`Migration ${migration_id}: ${s.status}${s.step ? ` (step: ${s.step})` : ''}${s.error ? `\nError: ${s.error}` : ''}${s.log_tail ? `\n--- log ---\n${s.log_tail}` : ''}`);
      }

      // action === 'migrate'
      if (!db_file || !content_file || !old_url) {
        return textResult('db_file, content_file, and old_url are required for action=migrate');
      }
      for (const f of [db_file, content_file]) {
        if (!existsSync(f)) return textResult(`File not found: ${f}`);
      }

      const start = await apiRequest<StartResponse>('POST', `/projects/${project_id}/migrate/wordpress`, {
        db_filename: basename(db_file),
        content_filename: basename(content_file),
      });
      if (!start.ok) return textResult(formatError(start));
      const { migration_id: mid, db_upload, content_upload } = start.data;

      try {
        await putFileToPresignedUrl(db_upload.url, db_file, db_upload.headers);
        await putFileToPresignedUrl(content_upload.url, content_file, content_upload.headers);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return textResult(`Upload failed: ${message}\nMigration ${mid} is still pending — fix the file and call migrate again (a new migration will be started).`);
      }

      // Pre-migrate scan is REQUIRED server-side before /run (returns 409
      // scan_required otherwise). Without this, migrate fails at launch and
      // leaves a pending migration lock on the project.
      const scan = await apiRequest<ScanResponse>('POST', `/projects/${project_id}/migrate/wordpress/${mid}/scan`, {
        allow_unsafe: Boolean(allow_unsafe),
      });
      if (scan.status === 409) {
        const findings = (scan.data as ScanResponse | undefined)?.findings ?? [];
        const list = findings.length ? findings.map((f) => `  [${f.level}] ${f.code}: ${f.message}`).join('\n') : '  (no findings detail returned)';
        return textResult(`Refusing to run: server-side scan gate is BLOCKED.\n${list}\nMigration ${mid} is still pending — pass allow_unsafe=true to override (logged) and call migrate again.`);
      }
      if (!scan.ok) return textResult(formatError(scan));

      const run = await apiRequest<RunResponse>('POST', `/projects/${project_id}/migrate/wordpress/${mid}/run`, {
        old_url, ...(table_prefix ? { table_prefix } : {}),
      });
      if (!run.ok) return textResult(formatError(run));

      // Poll to terminal state (up to ~10 min; migrations are usually 1-3 min).
      const started = Date.now();
      let last: StatusResponse | null = null;
      while (Date.now() - started < 10 * 60 * 1000) {
        await new Promise((r) => setTimeout(r, 5000));
        const st = await apiRequest<StatusResponse>('GET', `/projects/${project_id}/migrate/wordpress/${mid}`);
        if (st.ok) {
          last = st.data;
          if (last.status === 'succeeded' || last.status === 'failed') break;
        }
      }
      if (!last) return textResult(`Migration ${mid} launched but status could not be read. Check later with action=status.`);
      if (last.status === 'succeeded') {
        return textResult(`Migration succeeded. Site is live at ${run.data.new_url} with the imported content.\nNote: hard-refresh and re-save permalinks (Settings > Permalinks) if pretty URLs 404.`);
      }
      if (last.status === 'failed') {
        return textResult(`Migration FAILED at step: ${last.step ?? 'unknown'}\n${last.error ?? ''}\n--- log ---\n${last.log_tail ?? ''}\nYour staged files were kept — fix the issue and run migrate again.`);
      }
      return textResult(`Migration ${mid} still ${last.status} (step: ${last.step ?? '-'}) after 10 min — check again with action=status migration_id=${mid}.`);
    },
  );
}
