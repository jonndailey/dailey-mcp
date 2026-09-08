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

// The one URL a customer should ever be sent to for MCP setup. Verified to
// return a real rendered page ("AI Ops (MCP)"). The previous value here,
// /mcp/getting-started, was a hard 404 — every credential failure pointed the
// customer at a dead link, which is where the "just message Jonny" reflex came
// from (2026-08-21 MCP onboarding audit).
const DOCS_URL = 'https://docs.dailey.cloud/docs/mcp/';

async function preflight(): Promise<void> {
  const isInteractive = Boolean(process.stdin.isTTY);

  if (!hasCredentials()) {
    // Say the ONE command that fixes this, first. `dailey mcp setup` detects
    // the assistants that are installed, writes each config, and proves the
    // connection works before it claims success.
    const msg =
      'No Dailey account is configured. Run `dailey login` then `dailey mcp setup` '
      + 'in a terminal, or set DAILEY_API_TOKEN in this client config.';

    if (isInteractive) {
      await writeStream(
        process.stderr,
        '\n' +
          'dailey-mcp: ' + msg + '\n\n' +
          'This is an MCP stdio server — it is meant to be spawned by an MCP client\n' +
          '(Claude Code, Codex, Cursor, etc.) which will send JSON-RPC messages on stdin.\n' +
          'Running it directly in a shell is not how you use it.\n\n' +
          'You almost never need to edit a config by hand. Instead run:\n' +
          '  npm install -g @daileyos/cli\n' +
          '  dailey login\n' +
          '  dailey mcp setup\n\n' +
          'That detects Claude Code / Claude Desktop / Codex / Cursor / OpenCode /\n' +
          'Windsurf, writes the right config for each, and tests the connection.\n\n' +
          'Docs: ' + DOCS_URL + '\n\n'
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
          data: msg + ' See ' + DOCS_URL,
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
        'client (Claude Code, Codex, Cursor, etc.), not typed into directly. If you\n' +
        'were trying to update it, you do not need to — `npx @daileyos/mcp-server`\n' +
        'in your client config pulls latest at each session start.\n' +
        'To check your setup instead, run: dailey mcp doctor\n' +
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
