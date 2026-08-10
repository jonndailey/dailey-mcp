import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { z } from 'zod';
import { getActiveAccount, setActiveAccount } from './api.js';
import { OWN_VERSION } from './version.js';
import { registerAuthTools } from './tools/auth.js';
import { registerAccountTools } from './tools/accounts.js';
import { registerProjectTools } from './tools/projects.js';
import { registerDeployTools } from './tools/deploy.js';
import { registerDeployStatusTools } from './tools/deploy-status.js';
import { registerBuildLogsTools } from './tools/build-logs.js';
import { registerScaleTools } from './tools/scale.js';
import { registerEnvTools } from './tools/env.js';
import { registerDomainTools } from './tools/domains.js';
import { registerDbTools } from './tools/db.js';
import { registerMigrateTools } from './tools/db-migrate.js';
import { registerExecRunTools } from './tools/exec-run.js';
import { registerProjectTransferTools } from './tools/project-transfer.js';
import { registerAdminTools } from './tools/admin.js';
import { registerUsageTools } from './tools/usage.js';
import { registerBillingTools } from './tools/billing.js';
import { registerPlatformTools } from './tools/platform.js';
import { registerStorageTools } from './tools/storage.js';
import { registerAiTools } from './tools/ai.js';
import { registerEmailTools } from './tools/email.js';
import { registerCreditTools } from './tools/credits.js';
import { registerAddonTools } from './tools/addons.js';
import { registerDaileyImagesTools } from './tools/dailey-images.js';
import { registerImageTools } from './tools/images.js';
import { registerProcessTools } from './tools/processes.js';
import { registerLifecycleTools } from './tools/lifecycle.js';
import { registerBackupTools } from './tools/backups.js';
import { registerWordPressMigrateTools } from './tools/wordpress-migrate.js';
import { registerWordPressImportTools } from './tools/wordpress-import.js';
import { registerWordPressSnapshotTools } from './tools/wordpress-snapshot.js';
import { registerWordPressLiveEditTools } from './tools/wordpress-live-edit.js';
import { registerWordPressTargetingTools } from './tools/wordpress-targeting.js';
import { registerEnvironmentTools } from './tools/environments.js';
import { registerResourceConfigTools } from './tools/resource-config.js';
import { registerLinkTools } from './tools/links.js';
import { registerCredentialRevealTools } from './tools/credentials-reveal.js';
import { registerAnalyzeTools } from './tools/analyze.js';
import { registerCliTools } from './tools/cli.js';
import { registerBundleTools } from './tools/bundle.js';
import { registerDiagnoseTools } from './tools/diagnose.js';
import { registerSupportTools } from './tools/support.js';

export interface BuildOptions {
  includeAdmin: boolean;
  includeLocalAuth: boolean;
  includeAccountSwitch: boolean;
  instructions?: string;
}

export function buildServer(opts: BuildOptions): McpServer {
  const server = new McpServer(
    {
      name: 'dailey-os',
      version: OWN_VERSION,
    },
    opts.instructions ? { instructions: opts.instructions } : undefined,
  );

  // ─── Account-context hardening (2026-07-13, Muenda's "which account am I in?") ───
  // Two invariants, applied uniformly to ALL tools via this registration wrapper:
  //   1. Every tool accepts an optional `account` param — a STATELESS, per-call
  //      scope to a managed account (set → run → restore). Agents no longer have
  //      to rely on dailey_use_account session state being what they remember.
  //   2. Every tool result is prefixed with `[account: <effective>]` so the model
  //      (and the human reading the transcript) always sees which account the
  //      call actually ran against. Wrong-account work becomes visible instantly.
  // Tools that declare their own `account` param (the WP tools) keep their schema;
  // the wrapper still enforces the per-call set/restore around them.
  {
    const originalTool = server.tool.bind(server);
    (server as any).tool = (name: string, description: string, schema: Record<string, unknown>, handler: (...a: any[]) => any) => {
      const augmented = 'account' in schema
        ? schema
        : {
            ...schema,
            account: z.string().optional().describe(
              'Managed-account slug to run THIS call against (per-call scope; overrides the dailey_use_account session state for this call only). Omit to use the current session account.',
            ),
          };
      return originalTool(name, description, augmented as any, async (args: any, extra: any) => {
        const requested: string | undefined =
          typeof args?.account === 'string' && args.account.trim() ? args.account.trim() : undefined;
        const prev = getActiveAccount();
        if (requested) setActiveAccount(requested);
        try {
          const result = await handler(args, extra);
          const effective = requested ?? getActiveAccount() ?? 'self (your own account)';
          if (result?.content?.length && result.content[0]?.type === 'text') {
            result.content[0].text = `[account: ${effective}]\n${result.content[0].text}`;
          }
          return result;
        } finally {
          // Restore ONLY when this call temporarily overrode the session scope —
          // dailey_use_account itself must keep its session-setting behavior.
          if (requested) setActiveAccount(prev);
        }
      });
    };
  }

  // Core + identity
  if (opts.includeLocalAuth) registerAuthTools(server);
  registerAccountTools(server, {
    includeSwitch: opts.includeAccountSwitch,
    remoteHint: !opts.includeAccountSwitch,
  });
  registerPlatformTools(server);
  registerUsageTools(server);
  registerBillingTools(server);
  // À-la-carte billing surfaces — prepaid credits + capacity add-ons.
  registerCreditTools(server);
  registerAddonTools(server);

  // Projects + deploys
  registerProjectTools(server);
  registerAnalyzeTools(server);
  registerDeployTools(server);
  registerDeployStatusTools(server);
  registerBuildLogsTools(server);
  registerImageTools(server);

  // Lifecycle + scaling
  registerScaleTools(server);
  registerLifecycleTools(server);
  registerResourceConfigTools(server);
  registerProcessTools(server);

  // Config
  registerEnvTools(server);
  registerDomainTools(server);
  registerLinkTools(server);
  registerCredentialRevealTools(server);

  // Data
  registerDbTools(server);
  registerMigrateTools(server);
  registerStorageTools(server);
  registerAiTools(server);
  registerEmailTools(server);
  registerDaileyImagesTools(server);
  registerBackupTools(server);
  registerWordPressMigrateTools(server);
  registerWordPressImportTools(server);
  registerWordPressSnapshotTools(server);
  // WordPress live-edit tools (files/media/wp-cli) wrapping customer-api#18's
  // tenant-scoped live-edit routes. Mutating ops are two-phase (preview → confirm_token).
  registerWordPressLiveEditTools(server);
  // Scenario 1 create + WP targeting spine (list/target), paired with the
  // customer-api targeting-spine deploy.
  registerWordPressTargetingTools(server);
  registerEnvironmentTools(server);

  // Runtime operations — exec into a pod, run one-off jobs
  registerExecRunTools(server);

  // Admin-only — customer onboarding, project transfer
  if (opts.includeAdmin) {
    registerAdminTools(server);
    registerProjectTransferTools(server);
  }

  // CLI assist
  registerCliTools(server);

  // Atomic deploy bundle
  registerBundleTools(server);

  // One-stop health check — first tool to reach for when something is broken
  registerDiagnoseTools(server);

  // Support — escalate to Dailey OS team
  registerSupportTools(server);

  return server;
}
