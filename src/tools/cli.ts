import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult } from '../api.js';

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_.\-\/]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function registerCliTools(server: McpServer): void {
  server.tool(
    'dailey_cli_suggest_import',
    "Construct a correct `dailey db import` CLI invocation from semantic inputs. Read-only: does no I/O, makes no API calls. Pure string construction. The agent should run the returned command via its host shell (with user approval). A dry-run must precede any commit; the returned command defaults to --dry-run. Before suggesting, invoke `dailey_db_schema` to verify the payload shape fits the target table. For writes, this tool is the path — `dailey_db_recall` is read-only.",
    {
      project: z.string().describe('Project slug or id (e.g. "wordgym")'),
      table: z.string().describe('Target table name'),
      file: z
        .string()
        .describe(
          'Local file path to JSON array or CSV file (must exist on the user machine when the command runs)',
        ),
      mode: z.enum(['insert', 'upsert']).describe('Write mode'),
      conflict_keys: z
        .array(z.string())
        .optional()
        .describe('Conflict keys; required if mode=upsert'),
      dry_run: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Default true — constructs a command with --dry-run. Set false to construct a --confirm variant (the caller supplies the token from a prior dry-run output).',
        ),
    },
    async ({ project, table, file, mode, conflict_keys, dry_run }) => {
      if (mode === 'upsert' && (!conflict_keys || conflict_keys.length === 0)) {
        return textResult('error: mode=upsert requires conflict_keys');
      }

      const parts = [
        'dailey db import',
        shellQuote(project),
        shellQuote(file),
        `--table ${shellQuote(table)}`,
        `--mode ${mode}`,
      ];
      if (mode === 'upsert' && conflict_keys) {
        for (const k of conflict_keys) parts.push(`--key ${shellQuote(k)}`);
      }
      if (dry_run) parts.push('--dry-run');
      parts.push('--json');

      const command = parts.join(' ');
      const explanation =
        mode === 'upsert'
          ? `Upserts rows from ${file} into ${table}; conflicts resolve on ${(conflict_keys ?? []).join(', ')}. ${dry_run ? 'Dry-run only — server returns a confirmation token for a follow-up commit.' : 'Commit phase — expects --confirm <token> from a prior dry-run.'}`
          : `Inserts rows from ${file} into ${table}. ${dry_run ? 'Dry-run only — server returns a confirmation token for a follow-up commit.' : 'Commit phase — expects --confirm <token> from a prior dry-run.'}`;

      const preflight = [
        { check: 'file_exists', path: file },
        { check: 'schema_compatible', table },
      ];

      const output = {
        command,
        explanation,
        preflight,
        expected_output: 'json',
        on_dry_run_success:
          're-run with --confirm <token_from_dry_run_output> (remove --dry-run)',
      };

      return textResult(JSON.stringify(output, null, 2));
    },
  );
}
