#!/usr/bin/env node
/**
 * End-to-end MCP-protocol smoke test.
 *
 * Spawns the compiled MCP server, speaks the JSON-RPC stdio protocol, lists
 * all tools, and calls a representative read-only tool. This exercises the
 * actual MCP surface LLMs see.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const binary = path.resolve(new URL('.', import.meta.url).pathname, '..', 'dist/index.js');

const env = {
  ...process.env,
  DAILEY_API_URL: process.env.DAILEY_API_URL || 'https://os.dailey.cloud/api',
  DAILEY_EMAIL: process.env.DAILEY_EMAIL,
  DAILEY_PASSWORD: process.env.DAILEY_PASSWORD,
};

if (!env.DAILEY_EMAIL || !env.DAILEY_PASSWORD) {
  console.error('DAILEY_EMAIL and DAILEY_PASSWORD must be set');
  process.exit(1);
}

const child = spawn('node', [binary], { env, stdio: ['pipe', 'pipe', 'pipe'] });

let nextId = 1;
const pending = new Map();
let buffer = '';

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch { /* ignore */ }
  }
});

child.stderr.on('data', (chunk) => {
  process.stderr.write(`[mcp-server] ${chunk}`);
});

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }
    }, 15000);
  });
}

async function main() {
  console.log('Spawning MCP server...');

  // MCP handshake
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0.0' },
  });
  console.log(`✓ initialized (server: ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version})`);

  // Notify initialized (required by some clients)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // List tools
  const toolsMsg = await send('tools/list', {});
  const tools = toolsMsg.result?.tools || [];
  console.log(`✓ tools/list returned ${tools.length} tools`);

  const expected = [
    'dailey_whoami',
    'dailey_list_projects',
    'dailey_project_info',
    'dailey_deploy_status',
    'dailey_build_logs',
    'dailey_processes',
    'dailey_process_logs',
    'dailey_process_restart',
    'dailey_process_metrics',
    'dailey_process_resources',
    'dailey_pause',
    'dailey_resume',
    'dailey_backups',
    'dailey_resource_config',
    'dailey_service_links',
    'dailey_reveal_credential',
    'dailey_analyze_repo',
    'dailey_db_validate',
    'dailey_db_tunnel',
    'dailey_scale',
    'dailey_domains',
  ];

  const names = new Set(tools.map((t) => t.name));
  const missing = expected.filter((n) => !names.has(n));
  if (missing.length) {
    console.log(`✗ missing tools: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`✓ all expected new tools registered`);

  // Call a real tool — dailey_whoami — to verify end-to-end flow.
  const whoamiMsg = await send('tools/call', { name: 'dailey_whoami', arguments: {} });
  const text = whoamiMsg.result?.content?.[0]?.text || '';
  if (!text.includes('@') && !text.toLowerCase().includes('email')) {
    console.log(`✗ dailey_whoami returned unexpected output: ${text.slice(0, 100)}`);
    process.exit(1);
  }
  console.log(`✓ dailey_whoami call succeeded (${text.split('\n')[0]})`);

  // Call a new tool — dailey_analyze_repo on nginx:alpine.
  const analyzeMsg = await send('tools/call', {
    name: 'dailey_analyze_repo',
    arguments: { repo_url: 'nginx:alpine' },
  });
  const analyzeText = analyzeMsg.result?.content?.[0]?.text || '';
  if (!analyzeText.includes('Analysis') || !analyzeText.includes('nginx:alpine')) {
    console.log(`✗ dailey_analyze_repo returned unexpected output: ${analyzeText.slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`✓ dailey_analyze_repo call succeeded`);

  child.kill();
  console.log('');
  console.log(`All checks passed. ${tools.length} tools registered, new tools callable.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('TEST CRASH:', err);
  child.kill();
  process.exit(2);
});
