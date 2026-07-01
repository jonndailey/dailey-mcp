/**
 * environments + dailey_wp_clone MCP tools — two-layer test.
 *
 * Layer 1 (protocol smoke): spawns dist/index.js, does the MCP handshake,
 * calls tools/list, and asserts dailey_environments and dailey_wp_clone appear
 * with correct input schemas. No real credentials needed.
 *
 * Layer 2 (in-process schema/logic checks): imports the compiled module,
 * stubs McpServer.tool(), and verifies descriptions, schemas, and confirm-gate
 * logic via source inspection.
 *
 * Run:
 *   node --test tests/environments.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BINARY = join(__dirname, '..', 'dist', 'index.js');

// ── Layer 1: protocol smoke (tools/list) ───────────────────────────────────

describe('environments MCP tools — protocol smoke', { concurrency: false }, () => {
  test('dailey_environments and dailey_wp_clone appear in tools/list with input schemas', async () => {
    const child = spawn('node', [BINARY], {
      env: {
        ...process.env,
        DAILEY_EMAIL: process.env.DAILEY_EMAIL || 'smoke@example.com',
        DAILEY_PASSWORD: process.env.DAILEY_PASSWORD || 'smoke-password',
        DAILEY_API_TOKEN: process.env.DAILEY_API_TOKEN || '',
        DAILEY_API_URL: process.env.DAILEY_API_URL || 'https://os.dailey.cloud/api',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = '';
    let nextId = 1;
    const pending = new Map();

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && pending.has(msg.id)) {
            const { resolve } = pending.get(msg.id);
            pending.delete(msg.id);
            resolve(msg);
          }
        } catch { /* ignore non-JSON lines */ }
      }
    });

    child.stderr.on('data', (_chunk) => { /* suppress */ });

    function send(method, params, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`Timeout waiting for ${method}`));
          }
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject,
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    }

    try {
      // MCP handshake
      await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'environments-smoke', version: '1.0.0' },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      // List tools
      const toolsMsg = await send('tools/list', {});
      const tools = toolsMsg.result?.tools ?? [];
      const names = new Set(tools.map((t) => t.name));

      const expected = ['dailey_environments', 'dailey_wp_clone'];

      for (const name of expected) {
        assert.ok(names.has(name), `Expected tool "${name}" in tools/list`);
      }

      const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));

      // dailey_environments: must have 'project' param
      const envTool = toolMap['dailey_environments'];
      assert.ok(envTool.inputSchema?.properties, 'dailey_environments must have inputSchema.properties');
      assert.ok('project' in envTool.inputSchema.properties, 'dailey_environments must have project param');

      // dailey_wp_clone: must have 'project' (required) + optional 'confirm_token'
      const cloneTool = toolMap['dailey_wp_clone'];
      assert.ok(cloneTool.inputSchema?.properties, 'dailey_wp_clone must have inputSchema.properties');
      assert.ok('project' in cloneTool.inputSchema.properties, 'dailey_wp_clone must have project param');
      assert.ok('confirm_token' in cloneTool.inputSchema.properties, 'dailey_wp_clone must have confirm_token param');

      // confirm_token must be optional (not in required[])
      const required = cloneTool.inputSchema.required ?? [];
      assert.ok(!required.includes('confirm_token'), 'confirm_token must not be in required[]');
      assert.ok(required.includes('project'), 'project must be in required[]');

    } finally {
      child.kill();
    }
  });
});

// ── Layer 2: in-process registration checks ────────────────────────────────

describe('dailey_environments — registration', { concurrency: false }, () => {
  test('registers with correct name and has project param', async () => {
    const registrations = [];
    const stubServer = {
      tool(name, description, schema, handler) {
        registrations.push({ name, description, schema, handler });
      },
    };

    const mod = await import(join(__dirname, '..', 'dist', 'tools', 'environments.js'));
    mod.registerEnvironmentTools(stubServer);

    const env = registrations.find((r) => r.name === 'dailey_environments');
    assert.ok(env, 'dailey_environments must be registered');
    assert.ok(env.schema?.project, 'dailey_environments must have project in schema');
    assert.ok(typeof env.handler === 'function', 'dailey_environments handler must be a function');
  });
});

describe('dailey_wp_clone — confirm-gate logic', { concurrency: false }, () => {
  test('confirm_token is optional in schema', async () => {
    const registrations = [];
    const stubServer = {
      tool(name, description, schema, handler) {
        registrations.push({ name, description, schema, handler });
      },
    };

    const mod = await import(join(__dirname, '..', 'dist', 'tools', 'environments.js'));
    mod.registerEnvironmentTools(stubServer);

    const clone = registrations.find((r) => r.name === 'dailey_wp_clone');
    assert.ok(clone, 'dailey_wp_clone must be registered');

    // Description mentions DESTRUCTIVE and two-phase
    assert.match(clone.description, /DESTRUCTIVE/i, 'Description must mention DESTRUCTIVE');
    assert.match(clone.description, /two-phase|two phase/i, 'Description must mention two-phase');
    assert.match(clone.description, /confirm_token/, 'Description must mention confirm_token');

    // confirm_token must be ZodOptional
    const confirmField = clone.schema?.confirm_token;
    assert.ok(confirmField, 'confirm_token must be in schema');
    const isOptional =
      confirmField?._def?.typeName === 'ZodOptional' ||
      (typeof confirmField?.isOptional === 'function' && confirmField.isOptional());
    assert.ok(isOptional, 'confirm_token must be ZodOptional (.optional())');

    // project is required (ZodString, not ZodOptional)
    const projectField = clone.schema?.project;
    assert.ok(projectField, 'project must be in schema');
    const projectIsOptional =
      projectField?._def?.typeName === 'ZodOptional' ||
      (typeof projectField?.isOptional === 'function' && projectField.isOptional());
    assert.ok(!projectIsOptional, 'project must NOT be optional');
  });

  test('compiled source: preview route before execute route, confirm_token guard present', async () => {
    const src = readFileSync(join(__dirname, '..', 'dist', 'tools', 'environments.js'), 'utf8');

    // confirm_token guard exists
    assert.ok(
      src.includes('if (!confirm_token)'),
      'Compiled output must contain `if (!confirm_token)` branch guard',
    );

    // preview route referenced
    assert.ok(
      src.includes('/wp/clone/preview'),
      'Compiled output must reference /wp/clone/preview',
    );

    // execute route referenced
    assert.ok(
      src.includes('/wp/clone'),
      'Compiled output must reference /wp/clone execute route',
    );

    // preview appears before execute in file (branch ordering)
    const previewIdx = src.indexOf('/wp/clone/preview');
    // execute route: find the non-preview occurrence
    let searchFrom = 0;
    let executeIdx = -1;
    while (true) {
      const idx = src.indexOf('/wp/clone', searchFrom);
      if (idx === -1) break;
      if (!src.slice(idx).startsWith('/wp/clone/preview')) {
        executeIdx = idx;
        break;
      }
      searchFrom = idx + 1;
    }
    assert.ok(executeIdx !== -1, 'Must find /wp/clone execute route in compiled output');
    assert.ok(
      previewIdx < executeIdx,
      `Preview route (idx ${previewIdx}) must appear before execute route (idx ${executeIdx})`,
    );

    // confirmation: 'CLONE' is in the execute path
    assert.ok(
      src.includes("confirmation: 'CLONE'") || src.includes('confirmation:"CLONE"'),
      "Execute path must pass confirmation: 'CLONE'",
    );
  });
});
