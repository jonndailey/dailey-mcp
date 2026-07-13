import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult, jsonResult } from '../api.js';

interface AccountUsageResponse {
  month: string;
  plan: string;
  currency: string;
  ai: {
    input_tokens: number;
    output_tokens: number;
    requests: number;
    tiers: Array<{
      tier: string;
      used_tokens: number;
      requests: number;
      allowance_tokens: number;
      remaining_tokens: number;
      billable_tokens: number;
      est_overage_cents: number;
    }>;
    est_overage_cents: number;
  };
  compute: {
    gpu_minutes: number;
    jobs: number;
    rate_cents_per_minute: number;
    est_overage_cents: number;
  };
  email: {
    enabled: boolean;
    messages_sent: number;
    included: number;
    remaining: number;
    est_overage_cents: number;
  };
  est_total_overage_cents: number;
  credits: {
    prepaid_enabled: boolean;
    balance_cents: number;
    auto_recharge_enabled: boolean;
  };
}

const dollars = (cents: number | undefined) => `$${(((cents ?? 0)) / 100).toFixed(2)}`;
const n = (x: number | undefined) => (x ?? 0).toLocaleString();

export function registerUsageTools(server: McpServer) {
  server.tool(
    'dailey_usage',
    'Get resource usage stats for a project',
    {
      project_id: z.string().describe('The project ID'),
      period: z.string().optional().describe('Time period (e.g., 7d, 30d). Default: 7d'),
    },
    async ({ project_id, period }) => {
      const query = `?period=${period || '7d'}`;
      const res = await apiRequest<Record<string, unknown>>('GET', `/projects/${project_id}/usage${query}`);
      if (!res.ok) return textResult(formatError(res));
      return jsonResult(res.data);
    },
  );

  server.tool(
    'dailey_usage_summary',
    'Show this month\'s metered usage across the whole account: Dailey AI (tokens used, per-tier allowance remaining), Dailey Compute (GPU minutes), and Dailey Email (messages sent vs included) — each with the estimated overage cost — plus the prepaid credit balance that covers overage. Use this to answer "how much have I used?" and "how many credits do I have left?". Top up with dailey_credits_topup.',
    {
      month: z.string().optional().describe('Month as YYYY-MM (e.g., 2026-07). Defaults to the current month.'),
    },
    async ({ month }) => {
      const q = month ? `?month=${encodeURIComponent(month)}` : '';
      const res = await apiRequest<AccountUsageResponse>('GET', `/account/usage${q}`);
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      const lines: string[] = [`Dailey usage — ${d.month} (${d.plan} plan)`, ''];

      // Dailey AI
      lines.push('Dailey AI');
      if (d.ai.tiers.length === 0) {
        lines.push('  No AI usage this month.');
      } else {
        lines.push(`  ${n(d.ai.input_tokens + d.ai.output_tokens)} tokens across ${d.ai.tiers.length} tier(s), ${n(d.ai.requests)} requests`);
        for (const t of d.ai.tiers) {
          const base = t.allowance_tokens > 0
            ? `${n(t.used_tokens)} used / ${n(t.allowance_tokens)} allowance (${n(t.remaining_tokens)} left)`
            : `${n(t.used_tokens)} used (metered)`;
          const over = t.est_overage_cents > 0 ? `  ~${dollars(t.est_overage_cents)} overage` : '';
          lines.push(`  • ${t.tier}: ${base}${over}`);
        }
      }
      lines.push(`  Est. AI overage: ${dollars(d.ai.est_overage_cents)}`);
      lines.push('');

      // Dailey Compute
      lines.push('Dailey Compute (GPU)');
      if (d.compute.gpu_minutes === 0) {
        lines.push('  No GPU usage this month.');
      } else {
        lines.push(`  ${n(d.compute.gpu_minutes)} GPU-min across ${n(d.compute.jobs)} job(s) @ ${dollars(d.compute.rate_cents_per_minute)}/min → ~${dollars(d.compute.est_overage_cents)}`);
      }
      lines.push('');

      // Dailey Email
      lines.push('Dailey Email');
      if (!d.email.enabled) {
        lines.push('  Not enabled (add the Email add-on to send).');
      } else {
        lines.push(`  ${n(d.email.messages_sent)} / ${n(d.email.included)} sent (${n(d.email.remaining)} left)`);
        lines.push(`  Est. email overage: ${dollars(d.email.est_overage_cents)}`);
      }
      lines.push('');

      // Totals + credits
      lines.push(`Estimated overage this month: ${dollars(d.est_total_overage_cents)}`);
      if (d.credits.prepaid_enabled) {
        lines.push(`Prepaid credits: ${dollars(d.credits.balance_cents)} balance${d.credits.auto_recharge_enabled ? ' (auto-recharge on)' : ''}`);
        lines.push('  Covers metered overage plus real-time Images/Voice usage.');
        if (d.credits.balance_cents < d.est_total_overage_cents) {
          lines.push('  ⚠ Balance is below the estimated overage — top up with dailey_credits_topup.');
        }
      } else {
        lines.push('Prepaid credits: not enabled (overage is invoiced monthly). Enable prepaid with dailey_credits.');
      }

      return textResult(lines.join('\n'));
    },
  );
}
