/**
 * Dailey Images (AI generation) MCP tools — two-layer test.
 *
 * Layer 1 (protocol smoke): spawns dist/index.js, does the MCP handshake,
 * calls tools/list, and asserts dailey_images_generate / dailey_images_enable /
 * dailey_images_info appear with correct input schemas. No credentials needed.
 *
 * Layer 2 (in-process registration checks): imports the compiled module,
 * stubs McpServer.tool(), and verifies names, schemas, and descriptions.
 *
 * Run:
 *   node --test tests/dailey-images.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BINARY = join(__dirname, '..', 'dist', 'index.js');

// ── Layer 1: protocol smoke (tools/list) ───────────────────────────────────

describe('dailey images MCP tools — protocol smoke', { concurrency: false }, () => {
  test('generate/enable/info appear in tools/list with input schemas', async () => {
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
      await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dailey-images-smoke', version: '1.0.0' },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      const toolsMsg = await send('tools/list', {});
      const tools = toolsMsg.result?.tools ?? [];
      const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));

      for (const name of ['dailey_images_generate', 'dailey_images_enable', 'dailey_images_info']) {
        assert.ok(toolMap[name], `Expected tool "${name}" in tools/list`);
        assert.ok(toolMap[name].inputSchema?.properties, `${name} must have inputSchema.properties`);
        assert.ok('project' in toolMap[name].inputSchema.properties, `${name} must have project param`);
      }

      // generate: prompt required; model enum; n optional
      const gen = toolMap['dailey_images_generate'];
      assert.ok('prompt' in gen.inputSchema.properties, 'generate must have prompt param');
      assert.ok('model' in gen.inputSchema.properties, 'generate must have model param');
      assert.ok('n' in gen.inputSchema.properties, 'generate must have n param');
      const genRequired = gen.inputSchema.required ?? [];
      assert.ok(genRequired.includes('project'), 'project must be required');
      assert.ok(genRequired.includes('prompt'), 'prompt must be required');
      assert.ok(!genRequired.includes('model'), 'model must be optional');
      assert.ok(!genRequired.includes('n'), 'n must be optional');
      // model is an enum with the two tiers
      const modelEnum = gen.inputSchema.properties.model.enum;
      assert.deepEqual(modelEnum, ['dailey-fast', 'dailey-pro'], 'model enum must be the two tiers');
    } finally {
      child.kill();
    }
  });
});

// ── Layer 2: in-process registration checks ────────────────────────────────

describe('dailey images tools — registration', { concurrency: false }, () => {
  test('registers all three tools with the right shapes', async () => {
    const registrations = [];
    const stubServer = {
      tool(name, description, schema, handler) {
        registrations.push({ name, description, schema, handler });
      },
    };

    const mod = await import(join(__dirname, '..', 'dist', 'tools', 'dailey-images.js'));
    mod.registerDaileyImagesTools(stubServer);

    const byName = Object.fromEntries(registrations.map((r) => [r.name, r]));

    const gen = byName['dailey_images_generate'];
    assert.ok(gen, 'dailey_images_generate must be registered');
    assert.ok(typeof gen.handler === 'function', 'generate handler must be a function');
    assert.ok(gen.schema?.project && gen.schema?.prompt, 'generate must have project + prompt');
    // metered cost is called out in the description
    assert.match(gen.description, /2¢/, 'generate description must mention 2¢ (fast)');
    assert.match(gen.description, /10¢/, 'generate description must mention 10¢ (pro)');
    assert.match(gen.description, /prepaid credits/i, 'generate description must mention prepaid credits');
    // prompt required, model optional
    const promptOptional = gen.schema.prompt?._def?.typeName === 'ZodOptional'
      || (typeof gen.schema.prompt?.isOptional === 'function' && gen.schema.prompt.isOptional());
    assert.ok(!promptOptional, 'prompt must NOT be optional');
    const modelOptional = gen.schema.model?._def?.typeName === 'ZodOptional'
      || (typeof gen.schema.model?.isOptional === 'function' && gen.schema.model.isOptional());
    assert.ok(modelOptional, 'model must be optional');

    const enable = byName['dailey_images_enable'];
    assert.ok(enable, 'dailey_images_enable must be registered');
    assert.ok(enable.schema?.project, 'enable must have project param');

    const info = byName['dailey_images_info'];
    assert.ok(info, 'dailey_images_info must be registered');
    assert.ok(info.schema?.project, 'info must have project param');
  });
});
