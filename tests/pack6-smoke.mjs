#!/usr/bin/env node
/**
 * Pack 6 smoke test — dailey_diagnose tool + remediation hints.
 *
 * Two layers:
 *   1. Pure-unit: verify remediationFor() returns the right hint for known
 *      status codes and error patterns. No network needed.
 *   2. End-to-end: spawn the MCP stdio server, list tools, call
 *      dailey_diagnose against a real project, parse the JSON output.
 *
 * Usage:
 *   DAILEY_EMAIL=... DAILEY_PASSWORD=... node tests/pack6-smoke.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const here = path.resolve(new URL('.', import.meta.url).pathname);
const binary = path.resolve(here, '..', 'dist/index.js');

// ── Layer 1: remediationFor unit checks ─────────────────────────────
const { remediationFor } = await import(path.resolve(here, '..', 'dist/api.js'));

let unitPassed = 0;
let unitFailed = 0;
function unit(name, predicate) {
  if (predicate) {
    console.log(`  ✓ ${name}`);
    unitPassed++;
  } else {
    console.log(`  ✗ ${name}`);
    unitFailed++;
  }
}

console.log('Unit: remediationFor()');
unit('423 → account-locked hint', /account locked/i.test(remediationFor(423, {}) || ''));
unit('429 → rate-limited hint', /rate limited|retry-after/i.test(remediationFor(429, {}) || ''));
unit('401 → token hint', /token expired|dailey login/i.test(remediationFor(401, {}) || ''));
unit('403 → token hint', /token expired|dailey login/i.test(remediationFor(403, {}) || ''));
unit('502 → unreachable hint', /unreachable/i.test(remediationFor(502, {}) || ''));
unit(
  'AlreadyExists registry → retry hint',
  /retry .dailey_deploy./i.test(
    remediationFor(500, { error: 'AlreadyExists: blob upload to registry failed' }) || '',
  ),
);
unit(
  'SignatureDoesNotMatch → storage refresh',
  /storage.*refresh|24h/i.test(
    remediationFor(403, { error: 'SignatureDoesNotMatch on PUT' }) || '',
  ),
);
unit(
  'CrashLoopBackOff → app_logs',
  /app_logs/i.test(remediationFor(500, { error: 'pod CrashLoopBackOff' }) || ''),
);
unit(
  'ENOTFOUND → unreachable',
  /unreachable/i.test(remediationFor(0, 'fetch failed: ENOTFOUND os.dailey.cloud') || ''),
);
unit('200 → no hint', remediationFor(200, {}) === null);
unit('404 unrecognized → no hint', remediationFor(404, { error: 'Project not found' }) === null);

console.log('');

// ── Layer 2: end-to-end MCP smoke ───────────────────────────────────
const env = {
  ...process.env,
  DAILEY_API_URL: process.env.DAILEY_API_URL || 'https://os.dailey.cloud/api',
  DAILEY_EMAIL: process.env.DAILEY_EMAIL,
  DAILEY_PASSWORD: process.env.DAILEY_PASSWORD,
};

if (!env.DAILEY_EMAIL || !env.DAILEY_PASSWORD) {
  console.log('(skip e2e — DAILEY_EMAIL/DAILEY_PASSWORD not set)');
  process.exit(unitFailed === 0 ? 0 : 1);
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
    } catch {}
  }
});

child.stderr.on('data', (chunk) => {
  // Quiet — but surface unexpected stack traces
  const s = chunk.toString();
  if (/error|throw|TypeError/i.test(s)) process.stderr.write(`[mcp] ${s}`);
});

function send(method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }
    }, timeoutMs);
  });
}

let e2ePassed = 0;
let e2eFailed = 0;
function e2e(name, predicate, detail) {
  if (predicate) {
    console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
    e2ePassed++;
  } else {
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    e2eFailed++;
  }
}

try {
  console.log('E2E: MCP stdio server');
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'pack6-smoke', version: '1.0.0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const toolsMsg = await send('tools/list', {});
  const tools = toolsMsg.result?.tools || [];
  const names = new Set(tools.map((t) => t.name));
  e2e('dailey_diagnose registered', names.has('dailey_diagnose'), `${tools.length} tools total`);

  // Find a project to diagnose
  const listMsg = await send('tools/call', { name: 'dailey_list_projects', arguments: {} });
  const listText = listMsg.result?.content?.[0]?.text || '';
  // Format: lines after divider; first column is the UUID. Pick the first.
  const idMatch = listText.match(/^([0-9a-f]{8}-[0-9a-f-]+)/m);
  if (!idMatch) {
    console.log('  ⊘ no project to diagnose — skipping invocation tests');
  } else {
    const projectId = idMatch[1];
    const slugMatch = listText.match(new RegExp(`^${projectId}\\s+\\S+\\s+(\\S+)`, 'm'));
    const slug = slugMatch?.[1];
    console.log(`  Using project: ${projectId}${slug ? ' (slug: ' + slug + ')' : ''}`);

    // by ID
    const byId = await send(
      'tools/call',
      { name: 'dailey_diagnose', arguments: { project: projectId } },
      60000,
    );
    const byIdText = byId.result?.content?.[0]?.text || '';
    let byIdJson = null;
    try { byIdJson = JSON.parse(byIdText); } catch {}
    e2e('dailey_diagnose by ID returns valid JSON', !!byIdJson);
    e2e(
      'has top-level summary',
      typeof byIdJson?.summary === 'string' && byIdJson.summary.length > 0,
      byIdJson?.summary?.slice(0, 60),
    );
    e2e(
      'verdict is healthy/degraded/broken',
      ['healthy', 'degraded', 'broken'].includes(byIdJson?.verdict),
      byIdJson?.verdict,
    );
    e2e('has 6 lane checks', byIdJson && Object.keys(byIdJson.checks || {}).length === 6);
    e2e('matched_by=id', byIdJson?.matched_by === 'id');

    // by slug (if we found one)
    if (slug) {
      const bySlug = await send(
        'tools/call',
        { name: 'dailey_diagnose', arguments: { project: slug } },
        60000,
      );
      const bySlugText = bySlug.result?.content?.[0]?.text || '';
      let bySlugJson = null;
      try { bySlugJson = JSON.parse(bySlugText); } catch {}
      e2e('dailey_diagnose by slug returns valid JSON', !!bySlugJson);
      e2e('matched_by=slug', bySlugJson?.matched_by === 'slug');
      e2e('resolved to same project_id', bySlugJson?.project_id === projectId);
    }

    // bogus → broken with hint
    const bogus = await send(
      'tools/call',
      { name: 'dailey_diagnose', arguments: { project: 'definitely-not-a-real-slug-xyz123' } },
      30000,
    );
    const bogusText = bogus.result?.content?.[0]?.text || '';
    let bogusJson = null;
    try { bogusJson = JSON.parse(bogusText); } catch {}
    e2e('bogus slug → verdict=broken', bogusJson?.verdict === 'broken');
    e2e('bogus slug → matched_by=none', bogusJson?.matched_by === 'none');
  }

  child.kill();
} catch (err) {
  console.error('E2E CRASH:', err.message);
  child.kill();
  e2eFailed++;
}

console.log('');
console.log('─'.repeat(60));
console.log(`Unit:  ${unitPassed} passed, ${unitFailed} failed`);
console.log(`E2E:   ${e2ePassed} passed, ${e2eFailed} failed`);
process.exit(unitFailed + e2eFailed === 0 ? 0 : 1);
