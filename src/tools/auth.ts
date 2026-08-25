import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult, jsonResult, getActiveAccount } from '../api.js';

interface ManagedAccount {
  managed_customer_id: string;
  slug: string;
  name: string;
}

interface AuthEnableResponse {
  ok: boolean;
  project_id: string;
  auth_enabled: boolean;
  created: boolean;
  app_id: string;
  app_slug: string;
  client_id: string;
  client_secret?: string;
  enrolled: boolean;
  x_client_id: string;
  origin: string;
  extra_origins: string[];
  core_base_url: string;
  note?: string;
  docs_url: string;
}

interface UserInfo {
  id: string;
  name: string;
  email: string;
  plan?: string;
  created_at?: string;
}

const AUTH_REQUIRED_ERROR = {
  error_code: 'DAILEY_AUTH_REQUIRED',
  message: 'Not authenticated',
  remediation: 'Run `dailey auth setup` in your terminal',
  help_url: 'https://docs.dailey.cloud/docs/mcp/',
};

export function registerAuthTools(server: McpServer) {
  server.tool(
    'dailey_whoami',
    'Show current user info (name, email, plan)',
    {},
    async () => {
      const res = await apiRequest<UserInfo>('GET', '/customers/me');
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return jsonResult(AUTH_REQUIRED_ERROR);
        }
        return textResult(formatError(res));
      }

      const u = res.data;
      const lines = [
        `User Info`,
        `─────────────────────`,
        `ID:      ${u.id}`,
        `Name:    ${u.name}`,
        `Email:   ${u.email}`,
      ];
      if (u.plan) lines.push(`Plan:    ${u.plan}`);
      if (u.created_at) lines.push(`Created: ${u.created_at}`);
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_auth_status',
    'Check authentication status — returns whether the MCP server is authenticated and the account details if so',
    {},
    async () => {
      const res = await apiRequest<UserInfo>('GET', '/customers/me');

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return jsonResult({
            authenticated: false,
            source: null,
            recommended_action: 'Run `dailey auth setup` in your terminal',
          });
        }
        // Non-auth error — surface it but don't claim unauthenticated
        return jsonResult({
          authenticated: false,
          source: null,
          recommended_action: `API error (${res.status}) — run \`dailey auth setup\` if your token is missing or expired`,
        });
      }

      const u = res.data;

      // Infer the token source from the environment the MCP server was started with.
      // DAILEY_API_TOKEN wins; email+password means a refreshed session JWT; otherwise
      // it must be a dk_ API key set some other way.
      let source: 'api_key' | 'env_token' | 'session' = 'session';
      const envToken = process.env.DAILEY_API_TOKEN || '';
      if (envToken.startsWith('dk_')) {
        source = 'api_key';
      } else if (envToken) {
        source = 'env_token';
      } else if (process.env.DAILEY_EMAIL) {
        source = 'session';
      }

      // Manager / managed-accounts: report whether this user manages any other
      // accounts (the fleet) and which one — if any — is the active context for
      // this session. A non-empty fleet means they can `dailey_use_account` to
      // operate inside one of these accounts. Best-effort: a failure here must
      // not break auth-status, so we swallow errors and report manager: null.
      let fleet: ManagedAccount[] = [];
      try {
        const mres = await apiRequest<ManagedAccount[]>('GET', '/customers/me/managed-accounts');
        if (mres.ok && Array.isArray(mres.data)) fleet = mres.data;
      } catch {
        // ignore — leave fleet empty
      }
      const active = getActiveAccount() ?? null;

      return jsonResult({
        authenticated: true,
        source,
        account: u.name,
        email: u.email,
        recommended_action: null,
        manager: {
          is_manager: fleet.length > 0,
          managed_accounts: fleet,
          active_account: active,
          operating_as: active ? 'managed_account' : 'self',
        },
      });
    },
  );

  server.tool(
    'dailey_auth_enable',
    'Enable Dailey Core authentication for a project in one call. Registers the app in Core, installs it in your Core tenant, and enrolls you — wrapping Core self-serve provisioning. The origin is derived from the project (https://<slug>.dailey.cloud, plus any *.dailey.cloud custom domains). Your app hosts its OWN login UI and calls Core directly with header X-Client-Id: <app_slug> — the app-scoped, embedded endpoints are POST /auth/app-signup (create an end user + get tokens), POST /auth/login (returns tokens in JSON), and POST /auth/refresh. Do NOT use /oauth/authorize for this — that is the platform SSO redirect flow, a different integration. In the returned JWT, identify the end user by the `sub` claim (their Core user id); the `tenant` claim is the app\'s shared Core tenant (account-level, the same for every user) — use it to scope to your app, not to tell users apart. The app\'s Core UUID is returned as app_id (and injected into the app runtime as DAILEY_APP_ID). client_secret is returned ONLY the first time. enforce_enrolled_factors defaults to false so password login still works alongside passkeys.',
    {
      project_id: z.string().describe('The project ID'),
      enforce_enrolled_factors: z
        .boolean()
        .optional()
        .describe('Require enrolled factors (e.g. passkey) at login. Defaults to false so password login still works.'),
    },
    async ({ project_id, enforce_enrolled_factors }) => {
      const res = await apiRequest<AuthEnableResponse>('POST', `/projects/${project_id}/auth/enable`, {
        enforce_enrolled_factors: enforce_enrolled_factors === true,
      });
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      const lines = [
        `Dailey Core authentication enabled for project ${d.project_id}.`,
        '',
        `App / X-Client-Id: ${d.app_slug}`,
        `App Core UUID:     ${d.app_id}   (also injected as DAILEY_APP_ID)`,
        `Origin:            ${d.origin}`,
        ...(d.extra_origins && d.extra_origins.length ? [`Also allowed:      ${d.extra_origins.join(', ')}`] : []),
        `Core base URL:     ${d.core_base_url}`,
        `Enrolled:          ${d.enrolled ? 'yes' : 'no'}`,
      ];
      if (d.client_secret) {
        lines.push('', `⚠ Save this client_secret — it is shown only once:`, `   ${d.client_secret}`);
      } else if (d.note) {
        lines.push('', d.note);
      }
      lines.push(
        '',
        `Your app hosts its own login and calls Core directly with header X-Client-Id: ${d.x_client_id}.`,
        `Endpoints: POST /auth/app-signup, POST /auth/login, POST /auth/refresh (embedded/API-first — not /oauth/authorize).`,
        `In the JWT: \`sub\` is the end-user id; \`tenant\` is your app's shared Core tenant (same for every user).`,
        `Docs: ${d.docs_url}`,
      );
      return textResult(lines.join('\n'));
    },
  );
}
