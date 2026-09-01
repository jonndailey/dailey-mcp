import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult, isValidProjectId, invalidProjectIdResult } from '../api.js';

/**
 * Mask a credential value for display. Keeps the last 3 characters so the
 * caller can sanity-check which credential they're looking at, hides the
 * rest. Returns just the length indicator for very short values.
 */
function maskValue(v: string): string {
  if (!v) return '(empty)';
  if (v.length <= 4) return '•'.repeat(v.length) + ` (${v.length} chars)`;
  const tail = v.slice(-3);
  return '•'.repeat(Math.min(v.length - 3, 12)) + tail + ` (${v.length} chars)`;
}

export function registerCredentialRevealTools(server: McpServer) {
  server.tool(
    'dailey_reveal_credential',
    'Reveal a project credential after re-auth. Supports DB credentials (DB_PASSWORD, DB_USER, DB_HOST, DB_PORT, DB_NAME) and storage credentials (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_SESSION_TOKEN, S3_ENDPOINT, S3_REGION, S3_BUCKET_NAME, S3_KEY_PREFIX). Every reveal is audited. BY DEFAULT returns a masked preview (last 3 chars + length) so the value never enters chat transcripts. Pass emit_plaintext=true to see the full value — only do this when you understand the chat-log exposure. Better workflow for S3 vars: use dailey_storage_enable to fix missing injection; use dailey_db_tunnel for DB creds.',
    {
      project_id: z.string().describe('The project ID'),
      key: z.string().describe('Credential key (e.g., DB_PASSWORD, WORDPRESS_ADMIN_PASSWORD)'),
      password: z.string().optional().describe('Account password for re-auth (falls back to DAILEY_PASSWORD env var)'),
      emit_plaintext: z.boolean().optional().describe('If true, emits the cleartext credential into the response. Default false. Only set true when you understand the chat-log exposure. Rotate immediately afterward if the transcript will be shared.'),
    },
    async ({ project_id, key, password, emit_plaintext }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      const pw = password || process.env.DAILEY_PASSWORD;
      if (!pw) {
        return textResult(
          'Error: re-auth password required. Set DAILEY_PASSWORD env var or pass password argument. Every reveal is audited.',
        );
      }

      const res = await apiRequest<{ key: string; value: string }>(
        'POST',
        `/projects/${project_id}/credentials/reveal`,
        { key, password: pw },
      );
      if (!res.ok) return textResult(formatError(res));

      const { key: k, value } = res.data;
      const lines: string[] = [];

      if (emit_plaintext) {
        lines.push(`${k}: ${value}`);
        lines.push('');
        lines.push('⚠ EMITTED CLEARTEXT — this response is now in the chat log. Rotate');
        lines.push('  this credential now via dailey_env_vars set if the transcript is shared,');
        lines.push('  synced to cloud AI history, or anywhere outside a private terminal.');
      } else {
        lines.push(`${k}: ${maskValue(value)}  [masked — pass emit_plaintext=true to see]`);
        lines.push('');
        lines.push('The full credential was NOT emitted. Reveal is audited server-side either way.');
        lines.push('If you need the cleartext:');
        lines.push('  • dailey_db_tunnel (for DB creds — opens a local port, no value in chat)');
        lines.push('  • dashboard "reveal" (browser-only modal — does not hit chat)');
        lines.push('  • dailey_reveal_credential(..., emit_plaintext=true) as last resort');
      }

      return textResult(lines.join('\n'));
    },
  );
}
