import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { analyze, stage, type BundleReport } from '@daileyos/wp-bundle';
import { apiRequest, formatError, textResult } from '../api.js';
import { putFileToPresignedUrl } from '../upload.js';

// Client-side preflight cap for `analyze`, before any project/plan is known.
// The server enforces the customer's real plan limit once a target project
// exists (customer-api upload-staging.ts: ABSOLUTE_MAX_UPLOAD_BYTES = 2 GiB) —
// this mirrors that ceiling so an oversized bundle is flagged early rather
// than only after staging + upload.
const PLAN_UPLOAD_CAP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

interface ProvisionResponse {
  ok: boolean;
  project_id: string;
  slug: string;
  new_url: string;
  ready: boolean;
  note: string;
}
interface StartResponse {
  migration_id: string;
  db_upload: { url: string; key: string; headers: Record<string, string>; max_bytes: number };
  content_upload: { url: string; key: string; headers: Record<string, string>; max_bytes: number };
  warning?: string;
}
interface ScanFinding { level: string; code: string; message: string }
interface ScanResponse { ok: boolean; verdict: 'clean' | 'warn' | 'blocked'; findings: ScanFinding[] }
interface RunResponse { ok: boolean; migration_id: string; new_url: string }
interface StatusResponse { status: string; step?: string; error?: string; log_tail?: string; finished_at?: string }

function formatReport(report: BundleReport): string {
  const findings = report.findings.length
    ? report.findings.map((f) => `  [${f.level}] ${f.code}: ${f.message}${f.detail ? ` (${f.detail})` : ''}`).join('\n')
    : '  (none)';
  return [
    `Bundle format: ${report.format}`,
    `Source URL: ${report.source.old_url}`,
    `DB size: ${report.sizes.db_bytes} bytes, wp-content: ${report.sizes.wp_content_bytes} bytes (${report.sizes.file_count} files)`,
    `Verdict: ${report.verdict}`,
    'Findings:',
    findings,
  ].join('\n');
}

export function registerWordPressImportTools(server: McpServer) {
  server.tool(
    'dailey_wordpress_import',
    'Analyze and migrate a WordPress bundle export (Local by Flywheel .zip, All-in-One WP Migration .wpress, or Duplicator archive) onto Dailey OS. action=analyze reads the bundle locally (no upload) and returns a BundleReport — format, detected source config, sizes, findings, verdict. action=migrate auto-provisions a hardened+quarantined WordPress target when project_id is omitted, stages the bundle, uploads the DB + wp-content, runs the pre-migrate scan gate (refuses on a blocked verdict unless allow_unsafe=true — logged), then runs the import and polls to completion. WARNING: migrate replaces the target project\'s database and wp-content; requires confirm=true. action=status checks a previous migration.',
    {
      action: z.enum(['analyze', 'migrate', 'status']).describe('analyze = read-only bundle report | migrate = full flow (provision/stage/upload/scan/run/poll) | status = check a migration'),
      bundle_file: z.string().optional().describe('Local path to the bundle (.zip/.wpress) — required for analyze and migrate'),
      project_id: z.string().optional().describe('Existing WordPress project to migrate into — omit to auto-provision a new target; required for action=status'),
      confirm: z.boolean().optional().describe('Must be true to run action=migrate (destructive: replaces DB + wp-content)'),
      allow_unsafe: z.boolean().optional().describe('Proceed despite a blocked verdict, whether found client-side (analyze) or by the server-side scan gate — the override is logged'),
      migration_id: z.string().optional().describe('Migration ID — required for action=status'),
    },
    async ({ action, bundle_file, project_id, confirm, allow_unsafe, migration_id }) => {
      if (action === 'status') {
        if (!project_id || !migration_id) return textResult('project_id and migration_id are required for action=status');
        const res = await apiRequest<StatusResponse>('GET', `/projects/${project_id}/migrate/wordpress/${migration_id}`);
        if (!res.ok) return textResult(formatError(res));
        const s = res.data;
        return textResult(`Migration ${migration_id}: ${s.status}${s.step ? ` (step: ${s.step})` : ''}${s.error ? `\nError: ${s.error}` : ''}${s.log_tail ? `\n--- log ---\n${s.log_tail}` : ''}`);
      }

      if (!bundle_file) return textResult(`bundle_file is required for action=${action}`);
      if (!existsSync(bundle_file)) return textResult(`File not found: ${bundle_file}`);

      let report: BundleReport;
      try {
        report = await analyze(bundle_file, { planUploadCapBytes: PLAN_UPLOAD_CAP_BYTES });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return textResult(`Failed to analyze bundle: ${message}`);
      }

      if (action === 'analyze') {
        return textResult(formatReport(report));
      }

      // action === 'migrate'
      if (!confirm) {
        return textResult(`Refusing to migrate without confirm=true (this replaces the target's database and wp-content).\n\n${formatReport(report)}`);
      }
      if (report.verdict === 'blocked' && !allow_unsafe) {
        return textResult(`Refusing to migrate: bundle analysis verdict is BLOCKED. Pass allow_unsafe=true to override (logged) if you understand the risk.\n\n${formatReport(report)}`);
      }
      if (report.verdict === 'blocked' && allow_unsafe) {
        console.error(`[dailey_wordpress_import] proceeding past a BLOCKED analyze() verdict for ${bundle_file} (allow_unsafe=true)`);
      }

      let targetProjectId = project_id;
      if (!targetProjectId) {
        const provision = await apiRequest<ProvisionResponse>('POST', '/projects/wordpress/provision-target', {
          old_url: report.source.old_url,
        });
        if (!provision.ok) return textResult(formatError(provision));
        targetProjectId = provision.data.project_id;
      }

      const tmpDir = mkdtempSync(join(tmpdir(), 'dailey-wp-import-'));
      let staged: Awaited<ReturnType<typeof stage>> | undefined;
      try {
        try {
          staged = await stage(bundle_file, tmpDir, { gzipDb: true });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          return textResult(`Failed to stage bundle: ${message}`);
        }

        const start = await apiRequest<StartResponse>('POST', `/projects/${targetProjectId}/migrate/wordpress`, {
          db_filename: basename(staged.dbFile),
          content_filename: basename(staged.contentFile),
        });
        if (!start.ok) return textResult(formatError(start));
        const { migration_id: mid, db_upload, content_upload } = start.data;

        try {
          await putFileToPresignedUrl(db_upload.url, staged.dbFile, db_upload.headers);
          await putFileToPresignedUrl(content_upload.url, staged.contentFile, content_upload.headers);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          return textResult(`Upload failed: ${message}\nMigration ${mid} is still pending on project ${targetProjectId} — fix the file and call migrate again (a new migration will be started).`);
        }

        const scan = await apiRequest<ScanResponse>('POST', `/projects/${targetProjectId}/migrate/wordpress/${mid}/scan`, {
          allow_unsafe: Boolean(allow_unsafe),
        });
        if (scan.status === 409) {
          const findings = (scan.data as ScanResponse | undefined)?.findings ?? [];
          const list = findings.length ? findings.map((f) => `  [${f.level}] ${f.code}: ${f.message}`).join('\n') : '  (no findings detail returned)';
          return textResult(`Refusing to run: server-side scan gate is BLOCKED.\n${list}\nMigration ${mid} is still pending on project ${targetProjectId} — pass allow_unsafe=true to override (logged) and call migrate again.`);
        }
        if (!scan.ok) return textResult(formatError(scan));

        const run = await apiRequest<RunResponse>('POST', `/projects/${targetProjectId}/migrate/wordpress/${mid}/run`, {
          old_url: report.source.old_url,
          ...(report.source.table_prefix && report.source.table_prefix !== 'wp_' ? { table_prefix: report.source.table_prefix } : {}),
        });
        if (!run.ok) return textResult(formatError(run));

        // Poll to terminal state (up to ~10 min; migrations are usually 1-3 min).
        // Check immediately (a migration can finish before the first poll tick)
        // and only sleep between checks, not before the first one.
        const started = Date.now();
        let last: StatusResponse | null = null;
        while (Date.now() - started < 10 * 60 * 1000) {
          const st = await apiRequest<StatusResponse>('GET', `/projects/${targetProjectId}/migrate/wordpress/${mid}`);
          if (st.ok) {
            last = st.data;
            if (last.status === 'succeeded' || last.status === 'failed') break;
          }
          await new Promise((r) => setTimeout(r, 5000));
        }
        if (!last) return textResult(`Migration ${mid} launched but status could not be read. Check later with action=status project_id=${targetProjectId} migration_id=${mid}.`);
        if (last.status === 'succeeded') {
          return textResult(`Migration succeeded. Site is live at ${run.data.new_url} with the imported content.\nNote: hard-refresh and re-save permalinks (Settings > Permalinks) if pretty URLs 404.`);
        }
        if (last.status === 'failed') {
          return textResult(`Migration FAILED at step: ${last.step ?? 'unknown'}\n${last.error ?? ''}\n--- log ---\n${last.log_tail ?? ''}\nYour staged files were kept — fix the issue and run migrate again.`);
        }
        return textResult(`Migration ${mid} still ${last.status} (step: ${last.step ?? '-'}) after 10 min — check again with action=status project_id=${targetProjectId} migration_id=${mid}.`);
      } finally {
        if (staged) await staged.cleanup().catch(() => {});
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
}
