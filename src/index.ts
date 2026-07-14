#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { z } from 'zod';
import { hasCredentials, getActiveAccount, setActiveAccount } from './api.js';
import { OWN_VERSION, checkForNewerVersion, outdatedNotice } from './version.js';
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

function writeStream(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve) => {
    stream.write(text, () => resolve());
  });
}

async function preflight(): Promise<void> {
  const isInteractive = Boolean(process.stdin.isTTY);

  if (!hasCredentials()) {
    const msg =
      'Missing credentials. Set DAILEY_API_TOKEN, or DAILEY_EMAIL + DAILEY_PASSWORD.';

    if (isInteractive) {
      await writeStream(
        process.stderr,
        '\n' +
          'dailey-mcp: ' + msg + '\n\n' +
          'This is an MCP stdio server — it is meant to be spawned by an MCP client\n' +
          '(Claude Code, Cursor, etc.) which will send JSON-RPC messages on stdin.\n' +
          'Running it directly in a shell is not how you use it.\n\n' +
          'Add it to your client config like this:\n' +
          '  {\n' +
          '    "mcpServers": {\n' +
          '      "dailey-os": {\n' +
          '        "command": "npx",\n' +
          '        "args": ["-y", "@daileyos/mcp-server"],\n' +
          '        "env": { "DAILEY_API_TOKEN": "..." }\n' +
          '      }\n' +
          '    }\n' +
          '  }\n\n' +
          'Docs: https://docs.dailey.cloud/mcp/getting-started\n\n'
      );
    } else {
      // Best-effort: some MCP clients surface unsolicited log notifications
      // that arrive before the initialize handshake. Emit a structured JSON-RPC
      // message so the client has something to render other than "process exited".
      const note = {
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: {
          level: 'error',
          logger: 'dailey-mcp',
          data: msg + ' See https://docs.dailey.cloud/mcp/getting-started',
        },
      };
      await writeStream(process.stdout, JSON.stringify(note) + '\n');
      await writeStream(process.stderr, 'dailey-mcp: ' + msg + '\n');
    }
    process.exit(1);
  }

  if (isInteractive) {
    await writeStream(
      process.stderr,
      '\n' +
        'dailey-mcp: MCP stdio server running.\n' +
        'This server speaks JSON-RPC 2.0 on stdin/stdout — it is driven by an MCP\n' +
        'client (Claude Code, Cursor, etc.), not typed into directly. If you were\n' +
        'trying to update it, you do not need to — `npx @daileyos/mcp-server` in\n' +
        'your client config pulls latest at each session start.\n' +
        'Press Ctrl+C to exit.\n\n'
    );
  }
}

await preflight();

// Staleness self-check (2026-07-13 incident: sessions silently ran a months-old
// MCP and the agent concluded platform features didn't exist). Fail-open + hard
// timeout; when outdated, the notice rides the server instructions so the AGENT
// itself tells the user to update instead of silently missing tools.
const newerVersion = await checkForNewerVersion();
if (newerVersion) {
  process.stderr.write(`dailey-mcp: v${OWN_VERSION} is outdated (latest v${newerVersion})\n`);
}

const server = new McpServer(
  {
    name: 'dailey-os',
    version: OWN_VERSION,
  },
  newerVersion ? { instructions: outdatedNotice(newerVersion) } : undefined,
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
registerAuthTools(server);
registerAccountTools(server);
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
registerAdminTools(server);
registerProjectTransferTools(server);

// CLI assist
registerCliTools(server);

// Atomic deploy bundle
registerBundleTools(server);

// One-stop health check — first tool to reach for when something is broken
registerDiagnoseTools(server);

// Support — escalate to Dailey OS team
registerSupportTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
