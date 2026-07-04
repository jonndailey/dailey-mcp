import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

// À-la-carte capacity add-ons (pay-at-purchase Stripe subscriptions):
//   extra_vcpu, extra_ram, extra_db_storage, extra_object_storage,
//   db_replica, app_ha, email_pro (+ managed_ops / extra_core_users_*).
// GET /billing/addons = active add-ons; GET /billing/addons/catalog = available
// types + pricing. POST /billing/addons returns { checkout_url } (pay first) or,
// when no Stripe price is configured, provisions immediately ({ addon, message }).
interface ActiveAddon {
  id: string;
  addon_type: string;
  quantity: number;
  status: string;
  created_at?: string;
  unit_price?: number;
  unit_label?: string;
  monthly_cost?: number;
}
interface AddonsListResponse {
  addons: ActiveAddon[];
  total_monthly: number;
}
interface CatalogItem {
  type: string;
  name: string;
  unit_price: number;
  unit_label: string;
  description: string;
}
interface CatalogResponse {
  addons: CatalogItem[];
}
interface AddonPurchaseResponse {
  checkout_url?: string | null;
  session_id?: string;
  addon?: { id: string; addon_type: string; quantity: number; unit_price: number; monthly_cost: number };
  message?: string;
  note?: string;
}

export function registerAddonTools(server: McpServer) {
  server.tool(
    'dailey_addons',
    'List à-la-carte capacity add-ons: the account\'s ACTIVE add-ons (with monthly cost) plus the AVAILABLE catalog (extra_vcpu, extra_ram, extra_db_storage, extra_object_storage, db_replica, app_ha, email_pro, ...) and per-unit pricing. Purchase with dailey_addon_purchase; cancel with dailey_addon_cancel.',
    {},
    async () => {
      const [activeRes, catalogRes] = await Promise.all([
        apiRequest<AddonsListResponse>('GET', '/billing/addons'),
        apiRequest<CatalogResponse>('GET', '/billing/addons/catalog'),
      ]);
      if (!activeRes.ok) return textResult(formatError(activeRes));

      const lines: string[] = ['Active add-ons:'];
      const active = activeRes.data.addons || [];
      if (active.length === 0) {
        lines.push('  (none)');
      } else {
        for (const a of active) {
          lines.push(
            `  ${a.id}  ${a.addon_type} x${a.quantity}  $${a.monthly_cost ?? 0}/mo  [${a.status}]`,
          );
        }
        lines.push(`  Total: $${activeRes.data.total_monthly ?? 0}/mo`);
      }

      if (catalogRes.ok) {
        lines.push('');
        lines.push('Available add-ons (catalog):');
        for (const c of catalogRes.data.addons || []) {
          lines.push(`  ${c.type}  $${c.unit_price}/${c.unit_label}  — ${c.description || c.name}`);
        }
      }
      lines.push('');
      lines.push('Purchase: dailey_addon_purchase (type[, quantity]) → returns a Stripe Checkout URL to pay.');
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_addon_purchase',
    'Purchase an à-la-carte capacity add-on (extra_vcpu, extra_ram, extra_db_storage, extra_object_storage, db_replica, app_ha, email_pro, ...). PAY-AT-PURCHASE and billing-owner-only: the normal response is a Stripe Checkout URL the user MUST open to pay the monthly subscription before the capacity is granted — do NOT treat the add-on as active until payment completes. (Some early-stage types with no Stripe price provision immediately.) See dailey_addons for valid types + pricing.',
    {
      addon_type: z.string().describe('Add-on type, e.g. extra_vcpu, extra_ram, extra_db_storage, extra_object_storage, db_replica, app_ha, email_pro'),
      quantity: z.number().int().min(1).optional().describe('Number of units (default 1)'),
    },
    async ({ addon_type, quantity }) => {
      const body: Record<string, unknown> = { addon_type };
      if (typeof quantity === 'number') body.quantity = quantity;
      const res = await apiRequest<AddonPurchaseResponse>('POST', '/billing/addons', body);
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      if (d.checkout_url) {
        return textResult(
          [
            `Add-on "${addon_type}" x${quantity ?? 1} — pay-at-purchase.`,
            '',
            '➜ Open this URL to complete the subscription payment:',
            d.checkout_url,
            '',
            'The capacity is granted automatically once the Stripe Checkout is paid. It is NOT active yet.',
          ].join('\n'),
        );
      }
      // No Stripe price configured — provisioned immediately.
      const lines = [d.message || `Add-on "${addon_type}" added.`];
      if (d.addon) lines.push(`id: ${d.addon.id}  $${d.addon.monthly_cost}/mo`);
      if (d.note) lines.push(d.note);
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_addon_cancel',
    'Cancel an active à-la-carte add-on by its add-on id (from dailey_addons). Cancels the Stripe subscription item and removes the capacity from the account quota. Billing-owner-only.',
    { addon_id: z.string().describe('The add-on id to cancel (from dailey_addons)') },
    async ({ addon_id }) => {
      const res = await apiRequest<{ message: string; addon_id: string }>('DELETE', `/billing/addons/${addon_id}`);
      if (!res.ok) return textResult(formatError(res));
      return textResult(`${res.data.message || 'Add-on cancelled'} (${res.data.addon_id || addon_id}).`);
    },
  );
}
