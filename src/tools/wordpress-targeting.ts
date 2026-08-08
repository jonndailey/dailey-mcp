import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  apiRequest,
  formatError,
  textResult,
  jsonResult,
  getActiveAccount,
  setActiveAccount,
} from '../api.js';

/**
 * The catalog SLUG (the key in dailey-deploy-service's CATALOG, src/routes/deploy-image.ts)
 * — not an image ref. This is what gets stored as the project's `repo_url`, and the
 * deploy-service resolves the template from it on every deploy: MySQL DB env, the
 * persistent wp-content volume, the backup sidecar, the Recreate strategy and the
 * generated admin creds all hang off that lookup.
 *
 * It used to be the image ref `wordpress:6-apache`, matched by comparing image
 * repositories. On 2026-07-13 the catalog image was repointed to
 * `registry.dailey.cloud/catalog/wordpress:6-apache-wpcli` to bake in wp-cli, and the
 * repository names stopped matching — so `getCatalogEntry` returned null and every
 * WordPress site created afterwards came up as a generic stateless app: no volume, no
 * WORDPRESS_DB_* env, no wp-cli, serving the installer. Verified 2026-08-07.
 *
 * The slug is matched by exact key (`if (CATALOG[input]) return CATALOG[input]`), which
 * is the FIRST branch of the lookup, so it cannot be broken by repointing the image
 * again. Prefer the slug over any image ref here, permanently.
 */
const WORDPRESS_CATALOG_SLUG = 'wordpress';

interface CreatedProject {
  id: string;
  name: string;
  slug?: string;
  status?: string;
  repo_url?: string;
  url?: string;
  build_id?: string;
}

// A WordPress project as returned by the targeting spine
// (customer-api feat/wp-targeting-spine).
interface WpProject {
  project_id: string;
  slug: string;
  domain: string;
  env: string;
  db_name: string;
  namespace: string;
  active_account: string | null;
}

interface WpListResponse {
  projects: WpProject[];
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

export function registerWordPressTargetingTools(server: McpServer) {
  // ── Tool 1 — Scenario 1: create a fresh hardened WordPress site ──────────
  server.tool(
    'dailey_create_wordpress',
    'Create a brand-new hardened WordPress site in the effective account (respects the account set by dailey_use_account, or the optional `account` arg here). POSTs the standard project-create endpoint with the WordPress catalog slug so the deploy-service provisions the MySQL database, a persistent wp-content volume, a backup sidecar, and generated admin credentials. Note: WordPress core is NOT auto-installed — the site serves the standard WordPress installer on first visit; the generated admin credentials are for the account you create there. Prefer this over dailey_wordpress_import when you just need a fresh site (import is for migrating an existing bundle). Returns the project_id, slug, the wp-admin URL, and the effective account. The generated admin password is retrievable via dailey_reveal_credential (key WORDPRESS_ADMIN_PASSWORD).',
    {
      name: z.string().describe('Project name for the new WordPress site'),
      account: z
        .string()
        .optional()
        .describe('Acting-as target: slug or id of a managed account to create the site in (must be in your fleet from dailey_accounts). Scopes this and subsequent calls, like dailey_use_account.'),
    },
    async ({ name, account }) => {
      const activeAccount = scopeAccount(account);

      // Reuse the exact dailey_create_project call shape (POST /projects) but
      // with the hardened WordPress catalog inputs. The deploy-service resolves
      // the catalog template from this slug and wires DB + storage + admin creds.
      const res = await apiRequest<CreatedProject>('POST', '/projects', {
        name,
        repo_url: WORDPRESS_CATALOG_SLUG,
        needs_database: true,
        needs_storage: true,
      });
      if (!res.ok) return textResult(formatError(res));

      const p = res.data;
      const slug = p.slug || '';
      const adminUrl = slug ? `https://${slug}.dailey.cloud/wp-admin` : '(slug pending — check dailey_project_info)';

      return textResult(
        [
          `WordPress site created!`,
          ``,
          `Project ID:      ${p.id}`,
          `Name:            ${p.name}`,
          `Slug:            ${slug || '(pending)'}`,
          `Status:          ${p.status || 'pending'}`,
          `Admin URL:       ${adminUrl}`,
          `Account:         ${activeAccount ?? 'self'}`,
          ...(p.build_id ? [`Build:           ${p.build_id} (auto-queued — watch with dailey_deploy_status)`] : []),
          ``,
          `The generated admin password is retrievable via:`,
          `  dailey_reveal_credential(project_id="${p.id}", key="WORDPRESS_ADMIN_PASSWORD")`,
          `Every reveal is audited and returns a masked preview by default.`,
        ].join('\n'),
      );
    },
  );

  // ── Tool 2 — list WordPress projects (targeting spine) ───────────────────
  server.tool(
    'dailey_wp_list',
    'List the WordPress projects in the effective account. Call this instead of guessing a WP site from the generic dailey_list_projects — it returns only WordPress projects with their targeting identity (project_id, slug, domain, env, db_name, namespace) and prominently the active_account you are operating in. NOTE: requires the paired customer-api feat/wp-targeting-spine deploy; until that ships this returns 404 (expected — both merge together).',
    {
      account: z
        .string()
        .optional()
        .describe('Acting-as target: slug or id of a managed account to list within (must be in your fleet from dailey_accounts). Scopes this and subsequent calls, like dailey_use_account.'),
    },
    async ({ account }) => {
      const activeAccount = scopeAccount(account);

      const res = await apiRequest<WpListResponse>('GET', '/projects/wp/list');
      if (!res.ok) return jsonResult({ active_account: activeAccount, error: formatError(res) });

      const projects = res.data.projects ?? [];
      return jsonResult({
        active_account: activeAccount,
        count: projects.length,
        projects,
      });
    },
  );

  // ── Tool 3 — resolve/confirm a WordPress target (targeting spine) ────────
  server.tool(
    'dailey_wp_target',
    'Resolve a WordPress project reference (id OR slug) to its exact targeting identity and echo it back: project_id, slug, domain, env, db_name, namespace, and active_account. CALL THIS BEFORE ANY DESTRUCTIVE WordPress action (import, restore, clone, delete, db writes) to confirm you are about to act on the RIGHT domain/database/account — this is the fix for editing the wrong site. If no WordPress project matches the ref in the active account, returns a clear not-found pointing you at dailey_wp_list. NOTE: requires the paired customer-api feat/wp-targeting-spine deploy; until that ships this returns 404 (expected — both merge together).',
    {
      project: z.string().describe('The WordPress project to resolve — its id OR slug'),
      account: z
        .string()
        .optional()
        .describe('Acting-as target: slug or id of a managed account to resolve within (must be in your fleet from dailey_accounts). Scopes this and subsequent calls, like dailey_use_account.'),
    },
    async ({ project, account }) => {
      const activeAccount = scopeAccount(account);

      const res = await apiRequest<WpProject & { error?: string }>(
        'GET',
        `/projects/wp/resolve?ref=${encodeURIComponent(project)}`,
      );

      if (res.status === 404) {
        return jsonResult({
          active_account: activeAccount,
          resolved: false,
          message: `No WordPress project matching '${project}' in account '${activeAccount ?? 'self'}' — call dailey_wp_list to see the options.`,
        });
      }
      if (!res.ok) return jsonResult({ active_account: activeAccount, resolved: false, error: formatError(res) });

      const t = res.data;
      return jsonResult({
        active_account: t.active_account ?? activeAccount,
        resolved: true,
        target: {
          project_id: t.project_id,
          slug: t.slug,
          domain: t.domain,
          env: t.env,
          db_name: t.db_name,
          namespace: t.namespace,
        },
        confirm: `About to act on ${t.domain} (db=${t.db_name}, env=${t.env}) in account '${t.active_account ?? activeAccount ?? 'self'}'. Verify this is the intended site before any destructive action.`,
      });
    },
  );
}
