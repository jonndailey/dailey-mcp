import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

/**
 * dailey_deploy_bundle — atomic create + configure + deploy in one call.
 *
 * Replaces what used to be 4–30 separate MCP calls (create_project +
 * set_env_var × N + service_links × M + deploy + ...). Each of those
 * required its own Claude Code permission prompt, which was Scott's
 * friction #8. One call, one prompt, whole-bundle rollback on failure.
 *
 * EOS #53.
 */

export function registerBundleTools(server: McpServer) {
  server.tool(
    'dailey_deploy_bundle',
    [
      'Create a project, inject env vars, link to other projects, bind a domain, and trigger the deploy — all in one atomic call.',
      'If any step fails, the project is rolled back (deleted) so you do not end up with a partial "failed" project.',
      'Prefer this over dailey_create_project + dailey_env_vars + dailey_service_links + dailey_deploy for any fresh deploy — it burns one permission prompt instead of many, and guarantees all-or-nothing.',
    ].join(' '),
    {
      name: z.string().describe('Project name (also used as the requested slug).'),
      repo_url: z.string().describe('GitHub repo URL (https://github.com/owner/repo) or Docker image (e.g., nginx:alpine).'),
      branch: z.string().optional().describe('Git branch to deploy. Defaults to main. Ignored for Docker images.'),
      env_vars: z
        .record(z.string())
        .optional()
        .describe('Environment variables as a flat object, e.g. { DATABASE_URL: "postgresql://...", REDIS_URL: "..." }.'),
      database: z
        .union([z.enum(['mysql', 'postgres']), z.boolean()])
        .optional()
        .describe('Provision a managed DB: "mysql" | "postgres" | true (= mysql) | false. For Prisma/pg apps, use "postgres".'),
      needs_auth: z.boolean().optional().describe('Provision Dailey Auth (SSO) for this project.'),
      needs_storage: z.boolean().optional().describe('Provision object storage (R2) for this project.'),
      links: z
        .array(
          z.object({
            target_project_id: z.string().describe('ID of the project to link to (e.g., a Postgres project).'),
            env_key: z.string().optional().describe('Env key to inject on the source project. Defaults to an uppercased version of the target name.'),
          }),
        )
        .optional()
        .describe('Service links to inject into the new project. For DB targets, the injected env var is a real connection string (postgresql://, mysql://, etc.).'),
      domain: z.string().optional().describe('Optional custom domain to bind (e.g., my-app.example.com). Must pass DNS-check after deploy.'),
      deploy: z.boolean().optional().describe('Trigger a deploy after configuration. Defaults to true.'),
    },
    async (input) => {
      // Translate to server shape: the bundle endpoint takes needs_database
      // + database_type separately, same shape as POST /projects.
      let needs_database = false;
      let database_type: 'mysql' | 'postgres' | undefined;
      if (input.database === true) { needs_database = true; database_type = 'mysql'; }
      else if (input.database === 'mysql' || input.database === 'postgres') {
        needs_database = true;
        database_type = input.database;
      }

      const res = await apiRequest<any>('POST', '/projects/bundle', {
        name: input.name,
        repo_url: input.repo_url,
        branch: input.branch,
        env_vars: input.env_vars,
        needs_database,
        database_type,
        needs_auth: input.needs_auth,
        needs_storage: input.needs_storage,
        links: input.links,
        domain: input.domain,
        deploy: input.deploy,
      });

      if (!res.ok) {
        // Bundle endpoint returns structured failure with a rolled_back flag
        // and a steps array showing which stage died.
        const body: any = res.data;
        const lines: string[] = [];
        lines.push(`Bundle failed: ${body?.error || formatError(res)}`);
        if (body?.rolled_back) {
          lines.push('Rolled back cleanly — no partial project left behind.');
        } else {
          lines.push('⚠ NOT rolled back — a partial project may exist. Inspect dailey_list_projects.');
        }
        if (Array.isArray(body?.steps)) {
          lines.push('');
          lines.push('Steps:');
          for (const s of body.steps) {
            const mark = s.status === 'ok' ? '✓' : '✗';
            lines.push(`  ${mark} ${s.step} (${s.ms}ms)${s.status === 'failed' && s.detail ? ` — ${JSON.stringify(s.detail)}` : ''}`);
          }
        }
        return textResult(lines.join('\n'));
      }

      const data: any = res.data;
      const project = data.project || {};
      const lines: string[] = [];
      lines.push(`✓ Bundled deploy for ${project.name || input.name}`);
      lines.push('');
      lines.push(`Project ID: ${project.id}`);
      lines.push(`Slug:       ${project.slug}`);
      lines.push(`URL:        ${project.url || `https://${project.slug}.dailey.cloud`}`);
      if (project.database) lines.push(`Database:   ${project.database.database} (${project.database.type || database_type || 'mysql'})`);
      if (Array.isArray(data.links) && data.links.length > 0) {
        lines.push('');
        lines.push('Service links:');
        for (const l of data.links) {
          lines.push(`  ${l.env_key} → ${l.target_slug} (${l.kind})`);
        }
      }
      if (data.domain) lines.push(`Domain:     ${data.domain.hostname || input.domain}`);
      if (data.build_id) {
        lines.push('');
        lines.push(`Build ID: ${data.build_id}`);
        lines.push(`Track progress: dailey_deploy_status with project_id=${project.id}`);
      }
      if (Array.isArray(data.steps)) {
        const ok = data.steps.filter((s: any) => s.status === 'ok').length;
        const total = data.steps.length;
        const totalMs = data.steps.reduce((sum: number, s: any) => sum + (s.ms || 0), 0);
        lines.push('');
        lines.push(`(${ok}/${total} steps succeeded in ${totalMs}ms)`);
      }
      return textResult(lines.join('\n'));
    },
  );
}
