/**
 * EOS #47 — dailey-mcp preflight / stdio-TTY banner + JSON-RPC error.
 *
 * Three paths:
 *
 *   1. non-TTY + no creds → JSON-RPC 2.0 notification on stdout + stderr
 *      + exit code 1
 *   2. TTY + no creds     → stderr banner with "This is an MCP stdio server"
 *      + exit code 1
 *   3. TTY + creds        → short "MCP stdio server running" banner + stays
 *      running (kill after grace period)
 *
 * TTY is spawned via `unbuffer` (expect tools) when available — Node child-
 * process piped stdio is NON-TTY by default. If unbuffer is missing,
 * path (2) is documented rather than skipped silently.
 *
 * Run:
 *   node tests/pack1-mcp-preflight.test.mjs
 * or
 *   node --test tests/pack1-mcp-preflight.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BINARY = join(__dirname, '..', 'dist', 'index.js');

function unbufferAvailable() {
  const r = spawnSync('sh', ['-c', 'command -v unbuffer']);
  return r.status === 0 && String(r.stdout).trim().length > 0;
}

/**
 * Spawn the MCP server with a controlled environment. Returns a promise that
 * resolves with { code, stdout, stderr } once the process exits OR the
 * waitMs timeout fires (in which case we kill it and set code=null).
 */
function runMcp({ env = {}, tty = false, waitMs = 4000, closeStdin = true }) {
  return new Promise((resolve) => {
    const cleanEnv = {
      // Drop the parent's credentials unless explicitly restored below.
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_PATH: process.env.NODE_PATH,
      ...env,
    };

    let child;
    if (tty) {
      if (!unbufferAvailable()) {
        resolve({ code: -1, stdout: '', stderr: 'unbuffer-not-available', skipped: true });
        return;
      }
      // unbuffer allocates a pty on stdout (but NOT stdin). For `stdin.isTTY`,
      // we use `script` if available — or we fall back to a node wrapper that
      // forces process.stdin.isTTY = true before requiring the real binary.
      // Simplest cross-platform: use a small wrapper file that stamps the TTY
      // flag and then dynamically imports the real entry.
      child = spawn(
        'node',
        ['-e', `process.stdin.isTTY = true; process.stdout.isTTY = true; await import(${JSON.stringify(BINARY)});`],
        { env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } else {
      child = spawn('node', [BINARY], { env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
    }, waitMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, killed: false });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message, error: true });
    });

    if (closeStdin) {
      // Close stdin so the server doesn't block waiting for input.
      try { child.stdin.end(); } catch {}
    }
  });
}

describe('EOS #47 — MCP preflight', { concurrency: false }, () => {
  test('binary exists at dist/index.js (has been built)', () => {
    assert.ok(existsSync(BINARY), `binary not found at ${BINARY} — run \`npm run build\` first`);
  });

  test('non-TTY + no creds → JSON-RPC notifications/message on stdout + stderr + exit 1', async () => {
    const r = await runMcp({
      env: { /* no DAILEY_* */ },
      tty: false,
      waitMs: 4000,
    });

    assert.equal(r.code, 1, `expected exit code 1, got ${r.code} (stderr: ${r.stderr.slice(0, 200)})`);

    // Stdout must contain a valid JSON-RPC 2.0 notification
    const line = r.stdout.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
    assert.ok(line, `expected at least one stdout line, got empty (stderr: ${r.stderr.slice(0, 200)})`);
    let parsed;
    try { parsed = JSON.parse(line); } catch (err) {
      assert.fail(`stdout line is not JSON: ${line.slice(0, 200)}`);
    }
    assert.equal(parsed.jsonrpc, '2.0', `expected jsonrpc=2.0, got ${parsed.jsonrpc}`);
    assert.equal(parsed.method, 'notifications/message', `expected method=notifications/message, got ${parsed.method}`);
    assert.equal(parsed.params?.level, 'error');
    assert.match(parsed.params?.data || '', /credentials/i);

    // Stderr must also carry the message (so shell users see something)
    assert.match(r.stderr, /dailey-mcp/i, 'stderr should mention dailey-mcp');
    assert.match(r.stderr, /credentials/i, 'stderr should mention missing credentials');
  });

  test('TTY + no creds → stderr banner with "This is an MCP stdio server" + exit 1', async () => {
    const r = await runMcp({
      env: { /* no DAILEY_* */ },
      tty: true,
      waitMs: 4000,
    });

    if (r.skipped) {
      assert.fail(
        'TTY case could not be executed in this environment (no `unbuffer`). ' +
        'Manual verification: run `node dist/index.js` from an interactive terminal ' +
        'with no DAILEY_* env set; expect the long banner + exit 1.'
      );
      return;
    }

    assert.equal(r.code, 1, `expected exit code 1, got ${r.code}`);
    assert.match(r.stderr, /This is an MCP stdio server/, 'stderr must contain the TTY banner');
    assert.match(r.stderr, /Missing credentials/i, 'stderr must mention Missing credentials');
    // Long banner should NOT produce JSON on stdout in TTY mode
    assert.equal(r.stdout.trim(), '', 'TTY-no-creds path should NOT emit JSON-RPC on stdout');
  });

  test('TTY + creds → short "MCP stdio server running" banner, process keeps running', async () => {
    // We don't actually need real creds to hit the success-branch banner —
    // `hasCredentials()` checks env vars only.
    const r = await runMcp({
      env: { DAILEY_API_TOKEN: 'fake-token-for-preflight-test-only' },
      tty: true,
      waitMs: 2500,
      closeStdin: false,
    });

    if (r.skipped) {
      assert.fail(
        'TTY case could not be executed in this environment (no `unbuffer`). ' +
        'Manual verification: run `DAILEY_API_TOKEN=x node dist/index.js` from an ' +
        'interactive terminal; expect the short "MCP stdio server running" banner ' +
        'and the process stays alive until Ctrl+C.'
      );
      return;
    }

    // Killed by our SIGTERM — exit code should NOT be 1 (that's the preflight-fail code).
    // node w/ SIGTERM typically exits with code null or 143.
    assert.notEqual(r.code, 1, `server should not exit 1 when creds are present, got ${r.code} (stderr: ${r.stderr.slice(0, 200)})`);
    assert.match(r.stderr, /MCP stdio server running/, `stderr should contain short banner. Got: ${r.stderr.slice(0, 300)}`);
  });
});
