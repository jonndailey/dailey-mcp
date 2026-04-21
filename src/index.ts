#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

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
