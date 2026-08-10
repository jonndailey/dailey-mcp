#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { hasCredentials } from './api.js';
import { OWN_VERSION, checkForNewerVersion, outdatedNotice } from './version.js';
import { buildServer } from './server.js';

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

const server = buildServer({
  includeAdmin: true,
  includeLocalAuth: true,
  includeAccountSwitch: true,
  instructions: newerVersion ? outdatedNotice(newerVersion) : undefined,
});

const transport = new StdioServerTransport();
await server.connect(transport);
