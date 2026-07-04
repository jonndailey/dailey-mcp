import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

// Prepaid credits (opt-in $ balance drawn down in real time by metered AI /
// Compute / Email overage). GET returns balance + settings + recent ledger;
// top-up runs a one-time Stripe Checkout (kind:credit_topup) whose URL the
// user must open to pay.
interface CreditAccountResponse {
  balance_cents?: number;
  prepaid_enabled?: boolean;
  auto_recharge_enabled?: boolean;
  auto_recharge_threshold_cents?: number;
  auto_recharge_amount_cents?: number;
  stripe_payment_method_id?: string | null;
  editable?: boolean;
  ledger?: Array<{
    created_at?: string;
    delta_cents?: number;
    reason?: string;
    ref?: string | null;
  }>;
}

interface TopupResponse {
  checkout_url?: string | null;
  session_id?: string;
}

const dollars = (cents: number | undefined) =>
  `$${(((cents ?? 0)) / 100).toFixed(2)}`;

export function registerCreditTools(server: McpServer) {
  server.tool(
    'dailey_credits',
    'Show the account prepaid credit balance and settings: current balance, whether prepaid is enabled, auto-recharge config, and the recent credit ledger. Prepaid credits are drawn down in real time by metered AI / Compute / Email overage; a $0 balance hard-stops those. Top up with dailey_credits_topup.',
    {},
    async () => {
      const res = await apiRequest<CreditAccountResponse>('GET', '/account/credits');
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      const lines = [
        'Prepaid Credits',
        `Balance:         ${dollars(d.balance_cents)}`,
        `Prepaid enabled: ${d.prepaid_enabled ? 'yes' : 'no'}`,
        `Auto-recharge:   ${d.auto_recharge_enabled ? 'on' : 'off'}`,
      ];
      if (d.auto_recharge_enabled) {
        lines.push(`  when below:    ${dollars(d.auto_recharge_threshold_cents)}`);
        lines.push(`  top up by:     ${dollars(d.auto_recharge_amount_cents)}`);
      }
      const ledger = d.ledger || [];
      lines.push('');
      lines.push('Recent ledger:');
      if (ledger.length === 0) {
        lines.push('  (none)');
      } else {
        for (const e of ledger.slice(0, 20)) {
          const sign = (e.delta_cents ?? 0) >= 0 ? '+' : '-';
          lines.push(
            `  ${e.created_at || '?'}  ${sign}${dollars(Math.abs(e.delta_cents ?? 0))}  ${e.reason || ''}${e.ref ? ` (${e.ref})` : ''}`,
          );
        }
      }
      lines.push('');
      lines.push('Top up with dailey_credits_topup (opens a Stripe Checkout).');
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_credits_topup',
    'Buy a one-time prepaid credit top-up. Returns a Stripe Checkout URL the user MUST open to pay — the balance is only credited after payment completes (do NOT treat credits as added until then). The card is saved for off_session auto-recharge. Amount is $5–$1,000.',
    {
      amount_usd: z.number().min(5).max(1000).describe('Top-up amount in US dollars (5 to 1000).'),
    },
    async ({ amount_usd }) => {
      const amount_cents = Math.round(amount_usd * 100);
      const res = await apiRequest<TopupResponse>('POST', '/account/credits/checkout', { amount_cents });
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      if (!d.checkout_url) {
        return textResult('Top-up created but no checkout_url was returned. Retry, or top up from Billing → Credits.');
      }
      return textResult(
        [
          `Prepaid top-up of ${dollars(amount_cents)}.`,
          '',
          '➜ Open this URL to complete payment:',
          d.checkout_url,
          '',
          'Your balance is credited automatically once the Stripe Checkout is paid. It is NOT added yet.',
        ].join('\n'),
      );
    },
  );
}
