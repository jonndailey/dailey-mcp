import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface AnalyzeResponse {
  _isDockerImage?: boolean;
  image?: {
    registry?: string;
    size_mb?: number;
    port?: number;
    catalog_match?: string;
    description?: string;
  };
  database?: { needed?: boolean };
  estimates?: { pull_time_seconds?: number; deploy_time_seconds?: number };
  issues?: string[];
  stack?: { name?: string; version?: string };
  services_manifest?: {
    entries?: Array<{
      name: string;
      type: string;
      provider?: string;
      dockerfile?: string;
      buildContext?: string;
    }>;
  };
  recommendations?: string[];
}

export function registerAnalyzeTools(server: McpServer) {
  server.tool(
    'dailey_analyze_repo',
    'Analyze a Git repo or Docker image BEFORE creating a project — detects stack, Dockerfile, database needs, and multi-service manifest (dailey.yaml). Use this to preview what a deploy would do.',
    {
      repo_url: z.string().describe('Git repo URL or Docker image (e.g., github.com/user/repo, wordpress:6-apache)'),
      branch: z.string().optional().describe('Branch to analyze (default: main)'),
    },
    async ({ repo_url, branch }) => {
      const res = await apiRequest<AnalyzeResponse>('POST', '/projects/analyze', {
        repo_url,
        branch: branch || 'main',
      });
      if (!res.ok) return textResult(formatError(res));

      const d = res.data;
      const lines: string[] = [`Analysis: ${repo_url}`, '─'.repeat(50)];

      if (d._isDockerImage) {
        lines.push(`Type:       Docker image`);
        lines.push(`Registry:   ${d.image?.registry || 'Docker Hub'}`);
        lines.push(`Size:       ${d.image?.size_mb ?? '?'} MB`);
        lines.push(`Port:       ${d.image?.port ?? 3000}`);
        lines.push(`DB needed:  ${d.database?.needed ? 'yes' : 'no'}`);
        if (d.image?.catalog_match) lines.push(`Catalog:    ✓ ${d.image.catalog_match}`);
        if (d.image?.description) lines.push(`Description: ${d.image.description}`);
      } else {
        lines.push(`Type:       Git repo`);
        lines.push(`Branch:     ${branch || 'main'}`);
        if (d.stack?.name) {
          lines.push(`Stack:      ${d.stack.name}${d.stack.version ? ` ${d.stack.version}` : ''}`);
        }
        lines.push(`DB needed:  ${d.database?.needed ? 'yes' : 'no'}`);
      }

      if (d.services_manifest?.entries?.length) {
        lines.push('');
        lines.push(`Multi-service manifest found (${d.services_manifest.entries.length} services):`);
        for (const e of d.services_manifest.entries) {
          lines.push(`  • ${e.name} [${e.type}]${e.provider ? ` provider=${e.provider}` : ''}${e.dockerfile ? ` dockerfile=${e.dockerfile}` : ''}`);
        }
        lines.push('');
        lines.push('Tip: this project will be deployed via dailey_deploy_multi.');
      }

      if (d.estimates) {
        lines.push('');
        lines.push(`Estimates:  pull ~${d.estimates.pull_time_seconds}s, deploy ~${d.estimates.deploy_time_seconds}s`);
      }

      if (d.recommendations?.length) {
        lines.push('');
        lines.push('Recommendations:');
        for (const r of d.recommendations) lines.push(`  • ${r}`);
      }

      if (d.issues?.length) {
        lines.push('');
        lines.push('❌ Blocking issues:');
        for (const issue of d.issues) lines.push(`  ✗ ${issue}`);
      } else {
        lines.push('');
        lines.push('✓ Ready to deploy via dailey_create_project + dailey_deploy_multi, or dailey_run_image.');
      }

      return textResult(lines.join('\n'));
    },
  );
}
