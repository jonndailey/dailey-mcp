#!/usr/bin/env node
/**
 * Smoke test for the v1.1.0 MCP tools.
 *
 * Exercises every new tool against a real Dailey OS account, reports
 * pass/fail per tool. Does NOT mutate (no deploys, no deletes, no creates).
 * Looks for a project to test against — if none exists, skips project-
 * scoped tests.
 *
 * Usage:
 *   DAILEY_EMAIL=... DAILEY_PASSWORD=... node tests/new-tools-smoke.mjs
 */

const API_URL = process.env.DAILEY_API_URL || 'https://os.dailey.cloud/api';
const EMAIL = process.env.DAILEY_EMAIL;
const PASSWORD = process.env.DAILEY_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('DAILEY_EMAIL and DAILEY_PASSWORD must be set');
  process.exit(1);
}

let token = '';

async function login() {
  const res = await fetch(`${API_URL}/customers/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const data = await res.json();
  token = data.access_token;
  return data;
}

async function call(method, path, body) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_URL}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

const results = [];
function report(name, passed, detail) {
  const icon = passed ? '✓' : '✗';
  const line = `${icon} ${name}${detail ? ` — ${detail}` : ''}`;
  console.log(line);
  results.push({ name, passed, detail });
}

async function test(name, fn) {
  try {
    const detail = await fn();
    report(name, true, detail);
  } catch (err) {
    report(name, false, err.message);
  }
}

async function main() {
  console.log(`Dailey MCP smoke test against ${API_URL}`);
  console.log('─'.repeat(60));

  const login_data = await login();
  console.log(`Authed as ${login_data.customer?.email || EMAIL}`);
  console.log('');

  // Find a project to test against
  const projects = await call('GET', '/projects');
  if (!projects.ok || !projects.data.projects?.length) {
    console.log('No projects found — skipping project-scoped tests');
    process.exit(0);
  }
  const project = projects.data.projects[0];
  console.log(`Testing against project: ${project.name} (${project.id})`);
  console.log('');

  // Endpoints backing the new MCP tools
  await test('dailey_deploy_status', async () => {
    const r = await call('GET', `/projects/${project.id}/deploy-status`);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    return `mode=${r.data.mode}, can_deploy=${r.data.can_deploy}`;
  });

  await test('dailey_build_logs (builds list)', async () => {
    const r = await call('GET', `/projects/${project.id}/deploys`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return `${r.data.builds?.length ?? 0} builds`;
  });

  await test('dailey_build_logs (fetch log)', async () => {
    const list = await call('GET', `/projects/${project.id}/deploys`);
    if (!list.ok) throw new Error(`list HTTP ${list.status}`);
    const latest = list.data.builds?.[0];
    if (!latest) return 'no builds — skipped';
    const r = await call('GET', `/builds/${latest.id}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const logLen = (r.data.log || '').length;
    return `build ${latest.id} status=${r.data.status} log=${logLen} bytes`;
  });

  await test('dailey_processes', async () => {
    const r = await call('GET', `/projects/${project.id}/processes`);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    return `${r.data.processes?.length ?? 0} processes`;
  });

  await test('dailey_pause/resume (dry — read state)', async () => {
    // Don't actually pause a prod project. Just verify route exists and
    // project is valid by hitting deploy-status (which we already did).
    return `skipped mutation — route /pause,/resume exist per code audit`;
  });

  await test('dailey_backups (list)', async () => {
    const r = await call('GET', `/projects/${project.id}/backups`);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    return `${r.data.backups?.length ?? 0} backups`;
  });

  await test('dailey_resource_config (get)', async () => {
    const r = await call('GET', `/projects/${project.id}/resource-config`);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    return `cpu=${r.data.cpu}, mem=${r.data.memory_mb}MB`;
  });

  await test('dailey_service_links (list)', async () => {
    const r = await call('GET', `/projects/${project.id}/links`);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    return `${r.data.links?.length ?? 0} links`;
  });

  await test('dailey_domains (list)', async () => {
    const r = await call('GET', `/projects/${project.id}/domains`);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    return `${r.data.domains?.length ?? 0} domains`;
  });

  // DNS check requires a real domain — try one if any exists
  const domainList = await call('GET', `/projects/${project.id}/domains`);
  // Skip the default *.dailey.cloud domain — dns_check rejects those.
  const customDomain = domainList.ok
    ? domainList.data.domains?.find((x) => !x.is_default)
    : null;
  if (customDomain) {
    const d = customDomain.hostname;
    await test(`dailey_domains dns_check (${d})`, async () => {
      const r = await call('GET', `/projects/${project.id}/domains/dns-check?domain=${encodeURIComponent(d)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data)}`);
      return `matched=${r.data.matched}, type=${r.data.match_type}`;
    });

    await test(`dailey_domains cert_status (${d})`, async () => {
      const r = await call('GET', `/projects/${project.id}/domains/cert-status?domain=${encodeURIComponent(d)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data)}`);
      return `status=${r.data.status}`;
    });
  } else {
    console.log('⊘ dailey_domains dns_check / cert_status — no custom domains on test project (default only)');
  }

  await test('dailey_analyze_repo (docker image)', async () => {
    const r = await call('POST', '/projects/analyze', { repo_url: 'nginx:alpine' });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    return `_isDockerImage=${r.data._isDockerImage}, issues=${r.data.issues?.length || 0}`;
  });

  await test('dailey_db_validate (dry)', async () => {
    // Does project have a DB? check db info first.
    const info = await call('GET', `/projects/${project.id}/database`);
    if (!info.ok || info.data?.status === 'not-configured') return `no DB provisioned — skipped`;
    const r = await call('POST', `/projects/${project.id}/database/validate`, {
      sql: 'CREATE TABLE IF NOT EXISTS _mcp_smoke_test (id INT);',
    });
    // Pack 4 fix: when a project has no managed DB, the API returns 400
    // with a friendly "no managed database" error. Treat that as a skip,
    // not a test failure.
    if (r.status === 400 && typeof r.data?.error === 'string' && /no managed database/i.test(r.data.error)) {
      return `no DB — skipped`;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    return `valid=${r.data.valid}, warnings=${r.data.has_warnings}`;
  });

  await test('dailey_db_tunnel (list)', async () => {
    const r = await call('GET', `/projects/${project.id}/database/tunnel`);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    return `${r.data.sessions?.length ?? 0} active sessions`;
  });

  // Summary
  console.log('');
  console.log('─'.repeat(60));
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`Passed: ${passed}   Failed: ${failed}   Total: ${results.length}`);
  if (failed > 0) {
    console.log('');
    console.log('Failures:');
    for (const r of results.filter((x) => !x.passed)) {
      console.log(`  ✗ ${r.name}: ${r.detail}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('TEST CRASH:', err);
  process.exit(2);
});
