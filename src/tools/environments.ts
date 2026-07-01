import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, textResult, formatError } from '../api.js';

interface Environment {
  id?: string;
  environment: string;
  deployment: string;
  domain: string;
  status: string;
  db_name?: string;
  storage_prefix?: string;
  image?: string;
  replicas?: number;
  created_at?: string;
  updated_at?: string;
}

interface EnvironmentsResponse {
  environments: Environment[];
}

interface ClonePreviewPlan {
  steps: string[];
  sourceLabel?: string;
  targetLabel?: string;
}

interface ClonePreviewResponse {
  plan: ClonePreviewPlan;
  confirm_token: string;
}

interface CloneExecuteResponse {
  operation_id: string;
}

export function registerEnvironmentTools(server: McpServer) {
  server.tool(
    'dailey_environments',
    'List prod and staging environments for a project',
    {
      project: z.string().describe('The project ID or slug'),
    },
    async ({ project }) => {
      const res = await apiRequest<EnvironmentsResponse>('GET', `/projects/${project}/environments`);
      if (!res.ok) return textResult(formatError(res));

      const envs = res.data.environments;
      if (!envs || envs.length === 0) {
        return textResult(`No environments found for project ${project}.`);
      }

      const lines: string[] = [`Environments for project ${project}:`, ''];

      for (const env of envs) {
        const label = env.environment === 'prod' ? 'Production (prod)' : `${env.environment}`;
        lines.push(`${label}`);
        lines.push(`  Status:    ${env.status}`);
        lines.push(`  Domain:    https://${env.domain}`);
        lines.push(`  Deployment: ${env.deployment}`);
        if (env.db_name) lines.push(`  Database:  ${env.db_name}`);
        if (env.image) lines.push(`  Image:     ${env.image}`);
        if (env.replicas != null) lines.push(`  Replicas:  ${env.replicas}`);
        if (env.created_at) lines.push(`  Created:   ${env.created_at}`);
        lines.push('');
      }

      return textResult(lines.join('\n').trimEnd());
    },
  );

  server.tool(
    'dailey_wp_clone',
    'Clone a WordPress project from prod to staging (DESTRUCTIVE — two-phase). Call WITHOUT confirm_token to get the plan; re-call WITH the returned confirm_token to execute.',
    {
      project: z.string().describe('The project ID or slug'),
      confirm_token: z.string().optional().describe(
        'Token from the plan response. Omit to preview the plan; provide to execute. ~10min TTL.',
      ),
    },
    async ({ project, confirm_token }) => {
      if (!confirm_token) {
        // Phase 1: preview
        const res = await apiRequest<ClonePreviewResponse>(
          'POST',
          `/projects/${project}/wp/clone/preview`,
        );
        if (!res.ok) return textResult(formatError(res));

        const { plan, confirm_token: token } = res.data;
        const lines: string[] = [];

        if (plan.sourceLabel || plan.targetLabel) {
          lines.push(`Clone plan: ${plan.sourceLabel ?? 'prod'} → ${plan.targetLabel ?? 'staging'}`);
        } else {
          lines.push(`Clone plan for project ${project} (prod → staging):`);
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
          'This will overwrite staging with prod data. To proceed, re-call dailey_wp_clone with the same project and this confirm_token.',
        );

        return textResult(lines.join('\n'));
      }

      // Phase 2: execute
      const res = await apiRequest<CloneExecuteResponse>(
        'POST',
        `/projects/${project}/wp/clone`,
        { confirm_token, confirmation: 'CLONE' },
      );

      if (!res.ok) {
        if (res.status === 409) {
          return textResult('A clone or restore operation is already in progress for this project.');
        }
        return textResult(formatError(res));
      }

      const { operation_id } = res.data;
      return textResult(
        `Clone started. operation_id=${operation_id}. Poll with dailey_wp_operation_status (project, operation_id).`,
      );
    },
  );
}
