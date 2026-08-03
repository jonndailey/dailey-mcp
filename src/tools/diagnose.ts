import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, textResult } from '../api.js';

/**
 * dailey_diagnose — single MCP tool that runs every health check and returns
 * a structured summary. Customer-feedback Scott Waters platform-wishlist
 * 2026-04-25, section 8: "the kind of thing an AI agent reaches for when a
 * customer says 'something's broken.'"
 *
 * Strategy: piggyback on existing endpoints (deploy-status, /resources,
 * /storage, /database, /env/runtime, /logs). No new backend endpoints.
 * Calls run in parallel; each lane is wrapped so one failing lane doesn't
 * abort the rest. Final verdict aggregates lane-level statuses into one
 * of: healthy / degraded / broken.
 */

type LaneStatus = 'ok' | 'warn' | 'fail' | 'skip';

interface Lane {
  name: string;
  status: LaneStatus;
  summary: string;
  detail?: Record<string, unknown>;
}

interface ProjectListEntry {
  id: string;
  name?: string;
  slug?: string;
}

const ERROR_LINE_PATTERN = /(error|fatal|panic|exception|uncaught|unhandled)/i;

interface KnownIssue {
  id: string;
  name: string;
  plain_english: string;
  fix: string;
  severity: 'fail' | 'warn';
}

interface PatternRule {
  pattern: RegExp;
  issue: KnownIssue;
}

const KNOWN_PATTERNS: PatternRule[] = [
  {
    pattern: /P3009|migrate found failed migrations|applied migration.*is not recorded/i,
    issue: {
      id: 'prisma_failed_migration',
      name: 'Prisma: failed migration in history',
      plain_english:
        'Your database has a migration that started but never finished — usually because the app crashed mid-deploy or you restored a dump on top of an existing schema. Prisma refuses to start until it is resolved.',
      fix: 'Run: dailey db exec <project> "UPDATE _prisma_migrations SET finished_at = started_at, logs = NULL WHERE finished_at IS NULL AND rolled_back_at IS NULL;" --confirm\nThen redeploy: dailey deploy <project>',
      severity: 'fail',
    },
  },
  {
    pattern: /PrismaClientInitializationError|prisma\.generate|@prisma\/client did not initialize/i,
    issue: {
      id: 'prisma_client_not_generated',
      name: 'Prisma: client not generated',
      plain_english:
        'The Prisma client was not generated during the build step. Your Dockerfile or build command is missing "prisma generate" before "node" starts.',
      fix: 'Add "npx prisma generate" to your build step. In package.json: "build": "prisma generate && tsc" (or whatever your build command is). Then redeploy: dailey deploy <project>',
      severity: 'fail',
    },
  },
  {
    pattern: /exit code 137|OOMKilled|out of memory kill|memory limit exceeded/i,
    issue: {
      id: 'oom_killed',
      name: 'Pod killed: out of memory (OOM)',
      plain_english:
        'Your app used more memory than its limit and the platform killed it. The default limit is 512 MB per replica.',
      fix: 'Check memory usage: dailey usage <project>\nIncrease the limit: dailey resource-config <project> --memory-limit 1024\nOr reduce memory use (Node.js tip: set NODE_OPTIONS="--max-old-space-size=900" in your env vars).',
      severity: 'fail',
    },
  },
  {
    pattern: /FATAL ERROR:.*JavaScript heap out of memory|heap out of memory/i,
    issue: {
      id: 'node_heap_oom',
      name: 'Node.js heap out of memory',
      plain_english:
        "Your Node.js process ran out of heap space. It didn't hit the container memory limit — the V8 heap limit (default ~512 MB) was hit first.",
      fix: 'Set NODE_OPTIONS env var: dailey env set <project> NODE_OPTIONS "--max-old-space-size=1024"\nThen redeploy: dailey deploy <project>',
      severity: 'fail',
    },
  },
  {
    pattern: /ECONNREFUSED.*(?:3306|5432|27017)|connect ECONNREFUSED.*database|database connection refused/i,
    issue: {
      id: 'db_connection_refused',
      name: 'Database connection refused',
      plain_english:
        'Your app tried to connect to the database but got "connection refused." Either the database is not provisioned, or the connection URL is wrong.',
      fix: 'Check if a database is provisioned: dailey db info <project>\nIf not provisioned: dailey db provision <project> --type mysql (or postgres)\nIf provisioned, verify DATABASE_URL is correct: dailey env list <project>',
      severity: 'fail',
    },
  },
  {
    pattern: /EADDRINUSE|address already in use|port.*already in use/i,
    issue: {
      id: 'port_in_use',
      name: 'Port already in use',
      plain_english:
        "Your app tried to listen on a port that's already occupied. On Dailey OS you must listen on the PORT env var (always 3000) — never hardcode a port number.",
      fix: 'Update your app to bind to process.env.PORT (not a hardcoded number). Example: app.listen(process.env.PORT || 3000)\nThen redeploy: dailey deploy <project>',
      severity: 'fail',
    },
  },
  {
    pattern: /Cannot find module|MODULE_NOT_FOUND|Error: Cannot find|module not found/i,
    issue: {
      id: 'module_not_found',
      name: 'Module not found',
      plain_english:
        'A package your app depends on is missing from the build. This usually means a dependency was not installed during the build, or was accidentally added to devDependencies instead of dependencies.',
      fix: 'Check your package.json: make sure the missing package is in "dependencies" (not "devDependencies").\nThen redeploy: dailey deploy <project>\nIf the build is failing: dailey build-logs <project>',
      severity: 'fail',
    },
  },
  {
    pattern:
      /TypeError: Cannot read propert(?:y|ies) of undefined|TypeError: Cannot read propert(?:y|ies) of null|ReferenceError: process is not defined/i,
    issue: {
      id: 'missing_env_var',
      name: 'Missing environment variable (likely)',
      plain_english:
        'Your app crashed trying to read a value that was undefined or null. This is often a missing environment variable — your code references process.env.SOMETHING that was never set.',
      fix: 'Check which env vars are set: dailey env list <project>\nSet a missing var: dailey env set <project> MY_VAR "my value"\nThen redeploy: dailey deploy <project>',
      severity: 'warn',
    },
  },
  {
    pattern: /secretOrPrivateKey must have a value|jwt.*secret.*undefined|invalid signature/i,
    issue: {
      id: 'missing_jwt_secret',
      name: 'Missing JWT secret',
      plain_english:
        'Your app uses JWT (JSON Web Tokens) but the secret key env var is not set. Sessions and auth will fail.',
      fix: 'Set your JWT secret: dailey env set <project> JWT_SECRET "$(openssl rand -hex 32)"\nThen redeploy: dailey deploy <project>',
      severity: 'fail',
    },
  },
  {
    pattern: /SSL SYSCALL error|SSL connection has been closed|EPROTO.*SSL|certificate verify failed/i,
    issue: {
      id: 'ssl_db_error',
      name: 'Database SSL error',
      plain_english:
        'Your app failed to establish a secure connection to the database. This usually means the SSL mode in your connection string does not match what the server requires.',
      fix: 'If using PostgreSQL, add ?sslmode=require to DATABASE_URL.\nIf using MySQL, add ?ssl=true.\nCheck current DATABASE_URL: dailey env list <project>',
      severity: 'fail',
    },
  },
  {
    pattern: /SIGTERM|graceful shutdown|terminating connection|Gracefully stopping/i,
    issue: {
      id: 'sigterm_restart',
      name: 'Pod restarting (SIGTERM)',
      plain_english:
        'Your app is being stopped and restarted by the platform. This is normal during deploys, but if it is happening repeatedly it means the app is not starting up properly after being stopped.',
      fix: 'Check pod restart count and crash reasons: dailey processes <project>\nCheck if the latest deploy succeeded: dailey deploy-status <project>',
      severity: 'warn',
    },
  },
];

async function resolveProjectId(
  projectOrSlug: string,
): Promise<{ id: string | null; matched_by: 'id' | 'slug' | 'name' | 'none'; hint?: string }> {
  // Try as ID first — a UUID-shaped string is almost always a real ID.
  const looksLikeId = /^[0-9a-f-]{8,}$/i.test(projectOrSlug);
  if (looksLikeId) {
    const direct = await apiRequest<any>('GET', `/projects/${projectOrSlug}`);
    if (direct.ok) return { id: projectOrSlug, matched_by: 'id' };
    // fall through to slug lookup if 404
  }

  const list = await apiRequest<{ projects: ProjectListEntry[] }>('GET', '/projects');
  if (!list.ok) {
    return { id: null, matched_by: 'none', hint: 'Could not list projects to resolve slug.' };
  }
  const projects = list.data.projects || [];
  const bySlug = projects.find((p) => p.slug === projectOrSlug);
  if (bySlug?.id) return { id: bySlug.id, matched_by: 'slug' };
  const byName = projects.find((p) => p.name === projectOrSlug);
  if (byName?.id) return { id: byName.id, matched_by: 'name' };
  return { id: null, matched_by: 'none', hint: `No project found matching "${projectOrSlug}".` };
}

async function checkDeploy(projectId: string): Promise<Lane> {
  const status = await apiRequest<any>('GET', `/projects/${projectId}/deploy-status`);
  if (!status.ok) {
    return { name: 'deploy', status: 'fail', summary: `deploy-status returned ${status.status}` };
  }
  const builds = await apiRequest<{ builds: any[] }>('GET', `/projects/${projectId}/deploys`);
  const latest = builds.ok ? builds.data.builds?.[0] : null;
  const deployedAt = status.data.deployed_at;
  const isBuilding = !!status.data.is_building;

  let laneStatus: LaneStatus = 'ok';
  let summary = `Deployed ${deployedAt || 'never'}`;

  if (latest?.status === 'failed' && isBuilding) {
    laneStatus = 'fail';
    summary = 'Build failed and is still marked as building — possible data corruption or platform issue.';
  } else if (latest?.status === 'failed') {
    laneStatus = 'fail';
    summary = `Latest build ${latest.id} failed (${latest.finished_at || 'no finish time'}).`;
  } else if (isBuilding) {
    laneStatus = 'warn';
    summary = `Build in progress (${latest?.id || 'unknown'}).`;
  } else if (!deployedAt) {
    laneStatus = 'warn';
    summary = 'Project has never been deployed.';
  }

  return {
    name: 'deploy',
    status: laneStatus,
    summary,
    detail: {
      mode: status.data.mode,
      deployed_at: deployedAt,
      is_building: isBuilding,
      can_deploy: status.data.can_deploy,
      latest_build: latest
        ? { id: latest.id, status: latest.status, finished_at: latest.finished_at }
        : null,
    },
  };
}

async function checkPods(projectId: string): Promise<Lane> {
  // /resources is the single-call source for pod ready/total + restart counts.
  const res = await apiRequest<any>('GET', `/projects/${projectId}/resources`);
  if (!res.ok) {
    return {
      name: 'pods',
      status: 'fail',
      summary: `Could not fetch pod resources (${res.status}).`,
    };
  }
  const pods = res.data.pods || [];
  const ready = pods.filter((p: any) => p.ready === true).length;
  const total = pods.length;
  const restarts = pods.reduce((sum: number, p: any) => sum + (p.restarts || 0), 0);

  // Recent crash reasons — pull anything the API exposes per pod.
  const crashReasons: string[] = [];
  for (const p of pods) {
    if (p.last_termination_reason) crashReasons.push(`${p.name || '?'}: ${p.last_termination_reason}`);
    if (p.status && p.status !== 'Running' && p.status !== 'Pending') {
      crashReasons.push(`${p.name || '?'}: ${p.status}`);
    }
  }

  let laneStatus: LaneStatus = 'ok';
  let summary = `${ready}/${total} pods ready, ${restarts} total restarts`;

  if (total === 0) {
    laneStatus = 'warn';
    summary = 'No pods running. Project may be paused or never deployed.';
  } else if (ready === 0) {
    laneStatus = 'fail';
    summary = `0/${total} pods ready — service is down.`;
  } else if (ready < total) {
    laneStatus = 'warn';
    summary = `${ready}/${total} pods ready (some not ready).`;
  } else if (restarts > 5) {
    laneStatus = 'warn';
    summary = `${ready}/${total} pods ready but ${restarts} restarts — investigate.`;
  }

  return {
    name: 'pods',
    status: laneStatus,
    summary,
    detail: {
      pods_ready: ready,
      pods_total: total,
      total_restarts: restarts,
      crash_reasons: crashReasons.slice(0, 5),
    },
  };
}

async function checkStorage(projectId: string): Promise<Lane> {
  // Piggyback on /storage. A successful response means the binding row
  // exists and the platform-side storage info is reachable. The full
  // "HeadBucket with auto-injected creds" probe needs a backend extension
  // (tracked separately); for now, "binding info reachable" is the proxy.
  const res = await apiRequest<any>('GET', `/projects/${projectId}/storage`);
  if (!res.ok) {
    if (res.status === 404) {
      return { name: 'storage', status: 'skip', summary: 'No storage binding for this project.' };
    }
    return {
      name: 'storage',
      status: 'fail',
      summary: `Could not fetch storage info (${res.status}).`,
    };
  }
  const binding = res.data.binding || {};
  const usage = binding.usage || {};
  return {
    name: 'storage',
    status: 'ok',
    summary: `Bucket ${binding.bucket || '?'} reachable (${usage.total_objects || 0} objects, ${usage.total_size_mb || 0} MB).`,
    detail: {
      bucket: binding.bucket,
      provider: binding.provider,
      objects: usage.total_objects,
      size_mb: usage.total_size_mb,
      // The auto-injected `<slug>-storage-credentials` secret is created and
      // refreshed by storage-credential-refresher (24h cycle). A binding row
      // present + storage info endpoint OK is strong evidence the secret is
      // valid; a HeadBucket probe with the per-pod creds would be stronger
      // and is a planned backend addition.
      note: 'Per-pod cred HeadBucket probe pending backend extension.',
    },
  };
}

async function checkDatabase(projectId: string): Promise<Lane> {
  const info = await apiRequest<any>('GET', `/projects/${projectId}/database`);
  if (!info.ok) {
    return {
      name: 'database',
      status: 'fail',
      summary: `Could not fetch database info (${info.status}).`,
    };
  }
  // A project without a managed DB returns either status='not-configured' or
  // an error mode. Either way → skip lane, not fail.
  if (!info.data.host || info.data.status === 'not-configured') {
    return { name: 'database', status: 'skip', summary: 'No managed database for this project.' };
  }

  const startedAt = Date.now();
  const probe = await apiRequest<any>('POST', `/projects/${projectId}/database/exec`, {
    sql: 'SELECT 1',
    confirm: false,
  });
  const latencyMs = Date.now() - startedAt;

  if (!probe.ok) {
    return {
      name: 'database',
      status: 'fail',
      summary: `SELECT 1 failed (${probe.status}). DB is unreachable or auth is broken.`,
      detail: { latency_ms: latencyMs, error: probe.data },
    };
  }
  return {
    name: 'database',
    status: 'ok',
    summary: `SELECT 1 OK in ${latencyMs}ms (${info.data.type || 'db'}).`,
    detail: {
      type: info.data.type,
      database: info.data.database,
      latency_ms: latencyMs,
    },
  };
}

async function checkEnv(projectId: string): Promise<Lane> {
  const res = await apiRequest<any>('GET', `/projects/${projectId}/env/runtime`);
  if (!res.ok) {
    return {
      name: 'env',
      status: 'fail',
      summary: `Could not fetch runtime env (${res.status}).`,
    };
  }
  if (res.data.no_deployment) {
    return { name: 'env', status: 'skip', summary: 'No deployment yet — env vars are injected at pod start.' };
  }
  const counts = res.data.counts || {};
  const customer = counts.customer || 0;
  // Anything that isn't customer-set is platform-injected.
  const platform = Object.entries(counts)
    .filter(([k]) => k !== 'customer')
    .reduce((sum, [, n]) => sum + (n as number), 0);
  return {
    name: 'env',
    status: 'ok',
    summary: `${customer} customer-set + ${platform} platform-injected env vars.`,
    detail: { customer, platform, by_source: counts },
  };
}

async function checkRecentErrors(projectId: string): Promise<Lane> {
  const res = await apiRequest<{ logs?: string[] }>('GET', `/projects/${projectId}/logs?tail=50`);
  if (!res.ok) {
    return { name: 'errors', status: 'skip', summary: 'No logs available (project may be paused).' };
  }
  const lines = res.data.logs || [];
  const matches = lines.filter((line) => ERROR_LINE_PATTERN.test(line));
  if (matches.length === 0) {
    return { name: 'errors', status: 'ok', summary: 'No error/fatal/panic in last 50 log lines.' };
  }
  // Heuristic: many error matches in 50 lines is a real fire. A handful of
  // routine "level=error" lines is normal noise — flag warn, not fail.
  const laneStatus: LaneStatus = matches.length >= 10 ? 'fail' : 'warn';
  return {
    name: 'errors',
    status: laneStatus,
    summary: `${matches.length} error/fatal/panic line(s) in last 50.`,
    detail: { matches: matches.slice(0, 5) },
  };
}

async function checkKnownPatterns(projectId: string): Promise<Lane> {
  const res = await apiRequest<{ logs?: string[] }>('GET', `/projects/${projectId}/logs?tail=100`);
  if (!res.ok) {
    return { name: 'known_issues', status: 'skip', summary: 'No logs available to scan for known issues.' };
  }
  const lines = res.data.logs || [];
  const logText = lines.join('\n');

  const matched: KnownIssue[] = [];
  const seen = new Set<string>();
  for (const rule of KNOWN_PATTERNS) {
    if (rule.pattern.test(logText) && !seen.has(rule.issue.id)) {
      seen.add(rule.issue.id);
      matched.push(rule.issue);
    }
  }

  if (matched.length === 0) {
    return { name: 'known_issues', status: 'ok', summary: 'No known crash patterns detected in last 100 log lines.' };
  }

  const hasFail = matched.some((i) => i.severity === 'fail');
  const laneStatus: LaneStatus = hasFail ? 'fail' : 'warn';
  const names = matched.map((i) => i.name).join('; ');

  return {
    name: 'known_issues',
    status: laneStatus,
    summary: `${matched.length} known issue(s) detected: ${names}`,
    detail: {
      issues: matched.map((i) => ({
        id: i.id,
        name: i.name,
        plain_english: i.plain_english,
        fix: i.fix,
      })),
    },
  };
}

function aggregateVerdict(lanes: Lane[]): { verdict: 'healthy' | 'degraded' | 'broken'; summary: string } {
  const hasFail = lanes.some((l) => l.status === 'fail');
  const hasWarn = lanes.some((l) => l.status === 'warn');

  if (hasFail) {
    const failingLanes = lanes.filter((l) => l.status === 'fail').map((l) => l.name);
    const allFailures = lanes
      .filter((l) => l.status === 'fail')
      .map((l) => `${l.name}: ${l.summary}`)
      .join(' ');
    return {
      verdict: 'broken',
      summary: `Project is broken. Failing checks: ${failingLanes.join(', ')}. ${allFailures}`,
    };
  }
  if (hasWarn) {
    const warnLanes = lanes.filter((l) => l.status === 'warn');
    const detail = warnLanes.map((l) => `${l.name}: ${l.summary}`).join(' ');
    return {
      verdict: 'degraded',
      summary: `Project is degraded but not down. ${detail}`,
    };
  }
  const okCount = lanes.filter((l) => l.status === 'ok').length;
  const skipped = lanes.filter((l) => l.status === 'skip').map((l) => l.name);
  let summary = `Project looks healthy. ${okCount} checks passed.`;
  if (skipped.length) summary += ` Skipped: ${skipped.join(', ')}.`;
  return { verdict: 'healthy', summary };
}

export function registerDiagnoseTools(server: McpServer) {
  server.tool(
    'dailey_diagnose',
    'FIRST tool to reach for when a customer says "something is broken." Runs every health check (deploy, pods, storage, database, env vars, recent log errors) for a project in parallel and returns a structured summary with an overall verdict (healthy/degraded/broken). Output includes a top-level `summary` string an AI agent can render directly to the user. Accepts either a project ID or a slug.',
    {
      project: z.string().describe('Project ID or slug — the tool resolves either.'),
    },
    async ({ project }) => {
      const resolved = await resolveProjectId(project);
      if (!resolved.id) {
        return textResult(
          JSON.stringify(
            {
              verdict: 'broken',
              summary: resolved.hint || `Could not resolve "${project}" to a project.`,
              project_input: project,
              matched_by: resolved.matched_by,
            },
            null,
            2,
          ),
        );
      }

      const projectId = resolved.id;
      // Run every lane in parallel — one slow lane shouldn't block the rest.
      const lanes = await Promise.all([
        checkDeploy(projectId).catch((err) => ({
          name: 'deploy',
          status: 'fail' as LaneStatus,
          summary: `lane crashed: ${err.message}`,
        })),
        checkPods(projectId).catch((err) => ({
          name: 'pods',
          status: 'fail' as LaneStatus,
          summary: `lane crashed: ${err.message}`,
        })),
        checkStorage(projectId).catch((err) => ({
          name: 'storage',
          status: 'fail' as LaneStatus,
          summary: `lane crashed: ${err.message}`,
        })),
        checkDatabase(projectId).catch((err) => ({
          name: 'database',
          status: 'fail' as LaneStatus,
          summary: `lane crashed: ${err.message}`,
        })),
        checkEnv(projectId).catch((err) => ({
          name: 'env',
          status: 'fail' as LaneStatus,
          summary: `lane crashed: ${err.message}`,
        })),
        checkRecentErrors(projectId).catch((err) => ({
          name: 'errors',
          status: 'fail' as LaneStatus,
          summary: `lane crashed: ${err.message}`,
        })),
        checkKnownPatterns(projectId).catch((err) => ({
          name: 'known_issues',
          status: 'fail' as LaneStatus,
          summary: `lane crashed: ${err.message}`,
        })),
      ]);

      const { verdict, summary } = aggregateVerdict(lanes);

      const payload = {
        project_id: projectId,
        project_input: project,
        matched_by: resolved.matched_by,
        verdict,
        summary,
        checks: lanes.reduce<Record<string, Lane>>((acc, lane) => {
          acc[lane.name] = lane;
          return acc;
        }, {}),
      };

      return textResult(JSON.stringify(payload, null, 2));
    },
  );
}
