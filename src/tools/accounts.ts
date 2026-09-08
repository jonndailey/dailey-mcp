import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  apiRequest,
  formatError,
  jsonResult,
  getActiveAccount,
  setActiveAccount,
} from '../api.js';

interface ManagedAccount {
  managed_customer_id: string;
  slug: string;
  name: string;
}

const AUTH_REQUIRED_ERROR = {
  error_code: 'DAILEY_AUTH_REQUIRED',
  message: 'Not authenticated',
  remediation: 'Run `dailey auth setup` in your terminal',
  help_url: 'https://docs.dailey.cloud/docs/mcp/',
};

export function registerAccountTools(
  server: McpServer,
  opts: { includeSwitch?: boolean; remoteHint?: boolean } = {},
): void {
  const { includeSwitch = true, remoteHint = false } = opts;

  server.tool(
    'dailey_accounts',
    'List the managed accounts (the "fleet") this user manages — other Dailey accounts that have granted you a consent-based access grant. Returns each account\'s managed_customer_id, slug, and name, plus which account is currently active for this session. Empty fleet means you manage no other accounts. Use `dailey_use_account` to switch into one of these accounts; after switching, all other dailey tools operate inside that account until you clear or switch.' +
      (remoteHint ? ' NOTE: this server is remote and stateless — there is no session account switching. Pass `account: "<slug>"` on each tool call to operate in a managed account.' : ''),
    {},
    async () => {
      const res = await apiRequest<ManagedAccount[]>('GET', '/customers/me/managed-accounts');
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return jsonResult(AUTH_REQUIRED_ERROR);
        }
        return jsonResult({ error: formatError(res) });
      }
      const fleet = Array.isArray(res.data) ? res.data : [];
      return jsonResult({
        active_account: getActiveAccount() ?? null,
        operating_as: getActiveAccount() ? 'managed_account' : 'self',
        count: fleet.length,
        accounts: fleet,
      });
    },
  );

  if (includeSwitch) {
    server.tool(
      'dailey_use_account',
      'Switch the active managed-account context for this MCP session. Pass `account` (a slug or id from `dailey_accounts`) to operate INSIDE that managed account; after calling this, ALL other dailey tools act inside that managed account until you clear or switch. Pass `clear: true` to stop and operate as yourself again. The target account must be in your fleet (`dailey_accounts`) — an invalid account is rejected. This context is session-scoped: it persists for the life of this MCP server.',
      {
        account: z
          .string()
          .optional()
          .describe('The slug or id of a managed account to operate within (must be in your fleet from dailey_accounts)'),
        clear: z
          .boolean()
          .optional()
          .describe('If true, clear the active managed account and operate as yourself again'),
      },
      async ({ account, clear }) => {
        if (clear) {
          setActiveAccount(undefined);
          return jsonResult({
            ok: true,
            active_account: null,
            operating_as: 'self',
            message: 'Cleared managed-account context — now operating as yourself.',
          });
        }

        if (!account || !account.trim()) {
          return jsonResult({
            ok: false,
            message: 'Provide `account` (a slug or id from dailey_accounts) to switch into, or `clear: true` to operate as yourself.',
          });
        }

        const res = await apiRequest<ManagedAccount[]>('GET', '/customers/me/managed-accounts');
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            return jsonResult(AUTH_REQUIRED_ERROR);
          }
          return jsonResult({ ok: false, error: formatError(res) });
        }
        const fleet = Array.isArray(res.data) ? res.data : [];
        const target = account.trim();
        const match = fleet.find(
          (a) => a.slug === target || a.managed_customer_id === target,
        );
        if (!match) {
          return jsonResult({
            ok: false,
            message: `Account "${target}" is not in your managed-accounts fleet. Call dailey_accounts to list the accounts you manage.`,
            available: fleet.map((a) => ({ slug: a.slug, name: a.name })),
          });
        }

        // Use the slug as the header value when available (matches the dashboard/CLI
        // convention); the server accepts either slug or id.
        const activeValue = match.slug || match.managed_customer_id;
        setActiveAccount(activeValue);
        return jsonResult({
          ok: true,
          active_account: activeValue,
          operating_as: 'managed_account',
          account: match,
          message: `Now operating within "${match.name}" (${match.slug}). All subsequent dailey tool calls run inside this account until you clear or switch.`,
        });
      },
    );
  }
}
