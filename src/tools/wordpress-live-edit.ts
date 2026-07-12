import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  apiRequest,
  formatError,
  textResult,
  getActiveAccount,
  setActiveAccount,
} from '../api.js';

// ─────────────────────────────────────────────────────────────────────────────
// WordPress "live-edit" tools — thin MCP wrappers over the tenant-scoped
// customer-api live-edit routes (paired PR customer-api#18). Everything here
// lives under POST /projects/:id/wp/{files,media,cli}/…
//
// SAFETY MODEL (two-phase confirm). The mutating server routes are two-phase:
//   1. Request WITHOUT confirm_token  → the server returns a PREVIEW:
//        { preview:true, confirm_token, identity:{project_id,slug,domain,env,
//          db_name,namespace}, change }
//      It does NOT mutate. The `identity` echo tells you exactly which
//      domain / database / environment you are about to touch.
//   2. Request WITH that confirm_token → the server executes (snapshot-first).
//
// These tools NEVER fabricate or auto-pass a confirm_token. The token must come
// back from a real server preview; the tool only relays it on the second call.
// The model is instructed (in each description) to show the preview to the user
// and confirm the target before re-calling with the token.
//
// NOTE: these consume customer-api#18's routes and 404 until that PR is deployed
// (both merge in the same change window).
// ─────────────────────────────────────────────────────────────────────────────

// The targeting identity the server echoes on a preview so the model/user can
// confirm the exact site before a mutation proceeds.
interface Identity {
  project_id?: string;
  slug?: string;
  domain?: string;
  env?: string;
  db_name?: string;
  namespace?: string;
}

// A two-phase preview envelope (no mutation happened yet).
interface PreviewEnvelope {
  preview: true;
  confirm_token: string;
  identity?: Identity;
  change?: unknown;
}

function isPreview(data: unknown): data is PreviewEnvelope {
  return typeof data === 'object' && data !== null && (data as { preview?: unknown }).preview === true;
}

// If the caller passed an explicit `account`, adopt it as the acting-as target
// for this session (same mechanism as dailey_use_account — sends X-Dailey-Account
// on every subsequent request). Returns the EFFECTIVE account so every tool
// result can surface it and targeting is never ambiguous.
function scopeAccount(account?: string): string | null {
  if (account && account.trim()) {
    setActiveAccount(account.trim());
  }
  return getActiveAccount() ?? null;
}

// Render a two-phase preview prominently: the identity echo (domain/db/env) plus
// the pending change and the confirm_token to relay back verbatim.
function renderPreview(activeAccount: string | null, env: PreviewEnvelope, toolHint: string): string {
  const id = env.identity ?? {};
  const lines: string[] = [
    'PREVIEW ONLY — nothing has changed yet. Confirm the target below, then re-call to execute.',
    '',
    `Active account:  ${activeAccount ?? 'self'}`,
    `Domain:          ${id.domain ?? '(unknown)'}`,
    `Database:        ${id.db_name ?? '(unknown)'}`,
    `Environment:     ${id.env ?? '(unknown)'}`,
    `Project:         ${id.project_id ?? '(unknown)'}${id.slug ? ` (${id.slug})` : ''}`,
    `Namespace:       ${id.namespace ?? '(unknown)'}`,
    '',
    'Pending change:',
    JSON.stringify(env.change ?? {}, null, 2),
    '',
    `confirm_token: ${env.confirm_token}`,
    '',
    toolHint,
    'Do NOT invent a confirm_token — only relay the exact one above, and only after the user confirms this is the right site.',
  ];
  return lines.join('\n');
}

// Merge the effective account (and any identity echo the server included) onto a
// non-preview result so every result surfaces which account/site was acted on.
function renderResult(activeAccount: string | null, data: unknown): string {
  const base: Record<string, unknown> = { active_account: activeAccount ?? 'self' };
  if (typeof data === 'object' && data !== null) {
    Object.assign(base, data as Record<string, unknown>);
  } else {
    base.result = data;
  }
  return JSON.stringify(base, null, 2);
}

export function registerWordPressLiveEditTools(server: McpServer) {
  // ── Tool 1 — files: list / read / write / delete ─────────────────────────
  server.tool(
    'dailey_wp_files',
    [
      'Browse and edit the files of a live WordPress site (wp-content: themes, plugins, uploads).',
      'action="list" (path optional) and action="read" (path required) run immediately and are read-only.',
      'action="write" (path + content, optional encoding "utf8"|"base64") and action="delete" (path) are MUTATING and two-phase:',
      '  1) Call WITHOUT confirm_token first — the server returns a PREVIEW that echoes the target domain, db_name, env, and the exact change (it does NOT modify anything).',
      '  2) SHOW that preview to the user, confirm it is the right site, then call AGAIN with the SAME args plus the confirm_token returned by the preview to execute (the server takes a snapshot first).',
      'Never fabricate a confirm_token — only relay the one a real preview returned. Every result surfaces the active_account and, on mutations, the identity echo (domain/db/env).',
      'Consumes customer-api#18 routes; 404s until that ships (same change window).',
    ].join('\n'),
    {
      project: z.string().describe('The WordPress project — its id (or slug/ref the server can resolve)'),
      action: z.enum(['list', 'read', 'write', 'delete']).describe('list (read-only), read (read-only), write (mutating, two-phase), delete (mutating, two-phase)'),
      path: z.string().optional().describe('Path within wp-content. Optional for list (defaults to root); required for read/write/delete.'),
      content: z.string().optional().describe('File content for action="write" (interpret per `encoding`).'),
      encoding: z.enum(['utf8', 'base64']).optional().describe('Encoding of `content` for write; defaults to utf8.'),
      confirm_token: z.string().optional().describe('Two-phase confirm token for write/delete. Omit on the first call to get the preview; on the second call pass the exact token the preview returned. Never fabricate one.'),
      account: z.string().optional().describe('Acting-as target: slug or id of a managed account (must be in your fleet from dailey_accounts). Scopes this and subsequent calls, like dailey_use_account.'),
    },
    async ({ project, action, path, content, encoding, confirm_token, account }) => {
      const activeAccount = scopeAccount(account);
      const base = `/projects/${encodeURIComponent(project)}/wp/files`;

      if (action === 'list') {
        const res = await apiRequest('POST', `${base}/list`, path ? { path } : {});
        if (!res.ok) return textResult(formatError(res));
        return textResult(renderResult(activeAccount, res.data));
      }

      if (action === 'read') {
        if (!path) return textResult('action="read" requires `path`.');
        const res = await apiRequest('POST', `${base}/read`, { path });
        if (!res.ok) return textResult(formatError(res));
        return textResult(renderResult(activeAccount, res.data));
      }

      if (action === 'write') {
        if (!path) return textResult('action="write" requires `path`.');
        if (content == null) return textResult('action="write" requires `content`.');
        const body: Record<string, unknown> = { path, content };
        if (encoding) body.encoding = encoding;
        if (confirm_token) body.confirm_token = confirm_token;
        const res = await apiRequest('POST', `${base}/write`, body);
        if (!res.ok) return textResult(formatError(res));
        if (isPreview(res.data)) {
          return textResult(renderPreview(activeAccount, res.data, 'To write this file, re-call dailey_wp_files with the same project/path/content and this confirm_token.'));
        }
        return textResult(renderResult(activeAccount, res.data));
      }

      // action === 'delete'
      if (!path) return textResult('action="delete" requires `path`.');
      const body: Record<string, unknown> = { path };
      if (confirm_token) body.confirm_token = confirm_token;
      const res = await apiRequest('POST', `${base}/delete`, body);
      if (!res.ok) return textResult(formatError(res));
      if (isPreview(res.data)) {
        return textResult(renderPreview(activeAccount, res.data, 'To delete this file, re-call dailey_wp_files with the same project/path and this confirm_token.'));
      }
      return textResult(renderResult(activeAccount, res.data));
    },
  );

  // ── Tool 2 — media: list / upload ────────────────────────────────────────
  server.tool(
    'dailey_wp_media',
    [
      'List or upload media in a live WordPress site\'s uploads directory.',
      'action="list" (path optional) runs immediately and is read-only.',
      'action="upload" (filename + content_base64, optional import to register it in the WP media library) is MUTATING and two-phase:',
      '  1) Call WITHOUT confirm_token first — the server returns a PREVIEW echoing the target domain, db_name, env and the pending change (nothing is written yet).',
      '  2) SHOW the preview, confirm the site, then call AGAIN with the same args plus the returned confirm_token to execute (snapshot-first).',
      'Never fabricate a confirm_token — only relay one a real preview returned. Every result surfaces the active_account and, on mutations, the identity echo.',
      'Consumes customer-api#18 routes; 404s until that ships (same change window).',
    ].join('\n'),
    {
      project: z.string().describe('The WordPress project — its id (or slug/ref the server can resolve)'),
      action: z.enum(['list', 'upload']).describe('list (read-only) or upload (mutating, two-phase)'),
      path: z.string().optional().describe('Subpath within uploads for action="list" (defaults to root).'),
      filename: z.string().optional().describe('Destination filename for action="upload".'),
      content_base64: z.string().optional().describe('Base64-encoded file bytes for action="upload".'),
      import: z.boolean().optional().describe('If true, register the uploaded file in the WordPress media library (not just drop it on disk).'),
      confirm_token: z.string().optional().describe('Two-phase confirm token for upload. Omit on the first call to get the preview; pass the exact token the preview returned on the second call. Never fabricate one.'),
      account: z.string().optional().describe('Acting-as target: slug or id of a managed account (must be in your fleet). Scopes this and subsequent calls, like dailey_use_account.'),
    },
    async ({ project, action, path, filename, content_base64, import: importFlag, confirm_token, account }) => {
      const activeAccount = scopeAccount(account);
      const base = `/projects/${encodeURIComponent(project)}/wp/media`;

      if (action === 'list') {
        const res = await apiRequest('POST', `${base}/list`, path ? { path } : {});
        if (!res.ok) return textResult(formatError(res));
        return textResult(renderResult(activeAccount, res.data));
      }

      // action === 'upload'
      if (!filename) return textResult('action="upload" requires `filename`.');
      if (content_base64 == null) return textResult('action="upload" requires `content_base64`.');
      const body: Record<string, unknown> = { filename, content_base64 };
      if (importFlag != null) body.import = importFlag;
      if (confirm_token) body.confirm_token = confirm_token;
      const res = await apiRequest('POST', `${base}/upload`, body);
      if (!res.ok) return textResult(formatError(res));
      if (isPreview(res.data)) {
        return textResult(renderPreview(activeAccount, res.data, 'To upload this media, re-call dailey_wp_media with the same project/filename/content_base64 and this confirm_token.'));
      }
      return textResult(renderResult(activeAccount, res.data));
    },
  );

  // ── Tool 3 — wp-cli passthrough ──────────────────────────────────────────
  server.tool(
    'dailey_wp_cli',
    [
      'Run a wp-cli command against a live WordPress site. `args` is the argv array passed straight through (e.g. ["option","get","siteurl"] or ["post","list","--format=json"]).',
      'Read-only commands (e.g. `option get`, `post list`, `plugin list`) run immediately and return stdout/stderr/exit_code.',
      'Write commands require allow_write:true AND the two-phase confirm:',
      '  1) Call with allow_write:true but WITHOUT confirm_token — the server returns a PREVIEW echoing the target domain/db/env and the pending change (it does NOT run the write).',
      '  2) SHOW the preview, confirm the site, then call AGAIN with the same args + allow_write:true + the returned confirm_token to execute (snapshot-first).',
      'The server enforces an allow-list and REFUSES anything outside it — no `config`, `core`, `eval`, `search-replace`, or `db import/export`. Never fabricate a confirm_token. Results surface the active_account (and identity echo on writes).',
      'Consumes customer-api#18 routes; 404s until that ships (same change window).',
    ].join('\n'),
    {
      project: z.string().describe('The WordPress project — its id (or slug/ref the server can resolve)'),
      args: z.array(z.string()).describe('wp-cli argv, passed straight through. The server enforces the allow-list.'),
      allow_write: z.boolean().optional().describe('Required (true) for any write command; the server also gates writes by its allow-list. Read-only commands do not need this.'),
      confirm_token: z.string().optional().describe('Two-phase confirm token for writes. Omit on the first call to get the preview; pass the exact token the preview returned on the second call. Never fabricate one.'),
      account: z.string().optional().describe('Acting-as target: slug or id of a managed account (must be in your fleet). Scopes this and subsequent calls, like dailey_use_account.'),
    },
    async ({ project, args, allow_write, confirm_token, account }) => {
      const activeAccount = scopeAccount(account);
      const body: Record<string, unknown> = { args };
      if (allow_write != null) body.allow_write = allow_write;
      if (confirm_token) body.confirm_token = confirm_token;

      const res = await apiRequest('POST', `/projects/${encodeURIComponent(project)}/wp/cli`, body);
      if (!res.ok) return textResult(formatError(res));
      if (isPreview(res.data)) {
        return textResult(renderPreview(activeAccount, res.data, 'To run this write command, re-call dailey_wp_cli with the same args + allow_write:true and this confirm_token.'));
      }
      return textResult(renderResult(activeAccount, res.data));
    },
  );
}
