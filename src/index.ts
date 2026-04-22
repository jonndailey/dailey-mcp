#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { hasCredentials } from './api.js';
import { registerAuthTools } from './tools/auth.js';
import { registerProjectTools } from './tools/projects.js';
import { registerDeployTools } from './tools/deploy.js';
import { registerDeployStatusTools } from './tools/deploy-status.js';
import { registerBuildLogsTools } from './tools/build-logs.js';
import { registerScaleTools } from './tools/scale.js';
import { registerEnvTools } from './tools/env.js';
import { registerDomainTools } from './tools/domains.js';
import { registerDbTools } from './tools/db.js';
import { registerUsageTools } from './tools/usage.js';
import { registerBillingTools } from './tools/billing.js';
import { registerPlatformTools } from './tools/platform.js';
import { registerStorageTools } from './tools/storage.js';
import { registerImageTools } from './tools/images.js';
import { registerProcessTools } from './tools/processes.js';
import { registerLifecycleTools } from './tools/lifecycle.js';
import { registerBackupTools } from './tools/backups.js';
import { registerResourceConfigTools } from './tools/resource-config.js';
import { registerLinkTools } from './tools/links.js';
import { registerCredentialRevealTools } from './tools/credentials-reveal.js';
import { registerAnalyzeTools } from './tools/analyze.js';
import { registerCliTools } from './tools/cli.js';

function preflight(): void {
  const isInteractive = Boolean(process.stdin.isTTY);

  if (!hasCredentials()) {
    const msg =
      'Missing credentials. Set DAILEY_API_TOKEN, or DAILEY_EMAIL + DAILEY_PASSWORD.';

    if (isInteractive) {
      process.stderr.write(
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
      process.stdout.write(JSON.stringify(note) + '\n');
      process.stderr.write('dailey-mcp: ' + msg + '\n');
    }
    process.exit(1);
  }

  if (isInteractive) {
    process.stderr.write(
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

preflight();

const server = new McpServer({
  name: 'dailey-os',
  version: '1.1.0',
});

// Core + identity
registerAuthTools(server);
registerPlatformTools(server);
registerUsageTools(server);
registerBillingTools(server);

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
registerStorageTools(server);
registerBackupTools(server);

// CLI assist
registerCliTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
