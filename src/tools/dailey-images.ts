/**
 * Dailey Images — AI image generation MCP tools (mirror of tools/ai.ts).
 *
 * Backend gateway lives at customer-api routes/images.ts, mounted on
 * /api/projects. OpenAI-Images-compatible. Metered per image from prepaid
 * credits: Fast (dailey-fast, Flux-schnell) 2¢/image, Pro (dailey-pro,
 * Flux 1.1-pro) 10¢/image.
 *
 * NOTE: this is a separate file from tools/images.ts (which holds the Docker
 * container-image tools like dailey_run_image) to avoid clobbering it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface ImagesInfoResponse {
  project: { id: string; slug: string };
  images: {
    enabled: boolean;
    env_injected: boolean;
    tiers: string[];
    default_tier: string;
    base_url: string;
    generations_url: string;
    env_vars: string[];
    enable_with: string | null;
  };
  integration: { images: string };
  warnings: string[];
  docs_url: string;
}

interface ImagesEnableResponse {
  ok: boolean;
  project_id: string;
  images_enabled: boolean;
  url: string;
  key_masked: string;
  restart_required: boolean;
  default_tier: string;
  docs_url: string;
}

interface GenerationsResponse {
  created: number;
  data: Array<{ url?: string; b64_json?: string }>;
  _served_by: { provider: string; model: string; tier: string };
}

// Per-image price (cents) by tier, for the cost note.
const TIER_CENTS: Record<string, number> = {
  'dailey-fast': 2,
  'dailey-pro': 10,
};

export function registerDaileyImagesTools(server: McpServer) {
  server.tool(
    'dailey_images_generate',
    'Generate images with Dailey Images (AI). METERED from prepaid credits: model="dailey-fast" (Flux-schnell) is 2¢/image, model="dailey-pro" (Flux 1.1-pro) is 10¢/image. Returns the image URL(s) and which tier/model served the request. Images must be enabled for the project first (dailey_images_enable).',
    {
      project: z.string().describe('The project ID or slug'),
      prompt: z.string().describe('Text prompt describing the image to generate'),
      model: z
        .enum(['dailey-fast', 'dailey-pro'])
        .optional()
        .describe('Tier: dailey-fast (Flux-schnell, 2¢/image, default) or dailey-pro (Flux 1.1-pro, 10¢/image)'),
      size: z.string().optional().describe('Image size/aspect, e.g. "landscape_16_9", "square_hd", "portrait_4_3"'),
      n: z.number().int().min(1).max(4).optional().describe('Number of images to generate (1..4). Default 1.'),
    },
    async ({ project, prompt, model, size, n }) => {
      const tier = model || 'dailey-fast';
      const body: Record<string, unknown> = { prompt, model: tier };
      if (size != null) body.size = size;
      if (n != null) body.n = n;

      const res = await apiRequest<GenerationsResponse>(
        'POST', `/projects/${project}/images/generations`, body);
      if (!res.ok) return textResult(formatError(res));

      const d = res.data;
      const served = d._served_by;
      const perImage = TIER_CENTS[served?.tier || tier] ?? TIER_CENTS[tier];
      const count = d.data?.length ?? 0;
      const urls = (d.data || []).map((im, i) =>
        im.url ? `  ${i + 1}. ${im.url}` : `  ${i + 1}. (b64_json returned, ${(im.b64_json || '').length} chars)`);

      const lines = [
        `Generated ${count} image${count === 1 ? '' : 's'} — ${served?.tier || tier} (${served?.model || 'unknown model'}, via ${served?.provider || 'unknown'})`,
        ...urls,
        '',
        `Cost: ${perImage}¢/image × ${count} = ${perImage * count}¢, drawn from prepaid credits.`,
      ];
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_images_enable',
    'Enable Dailey Images (AI image generation) for a project. Mints a capability-scoped key and injects DAILEY_IMAGE_BASE_URL/KEY/TIER into the project env (applies on next deploy). Usage is metered from prepaid credits (dailey-fast 2¢/image, dailey-pro 10¢/image).',
    { project: z.string().describe('The project ID or slug') },
    async ({ project }) => {
      const res = await apiRequest<ImagesEnableResponse>(
        'POST', `/projects/${project}/images/enable`, {});
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      const lines = [
        'Dailey Images enabled.',
        `  base url:      ${d.url}`,
        `  key:           ${d.key_masked}`,
        `  default tier:  ${d.default_tier}`,
        '  tiers:         dailey-fast (2¢/image), dailey-pro (10¢/image)',
        ...(d.restart_required ? ['', 'Redeploy the project (dailey_deploy) to pick up the DAILEY_IMAGE_* env vars.'] : []),
        '',
        `Docs: ${d.docs_url}`,
      ];
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_images_info',
    'Show whether Dailey Images (AI image generation) is enabled for a project, whether its DAILEY_IMAGE_* env vars are injected into the pod, the available tiers, and how to wire it up. Enable with dailey_images_enable.',
    { project: z.string().describe('The project ID or slug') },
    async ({ project }) => {
      const res = await apiRequest<ImagesInfoResponse>('GET', `/projects/${project}/images/info`);
      if (!res.ok) return textResult(formatError(res));
      const d = res.data;
      const lines = [
        `Dailey Images: ${d.project.slug}`,
        '',
        `  enabled:       ${d.images.enabled ? 'ON' : 'off'}`,
        `  env injected:  ${d.images.env_injected ? 'yes' : 'no'}`,
        `  tiers:         ${d.images.tiers.join(', ')}  (dailey-fast 2¢/image, dailey-pro 10¢/image)`,
        `  default tier:  ${d.images.default_tier}`,
        `  base url:      ${d.images.base_url}`,
        `  env vars:      ${d.images.env_vars.join(', ')}`,
        ...(d.images.enable_with ? [`  enable:        ${d.images.enable_with}  (or dailey_images_enable)`] : []),
        '',
        'Integration (OpenAI-compatible):',
        `  ${d.integration.images}`,
      ];
      if (d.warnings && d.warnings.length) {
        lines.push('');
        for (const w of d.warnings) lines.push(`⚠ ${w}`);
      }
      lines.push('', `Docs: ${d.docs_url}`);
      lines.push('Note: injected env applies on the NEXT deploy — redeploy after enabling.');
      return textResult(lines.join('\n'));
    },
  );
}
