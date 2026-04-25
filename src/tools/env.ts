import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface EnvVar {
  key: string;
  updated_at?: string;
}

interface RuntimeEnvVar {
  key: string;
  source: string;
  source_name: string | null;
  length: number;
  preview: string;
}

interface RuntimeEnvListing {
  project_id: string;
  project_slug: string;
  namespace: string;
  no_deployment: boolean;
  env_vars: RuntimeEnvVar[];
  counts: Record<string, number>;
}

interface ValidationWarning {
  key: string;
  expected_length: number;
  actual_length: number | null;
  reason: string;
}

/** Append validate-on-set warnings to a tool's text response. Returns an
 *  empty string when there are none, so call sites can interpolate
 *  unconditionally. Customer-feedback Scott Waters wishlist #5. */
function formatValidationWarnings(warnings: ValidationWarning[] | undefined): string {
  if (!Array.isArray(warnings) || warnings.length === 0) return '';
  const lines = ['', 'Validation warnings (value still saved, but couldn\'t confirm in pod secret):'];
  for (const w of warnings) {
    const lengths = w.actual_length === null
      ? `expected ${w.expected_length} bytes`
      : `expected ${w.expected_length}, got ${w.actual_length}`;
    lines.push(`  · ${w.key}: ${w.reason} (${lengths})`);
  }
  return '\n' + lines.join('\n');
}

export function registerEnvTools(server: McpServer) {
  server.tool(
    'dailey_env_vars',
    'List, set, set_many, or delete environment variables for a project. Use set_many to write multiple vars in a single call (one permission prompt, one Secret sync) — especially useful when an app needs 3+ build-time vars like Supabase/Vite/Next.',
    {
      project_id: z.string().describe('The project ID'),
      action: z.enum(['list', 'set', 'set_many', 'delete']).describe('Action: list, set (single), set_many (bulk), or delete'),
      key: z.string().optional().describe('Environment variable key (required for set/delete)'),
      value: z.string().optional().describe('Environment variable value (required for set)'),
      env_vars: z.record(z.string()).optional().describe('Flat object of env vars for set_many, e.g. { FOO: "bar", BAZ: "qux" }'),
    },
    async ({ project_id, action, key, value, env_vars }) => {
      if (action === 'list') {
        const res = await apiRequest<{ env_vars: EnvVar[] }>('GET', `/projects/${project_id}/env`);
        if (!res.ok) return textResult(formatError(res));

        const vars = res.data.env_vars;
        if (!vars || vars.length === 0) {
          return textResult('No environment variables set.');
        }

        const lines = [
          `Environment Variables (${vars.length})`,
          '─'.repeat(60),
        ];
        for (const v of vars) {
          lines.push(`${v.key}${v.updated_at ? `  updated=${v.updated_at}` : ''}`);
        }
        lines.push('');
        lines.push('Values stay hidden here by design. Use the env set/delete actions to manage them safely.');
        return textResult(lines.join('\n'));
      }

      if (action === 'set') {
        if (!key || value === undefined) {
          return textResult('Error: key and value are required for set action.');
        }
        // Try PUT first (update), fall back to POST (create)
        const putRes = await apiRequest<{ updated: boolean; key?: string; validation_warnings?: ValidationWarning[] }>(
          'PUT',
          `/projects/${project_id}/env/${encodeURIComponent(key)}`,
          { value },
        );
        if (putRes.ok) {
          return textResult(`Environment variable ${key} updated.${formatValidationWarnings(putRes.data?.validation_warnings)}`);
        }
        // If PUT fails (var doesn't exist yet), try POST
        const postRes = await apiRequest<{ set: boolean; key?: string; validation_warnings?: ValidationWarning[] }>(
          'POST',
          `/projects/${project_id}/env`,
          { key, value },
        );
        if (!postRes.ok) return textResult(formatError(postRes));
        return textResult(`Environment variable ${key} set.${formatValidationWarnings(postRes.data?.validation_warnings)}`);
      }

      if (action === 'set_many') {
        if (!env_vars || Object.keys(env_vars).length === 0) {
          return textResult('Error: env_vars object is required for set_many action.');
        }
        const res = await apiRequest<{ set: boolean; count: number; keys: string[]; validation_warnings?: ValidationWarning[] }>(
          'POST',
          `/projects/${project_id}/env`,
          { env_vars },
        );
        if (!res.ok) return textResult(formatError(res));
        const d = res.data || {} as any;
        return textResult(
          `Set ${d.count ?? Object.keys(env_vars).length} environment variables: ${(d.keys || Object.keys(env_vars)).join(', ')}${formatValidationWarnings(d.validation_warnings)}`,
        );
      }

      if (action === 'delete') {
        if (!key) {
          return textResult('Error: key is required for delete action.');
        }
        const res = await apiRequest('DELETE', `/projects/${project_id}/env/${encodeURIComponent(key)}`);
        if (!res.ok) return textResult(formatError(res));
        return textResult(`Environment variable ${key} deleted.`);
      }

      return textResult('Error: Invalid action. Use list, set, or delete.');
    },
  );

  /**
   * dailey_env_runtime_list — what the pod will actually see.
   *
   * Customer-feedback Scott Waters platform-wishlist 2026-04-25. The
   * existing dailey_env_vars list action only shows customer-set vars;
   * this tool walks the project's k8s Deployment spec and returns every
   * key the pod will receive at runtime, including platform-injected
   * ones (S3_*, DATABASE_URL, AUTH_*) tagged by source. Values are
   * redacted server-side; the response includes length + first-4 +
   * last-4 preview so debugging "is FOO actually set?" doesn't leak
   * raw bytes.
   */
  server.tool(
    'dailey_env_runtime_list',
    "Returns every env var the project's pod will see at runtime, including platform-injected ones (S3_*, DATABASE_URL, etc.) — values redacted but lengths shown. Use this when debugging 'is the env var I expect actually present in the pod?'.",
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      const res = await apiRequest<RuntimeEnvListing>('GET', `/projects/${project_id}/env/runtime`);
      if (!res.ok) return textResult(formatError(res));

      const data = res.data;
      if (data.no_deployment) {
        return textResult('No deployment found for this project. Run `dailey deploy` (or call dailey_deploy) first — env vars only exist on the deployed pod.');
      }

      const sourceLabel: Record<string, string> = {
        'customer': 'customer',
        'platform-storage': 'storage',
        'platform-db': 'db',
        'platform-auth': 'auth',
        'platform-other': 'platform',
        'inline': 'inline',
        'field-ref': 'downward',
        'config-map': 'configmap',
        'unknown': '?',
      };

      const lines = [
        `Runtime env: ${data.project_slug}`,
        `Namespace:   ${data.namespace}`,
        `Total keys:  ${data.env_vars.length}`,
        '',
      ];

      // Group by source for readability — AI agents pattern-match a lot
      // better when "all the platform-storage stuff" is contiguous than
      // when keys are alphabetic across all sources.
      const grouped = new Map<string, RuntimeEnvVar[]>();
      for (const v of data.env_vars) {
        const arr = grouped.get(v.source) || [];
        arr.push(v);
        grouped.set(v.source, arr);
      }
      const sourceOrder = ['customer', 'platform-storage', 'platform-db', 'platform-auth', 'platform-other', 'inline', 'field-ref', 'config-map', 'unknown'];
      for (const source of sourceOrder) {
        const vars = grouped.get(source);
        if (!vars || vars.length === 0) continue;
        lines.push(`[${sourceLabel[source] || source}] (${vars.length})`);
        for (const v of vars) {
          const lengthStr = v.length === -1 ? '-' : String(v.length);
          const sourceName = v.source_name ? `  ← ${v.source_name}` : '';
          lines.push(`  ${v.key.padEnd(30)} ${lengthStr.padStart(5)}B  ${v.preview}${sourceName}`);
        }
        lines.push('');
      }

      lines.push('Values redacted server-side. Customer-set keys can be rotated via dailey_env_vars(action: set).');

      return textResult(lines.join('\n'));
    },
  );
}
