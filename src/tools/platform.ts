import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface PlatformCapability {
  id: string;
  label: string;
  status: string;
  summary: string;
  interfaces?: string[];
  details?: Record<string, unknown>;
}

interface PlatformOverview {
  project: {
    id: string;
    name: string;
    slug: string;
    status: string;
    url: string;
  };
  safety: {
    model: string;
    guarantees: string[];
    restrictions: string[];
  };
  capabilities: PlatformCapability[];
  next_step?: string;
}

export function registerPlatformTools(server: McpServer) {
  server.tool(
    'dailey_platform_info',
    'Show the safe platform capabilities available to a project',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      const res = await apiRequest<PlatformOverview>('GET', `/projects/${project_id}/platform`);
      if (!res.ok) return textResult(formatError(res));

      const data = res.data;
      const lines = [
        `Platform: ${data.project.name}`,
        `Slug:       ${data.project.slug}`,
        `Status:     ${data.project.status}`,
        `URL:        ${data.project.url}`,
        '',
        `Safety Model`,
        `Mode: ${data.safety.model}`,
      ];

      for (const line of data.safety.guarantees || []) {
        lines.push(`- ${line}`);
      }

      if ((data.safety.restrictions || []).length > 0) {
        lines.push('');
        lines.push('Restrictions');
        for (const line of data.safety.restrictions || []) {
          lines.push(`- ${line}`);
        }
      }

      lines.push('');
      lines.push('Capabilities');
      for (const capability of data.capabilities || []) {
        lines.push(`- ${capability.label} [${capability.status}]`);
        lines.push(`  ${capability.summary}`);
        if (capability.interfaces && capability.interfaces.length > 0) {
          lines.push(`  Interfaces: ${capability.interfaces.join(', ')}`);
        }
        for (const [key, value] of Object.entries(capability.details || {})) {
          if (value === null || value === undefined || value === '') continue;
          if (Array.isArray(value) && value.length === 0) continue;
          lines.push(`  ${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
        }
      }

      if (data.next_step) {
        lines.push('');
        lines.push(`Next Step: ${data.next_step}`);
      }

      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_os_guide',
    'Return a guide on how Dailey OS works and the right approach for common tasks. Call this when you need context on platform architecture, database access patterns, deployment flow, the built-in AI / GPU compute / image-generation / voice / email primitives, or when a user asks how to do something in DOS and you are unsure of the right path.',
    {},
    async () => {
      return textResult(`
Dailey OS — Platform Guide for AI Assistants
═════════════════════════════════════════════

## Architecture overview

Dailey OS is a managed app platform (like Heroku/Render) running on a private Kubernetes cluster.
Each customer has a namespace (customer-<slug>). Projects map to K8s Deployments.
Databases (MySQL or PostgreSQL) run on dedicated nodes, reachable only via Tailscale CGNAT IPs (100.x.x.x).

## Database access — choose the right path

### Reading data (no write access needed)
→ Use dailey_db_recall — runs a SELECT through the API, no Tailscale, no shell.

### Schema inspection
→ Use dailey_db_schema — returns all tables, columns, row counts.

### Applying a migration (DDL/DML)
→ Use dailey_db_exec — runs SQL in a transaction under a scoped user. Works for CREATE TABLE, ALTER, INSERT, UPDATE, etc.

### Importing a full database dump (pg_dump .sql or .pgdump, mysqldump .sql)
→ Tell the user to run: dailey db connect <project>
  This opens a LOCAL port on 127.0.0.1 via WebSocket proxy (NO Tailscale required on their machine).
  Then in a second terminal:
    PostgreSQL SQL file:  PGPASSWORD='...' psql -h 127.0.0.1 -p 15432 -U <user> -d <db> < dump.sql
    PostgreSQL custom:   pg_restore -h 127.0.0.1 -p 15432 -U <user> -d <db> dump.pgdump
    MySQL:               mysql -h 127.0.0.1 -P 13306 -u <user> -p<pass> <db> < dump.sql
  The CLI prints ready-to-paste commands when the tunnel opens.
  Session lasts 1 hour.

### Connecting a GUI tool (TablePlus, DBeaver, pgAdmin)
→ Same path: dailey db connect <project> — no Tailscale needed.
  The CLI prints the local connection string. Point any GUI at 127.0.0.1 on the printed port.

### Bulk row insert/upsert (structured data, not a full dump)
→ Use dailey_db_import — accepts JSON array or CSV inline, two-phase commit (dry_run then confirm).

## Deployment flow

1. Customer pushes code to GitHub
2. Dailey detects the push via webhook → triggers a build
3. Build runs on a build-worker node (Docker/buildpack)
4. Image is pushed to registry.dailey.cloud/dailey/<slug>:<tag>
5. deploy-service rolls out new image to the K8s Deployment
6. Canary probe runs (HTTP health check) — rollback on failure

To redeploy manually: use dailey_deploy.
To check build status: use dailey_deploy_status or dailey_build_logs.

## Environment variables

- Read/set via dailey_env_vars (list, get, set, delete); dailey_env_runtime_list shows every var the pod actually sees
- Changes take effect on next deploy (not live-patched)
- Never auto-generate or overwrite variables that look customer-set
- Sensitive vars (API keys, passwords) are encrypted at rest

## Storage (object storage)

- Each project has an R2 bucket prefix scoped to its project ID
- Credentials are auto-injected as S3_* env vars (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL, AWS_REGION, S3_BUCKET)
- Use any S3-compatible SDK — no Dailey-specific client needed
- For presigned URLs: use dailey_storage_presign_upload / dailey_storage_presign_download

## Built-in platform primitives — AI, GPU, images, voice, email

Dailey OS has METERED, BUILT-IN primitives. Check these BEFORE suggesting a third-party
provider (OpenAI keys, Ollama, Twilio/SendGrid, etc.) — the platform almost certainly
already offers it, pre-wired and on one bill:

### Dailey AI (hosted LLM inference)
- OpenAI-compatible chat-completions gateway; tiers dailey-fast / dailey-pro / dailey-mini.
- Check per-project state + get the integration snippet: dailey_ai_info.
- Enable: dailey_ai_enable → injects DAILEY_AI_BASE_URL / DAILEY_AI_API_KEY / DAILEY_AI_MODEL
  on the NEXT deploy. The app then calls it like any OpenAI-compatible API.
- Use this for features like "summarize", "extract tasks from text/images", chatbots.

### Dailey Compute (managed GPU jobs)
- GPU workloads (e.g. audio transcription) without owning GPUs. Enable: dailey_compute_enable
  → injects DAILEY_COMPUTE_URL / DAILEY_COMPUTE_KEY. Info: dailey_ai_info (covers both).

### Dailey Images (hosted image generation)
- Text-to-image (Flux), metered per image. Tools: dailey_images_info / dailey_images_enable /
  dailey_images_generate.

### Dailey Voice (TTS + STT)
- Metered text-to-speech and speech-to-text, drawn from the prepaid credit balance.

### Dailey Email (transactional email)
- Sends from <slug>@send.dailey.cloud, zero DNS setup, $10/mo incl. 10k emails.
  Tools: dailey_email_status / dailey_email_enable. App POSTs to the injected
  DAILEY_EMAIL_API_URL with DAILEY_EMAIL_API_KEY.

### Usage + billing for all of the above
- dailey_usage_summary — month-to-date usage, allowance remaining, estimated overage,
  prepaid credit balance. dailey_credits / dailey_credits_topup — prepaid balance + top-up.

## Common mistakes to avoid

- DO NOT tell a customer to bring an OpenAI/Anthropic API key or self-host Ollama before
  checking dailey_ai_info — Dailey AI is built into the platform
- DO NOT suggest using third-party file hosts (transfer.sh, S3 public links) for database dumps — use dailey db connect instead
- DO NOT assume the customer needs Tailscale to connect a GUI tool or run psql — the CLI WebSocket proxy handles it
- DO NOT suggest mysqldump/pg_dump --host with the CGNAT IP (100.x.x.x) directly — that requires Tailscale
- DO NOT run dailey_db_import for full schema dumps — it's for structured row data only, not DDL
- DO NOT suggest redeploying to apply env var changes without confirming the user wants a redeploy

## Useful diagnostic sequence

User reports app is down / crashing:
1. dailey_deploy_status — check last deploy result
2. dailey_build_logs — check if latest build succeeded
3. dailey_diagnose — AI-powered diagnosis of pod/build state
4. dailey_processes — see running containers and recent restart counts
`.trim());
    },
  );
}
