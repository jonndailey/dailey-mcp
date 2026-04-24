/**
 * Admin-only tools for the project-transfer primitive. These move a whole
 * customer project (code + DB + storage + DNS + secrets) between customer
 * accounts with isolation verification and rollback. See
 * Dailey OS/Product/2026-04-24 project-transfer primitive — design + security
 * model.md and the companion runbook for details.
 *
 * Flow: plan → apply → (verify externally) → complete (irreversible)
 *                   └─→ rollback (only before complete)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, textResult, formatError } from '../api.js';

export function registerProjectTransferTools(server: McpServer) {
  server.tool(
    'dailey_project_transfer_plan',
    'Admin-only. Generate a transfer plan for moving a project from its current customer to a target customer. This is pure validation — no resources created. Returns plan_id, source + target endpoint details (namespaces, DB names, R2 prefixes), the 12-step pipeline, and any pre-flight issues (target slug collision, NetworkPolicy missing, etc.). Plan expires in 1 hour.',
    {
      project_id: z.string().describe('The source project ID'),
      to_customer_slug: z.string().describe('The slug of the target customer (e.g. "zena", not the customer_id)'),
    },
    async ({ project_id, to_customer_slug }) => {
      const res = await apiRequest<any>('POST', `/admin/transfers/plan`, { project_id, to_customer_slug });
      if (!res.ok) return textResult(formatError(res));
      const p = res.data;
      const lines = [
        `Transfer plan: ${p.plan_id}`,
        `Source:   ${p.source?.customer_slug} → ${p.source?.namespace} / ${p.source?.database_name}`,
        `Target:   ${p.target?.customer_slug} → ${p.target?.namespace} / ${p.target?.database_name}`,
        `Prod host:  ${p.prod_hostname}`,
        `Temp host:  ${p.temp_hostname}`,
        `Expires:  ${p.expires_at}`,
        '',
        `Steps (${p.steps?.length || 0}):`,
      ];
      for (const s of p.steps || []) lines.push(`  ${s.n}. ${s.id}: ${s.description}`);
      if (p.risks?.length) {
        lines.push('', 'Risks:');
        for (const r of p.risks) lines.push(`  ⚠ ${r}`);
      }
      lines.push('', 'Next: dailey_project_transfer_apply(plan_id).');
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_project_transfer_apply',
    'Admin-only. Execute the transfer. Runs 11 steps: snapshot source, provision target DB + storage creds, copy Postgres data via ephemeral Pod, copy R2 objects, rotate app secrets, stage target Deployment, smoke-test, pre-flight isolation check, DNS cutover, flip customer_projects authz, post-cutover isolation verify (all 8 checks). Source is still alive (scaled to 0) — can be restored via rollback. If any step fails or isolation verification fails, auto-rolls back and returns state=rolled_back. ⚠ All app user sessions invalidate (SHIM_JWT_SECRET rotated).',
    {
      plan_id: z.string().describe('The plan_id from dailey_project_transfer_plan'),
    },
    async ({ plan_id }) => {
      const res = await apiRequest<any>('POST', `/admin/transfers/apply`, { plan_id });
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      const lines = [
        `Apply: ${d.state}${d.state === 'applied' ? ' ✓' : ''}`,
        `Ready for completion: ${d.ready_for_completion ? 'yes' : 'no'}`,
        `Isolation passed: ${d.verification?.passed ? 'yes' : 'no'}`,
      ];
      if (d.applied_steps?.length) {
        lines.push('', 'Steps:');
        for (const s of d.applied_steps) {
          const m = s.status === 'ok' ? '✓' : s.status === 'skipped' ? '○' : '✗';
          lines.push(`  ${m} ${s.step}. ${s.id} (${s.duration_ms}ms)${s.message ? ' — ' + s.message.slice(0, 120) : ''}`);
        }
      }
      if (d.verification?.checks?.length) {
        const failed = d.verification.checks.filter((c: any) => !c.passed);
        if (failed.length) {
          lines.push('', 'Failed isolation checks:');
          for (const c of failed) lines.push(`  ✗ ${c.name}: ${c.observed}`);
        }
      }
      if (d.state === 'applied') {
        lines.push('', 'Next: verify the target is working (see runbook), then dailey_project_transfer_complete.');
        lines.push('      Or: dailey_project_transfer_rollback if something is wrong.');
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_project_transfer_complete',
    'Admin-only. IRREVERSIBLE teardown of the source side. Only call after manually verifying the target is fully functional. Drops source Postgres DB + role, deletes source R2 prefix, deletes source k8s Deployment/Service/Secret/Ingress. After this, the only recovery path is from backups. A metadata-only snapshot remains in project_transfer_snapshots for 90 days (no data).',
    {
      plan_id: z.string().describe('The plan_id (state must be "applied")'),
    },
    async ({ plan_id }) => {
      const res = await apiRequest<any>('POST', `/admin/transfers/complete`, { plan_id });
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      const lines = [
        `Complete: ${d.state}${d.state === 'completed' ? ' ✓ (source torn down)' : ''}`,
      ];
      if (d.teardown_steps?.length) {
        lines.push('', 'Teardown:');
        for (const s of d.teardown_steps) {
          const m = s.status === 'ok' ? '✓' : '✗';
          lines.push(`  ${m} ${s.id} (${s.duration_ms}ms)${s.message ? ' — ' + s.message : ''}`);
        }
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_project_transfer_rollback',
    'Admin-only. Undo an applied transfer (only valid before complete). Reverses steps 10 → 1: flips customer_projects back to source, restores source Ingress at prod hostname, deletes target Deployment/Service/Secrets, deletes target R2 objects, drops target Postgres DB + role. Source Deployment scales back up. ~30s downtime during DNS re-swap. All app sessions stay invalidated (the rotated secret is not un-rotated, since it may already have been exposed).',
    {
      plan_id: z.string().describe('The plan_id (state must be "applied")'),
    },
    async ({ plan_id }) => {
      const res = await apiRequest<any>('POST', `/admin/transfers/rollback`, { plan_id });
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      const lines = [
        `Rollback: ${d.state}${d.state === 'rolled_back' ? ' ✓ (source restored)' : ''}`,
      ];
      if (d.rolled_back_steps?.length) {
        lines.push('', 'Reversed:');
        for (const id of d.rolled_back_steps) lines.push(`  ↻ ${id}`);
      }
      return textResult(lines.join('\n'));
    },
  );
}
