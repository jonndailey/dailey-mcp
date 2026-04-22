import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface Domain {
  hostname: string;
  is_default?: boolean;
  verified?: boolean;
  cert_status?: string;
  cert_issuer?: string;
  removable?: boolean;
  created_at?: string;
}

interface DnsCheckResponse {
  domain: string;
  expected_cname: string;
  expected_a_records: string[];
  actual_cname: string[];
  actual_a_records: string[];
  matched: boolean;
  match_type: string | null;
  cloudflare_proxied: boolean;
  hint: string;
}

interface CertStatusResponse {
  domain: string;
  cert: {
    subject_cn?: string;
    subject_alt_names?: string[];
    issuer?: string;
    valid_from?: string;
    valid_to?: string;
    days_remaining?: number | null;
  } | null;
  status: string;
  hint: string;
}

export function registerDomainTools(server: McpServer) {
  server.tool(
    'dailey_domains',
    'Manage custom domains: list, add, remove, check DNS, or check TLS cert status for a custom domain.',
    {
      project_id: z.string().describe('The project ID'),
      action: z.enum(['list', 'add', 'remove', 'dns_check', 'cert_status']).describe('list | add | remove | dns_check | cert_status'),
      domain: z.string().optional().describe('Domain name (required for add/remove/dns_check/cert_status)'),
    },
    async ({ project_id, action, domain }) => {
      if (action === 'list') {
        const res = await apiRequest<{ domains: Domain[] }>('GET', `/projects/${project_id}/domains`);
        if (!res.ok) return textResult(formatError(res));

        const domains = res.data.domains;
        if (!domains || domains.length === 0) {
          return textResult('No custom domains configured.');
        }

        const lines = [`Domains (${domains.length})`, '─'.repeat(60)];
        for (const d of domains) {
          const flags: string[] = [];
          if (d.is_default) flags.push('default');
          if (d.verified) flags.push('verified');
          if (d.cert_status) flags.push(`cert=${d.cert_status}`);
          lines.push(`${d.hostname}${flags.length ? `  [${flags.join(', ')}]` : ''}`);
        }
        return textResult(lines.join('\n'));
      }

      if (action === 'add') {
        if (!domain) return textResult('Error: domain is required for add action.');
        const res = await apiRequest<any>('POST', `/projects/${project_id}/domains`, { hostname: domain });
        if (!res.ok) return textResult(formatError(res));
        const d = res.data;
        const lines = [`Domain ${d.hostname || domain} added.`, ''];
        if (d.instructions) {
          lines.push(d.instructions);
          lines.push('');
        }
        lines.push(`After DNS propagates (~1-60 min):`);
        lines.push(`  1. dailey_domains action=dns_check domain=${domain} — verify DNS`);
        lines.push(`  2. Let's Encrypt issues a cert automatically (~30s)`);
        lines.push(`  3. dailey_domains action=cert_status domain=${domain} — confirm cert`);
        return textResult(lines.join('\n'));
      }

      if (action === 'remove') {
        if (!domain) return textResult('Error: domain is required for remove action.');
        const res = await apiRequest('DELETE', `/projects/${project_id}/domains`, { hostname: domain });
        if (!res.ok) return textResult(formatError(res));
        return textResult(`Domain ${domain} removed.`);
      }

      if (action === 'dns_check') {
        if (!domain) return textResult('Error: domain is required for dns_check.');
        const res = await apiRequest<DnsCheckResponse>(
          'GET',
          `/projects/${project_id}/domains/dns-check?domain=${encodeURIComponent(domain)}`,
        );
        if (!res.ok) return textResult(formatError(res));

        const d = res.data;
        const lines = [
          `DNS check for ${d.domain}`,
          '─'.repeat(50),
          `Expected CNAME:   ${d.expected_cname}`,
          `Expected A:       ${d.expected_a_records?.join(', ') || '-'}`,
          `Actual CNAME:     ${d.actual_cname?.join(', ') || '(none)'}`,
          `Actual A:         ${d.actual_a_records?.join(', ') || '(none)'}`,
          `Match:            ${d.matched ? '✅ yes' : '❌ no'} ${d.match_type ? `(${d.match_type})` : ''}`,
          `Cloudflare proxy: ${d.cloudflare_proxied ? 'yes' : 'no'}`,
          '',
          `Hint: ${d.hint}`,
        ];
        return textResult(lines.join('\n'));
      }

      if (action === 'cert_status') {
        if (!domain) return textResult('Error: domain is required for cert_status.');
        const res = await apiRequest<CertStatusResponse>(
          'GET',
          `/projects/${project_id}/domains/cert-status?domain=${encodeURIComponent(domain)}`,
        );
        if (!res.ok) return textResult(formatError(res));

        const d = res.data;
        if (!d.cert) {
          return textResult([
            `Cert status for ${d.domain}`,
            '─'.repeat(50),
            `Status: ${d.status}`,
            '',
            `Hint: ${d.hint}`,
          ].join('\n'));
        }
        const lines = [
          `Cert status for ${d.domain}`,
          '─'.repeat(50),
          `Status:       ${d.status}`,
          `Subject:      ${d.cert.subject_cn || '-'}`,
          `SANs:         ${d.cert.subject_alt_names?.join(', ') || '-'}`,
          `Issuer:       ${d.cert.issuer || '-'}`,
          `Valid from:   ${d.cert.valid_from || '-'}`,
          `Valid to:     ${d.cert.valid_to || '-'}`,
          `Days left:    ${d.cert.days_remaining ?? '-'}`,
          '',
          `Hint: ${d.hint}`,
        ];
        return textResult(lines.join('\n'));
      }

      return textResult('Error: Invalid action. Use list, add, remove, dns_check, or cert_status.');
    },
  );
}
