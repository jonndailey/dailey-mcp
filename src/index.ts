#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerAuthTools } from './tools/auth.js';
import { registerProjectTools } from './tools/projects.js';
import { registerDeployTools } from './tools/deploy.js';
import { registerScaleTools } from './tools/scale.js';
import { registerEnvTools } from './tools/env.js';
import { registerDomainTools } from './tools/domains.js';
import { registerDbTools } from './tools/db.js';
import { registerUsageTools } from './tools/usage.js';
import { registerBillingTools } from './tools/billing.js';
import { registerPlatformTools } from './tools/platform.js';
import { registerStorageTools } from './tools/storage.js';
import { registerImageTools } from './tools/images.js';

const server = new McpServer({
  name: 'dailey-os',
  version: '1.0.0',
});

// Register all tools
registerAuthTools(server);
registerProjectTools(server);
registerDeployTools(server);
registerScaleTools(server);
registerEnvTools(server);
registerDomainTools(server);
registerDbTools(server);
registerUsageTools(server);
registerBillingTools(server);
registerPlatformTools(server);
registerStorageTools(server);
registerImageTools(server);

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
