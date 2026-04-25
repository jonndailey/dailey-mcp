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

  if (latest?.status === 'failed') {
    laneStatus = 'fail';
    summary = `Latest build ${latest.id} failed (${latest.finished_at || 'unknown time'}).`;
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
