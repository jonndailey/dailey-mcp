import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

// Dailey Email (pay-at-purchase, per project). Enable runs a $10/mo Stripe
// Checkout — the customer-api returns { ok, pending:true, checkout_url } that the
// user MUST open to pay before email turns on. The operator/no-Stripe path
// returns { ok, email_enabled:true, from } and provisions immediately.
interface EmailEnableResponse {
  ok?: boolean;
  pending?: boolean;
  checkout_url?: string | null;
  email_enabled?: boolean;
  from?: string;
  project_id?: string;
  key_masked?: string;
  restart_required?: boolean;
  docs_url?: string;
}

interface EmailStatusResponse {
  project_id: string;
  month: string;
  email_enabled: boolean;
  suspended: boolean;
  suspend_reason: string | null;
  from_address: string | null;
  usage: { messages_sent: number; bounced: number; complained: number };
}

export function registerEmailTools(server: McpServer) {
  server.tool(
    'dailey_email_enable',
    'Enable Dailey Email ($10/mo, per project) so the app can send from <slug>@send.dailey.cloud. This is PAY-AT-PURCHASE and billing-owner-only: the normal response is a Stripe Checkout URL the user MUST open to pay $10/mo before email turns on — do NOT treat email as enabled until payment completes. The operator/internal path enables immediately (email_enabled:true). After it turns on, redeploy so DAILEY_EMAIL_* env is injected.',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      const res = await apiRequest<EmailEnableResponse>('POST', `/projects/${project_id}/email/enable`, {});
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      // Pay-at-purchase: a checkout_url means email is NOT on yet.
      if (d.pending && d.checkout_url) {
        return textResult(
          [
            'Dailey Email is $10/mo and requires payment to enable.',
            '',
            '➜ Open this URL to finish enabling email (pay $10/mo):',
            d.checkout_url,
            '',
            'Email turns on automatically once the Stripe Checkout is paid. It is NOT active yet.',
            'After it turns on, redeploy the project (dailey_deploy) to pick up DAILEY_EMAIL_* env.',
          ].join('\n'),
        );
      }
      // Operator / already-on path — provisioned immediately.
      const lines = ['Dailey Email enabled.'];
      if (d.from) lines.push(`From: ${d.from}`);
      if (d.key_masked) lines.push(`Key:  ${d.key_masked}`);
      lines.push('');
      lines.push('Redeploy the project (dailey_deploy) to pick up the DAILEY_EMAIL_* env vars.');
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_email_disable',
    'Disable Dailey Email for a project: cancels the $10/mo email_pro subscription, revokes the email key, and removes the DAILEY_EMAIL_* env vars. Billing-owner-only (a manager acting-as a managed account is denied).',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      const res = await apiRequest<{ ok: boolean; email_enabled: boolean }>('DELETE', `/projects/${project_id}/email/enable`);
      if (!res.ok) return textResult(formatError(res));
      return textResult('Dailey Email disabled. The $10/mo subscription was cancelled and the DAILEY_EMAIL_* env vars removed.');
    },
  );

  server.tool(
    'dailey_email_status',
    'Show Dailey Email status for a project: whether email is enabled, the From address (<slug>@send.dailey.cloud), any suspension, and current-month usage (messages sent, bounced, complained).',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      const res = await apiRequest<EmailStatusResponse>('GET', `/projects/${project_id}/email`);
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      const lines = [
        `Dailey Email — ${d.project_id}`,
        `Enabled:   ${d.email_enabled ? 'yes' : 'no'}`,
        `From:      ${d.from_address || '(not set)'}`,
      ];
      if (d.suspended) lines.push(`Suspended: yes${d.suspend_reason ? ` (${d.suspend_reason})` : ''}`);
      lines.push('');
      lines.push(`Usage (${d.month}):`);
      lines.push(`  messages_sent: ${d.usage?.messages_sent ?? 0}`);
      lines.push(`  bounced:       ${d.usage?.bounced ?? 0}`);
      lines.push(`  complained:    ${d.usage?.complained ?? 0}`);
      if (!d.email_enabled) {
        lines.push('');
        lines.push('Email is off. Enable with dailey_email_enable (opens a $10/mo Stripe Checkout).');
      }
      return textResult(lines.join('\n'));
    },
  );
}
