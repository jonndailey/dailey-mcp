import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult, isValidProjectId, invalidProjectIdResult } from '../api.js';

interface DeployStatus {
  mode?: 'git' | 'image';
  image?: string;
  current_sha?: string | null;
  deployed_at?: string | null;
  can_deploy?: boolean;
  is_building?: boolean;
  branch?: string;
  has_new_version?: boolean;
  new_commits?: number;
  latest_sha?: string | null;
  latest_message?: string | null;
  pod_crash?: { restart_count: number; recent_logs: string } | null;
}

interface Build {
  id: string;
  status?: string;
  started_at?: string;
  finished_at?: string;
  commit_sha?: string;
}

interface BuildRow {
  id: string;
  status: string;
  log?: string;
  started_at?: string;
  finished_at?: string;
  commit_sha?: string;
  build_error_summary?: string;
  build_error_fix?: string;
}

const STAGE_EMOJI_RE = /^[⚙📦🚀✅🎉❌]/;

function latestProgressLine(log: string): string | null {
  if (!log) return null;
  const lines = log.split('\n').map((l) => l.trim()).filter((l) => STAGE_EMOJI_RE.test(l));
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

const FAILURE_PATTERNS: Array<{ pattern: RegExp; reason: string; fix: string }> = [
  { pattern: /npm ci.*did not complete|npm ERR! cipm can only install/i,
    reason: 'npm ci failed — package-lock.json missing or out of sync.',
    fix: 'Run `npm install` locally, commit the generated package-lock.json, redeploy.' },
  { pattern: /Cannot find module|Module not found|Can't resolve/i,
    reason: 'A required dependency or file is missing.',
    fix: 'Ensure all imports are listed in package.json and referenced files exist in the repo.' },
  { pattern: /EACCES|permission denied/i,
    reason: 'File permission error during build.',
    fix: 'Dailey OS builds run non-root. Remove anything that assumes root.' },
  { pattern: /ERR_SOCKET_TIMEOUT|ETIMEDOUT|EAI_AGAIN/i,
    reason: 'Network timeout fetching dependencies.',
    fix: 'Usually transient. Redeploy.' },
  { pattern: /exit code: 1.*build|build.*exit code: 1/i,
    reason: "The app's build command failed.",
    fix: 'Run the build locally and fix errors before redeploying.' },
  { pattern: /port.*in use|EADDRINUSE/i,
    reason: 'App trying to bind a port already in use.',
    fix: 'Read port from `process.env.PORT` (default 3000), not hardcoded.' },
  { pattern: /ERR_DLOPEN_FAILED|native.*module|node-gyp/i,
    reason: 'Native Node module failed to compile.',
    fix: 'Needs Linux build. Add a Dockerfile or use a pure-JS alternative.' },
  { pattern: /ENOMEM|heap.*limit|out of memory/i,
    reason: 'Build ran out of memory.',
    fix: 'Contact support to bump build memory limit.' },
  { pattern: /Dockerfile.*not found|no.*Dockerfile/i,
    reason: 'No Dockerfile found and stack auto-detection failed.',
    fix: 'Add a Dockerfile or ensure package.json / requirements.txt / go.mod / index.html exists at repo root.' },
];

function getFailureGuidance(log: string): { reason: string; fix: string } | null {
  if (!log) return null;
  for (const { pattern, reason, fix } of FAILURE_PATTERNS) {
    if (pattern.test(log)) return { reason, fix };
  }
  return null;
}

const RUNTIME_CRASH_PATTERNS: Array<{ pattern: RegExp; summary: string; fix: string }> = [
  {
    pattern: /P3009|migrate found failed migrations/i,
    summary: 'Prisma migration failed on startup (P3009). A previous migration left the database in a dirty state and Prisma is blocking all further migrations.',
    fix: 'Run `npx prisma migrate resolve --rolled-back <migration_name>` to mark the failed migration as rolled back, then redeploy. If the database is fresh with no real data, you can clear `_prisma_migrations` entirely and redeploy to run all migrations from scratch. Use `dailey_db_exec` to inspect the `_prisma_migrations` table.',
  },
  {
    pattern: /Cannot find module|MODULE_NOT_FOUND/,
    summary: 'App crashed at startup — a required module or file is missing at runtime.',
    fix: 'A file is imported but does not exist in the deployed image. Search for the import in your source, check if the file was deleted or renamed, and fix the import before redeploying. Run `npx tsc --noEmit` locally to catch this before deploying.',
  },
  {
    pattern: /password authentication failed|ECONNREFUSED.*5432|ECONNREFUSED.*3306|connection refused.*database/i,
    summary: 'App crashed — cannot connect to the database.',
    fix: 'Check that the database is provisioned and DATABASE_URL is set. Run `dailey_env_list` to verify the env var is present. If the database was recently created, it may still be initialising — wait 30 seconds and redeploy.',
  },
  {
    pattern: /EADDRINUSE/i,
    summary: 'App crashed — port already in use.',
    fix: 'The app is trying to bind a hardcoded port. Read the port from `process.env.PORT` and bind to `0.0.0.0`, not localhost.',
  },
  {
    pattern: /ENOMEM|heap out of memory|JavaScript heap out of memory/i,
    summary: 'App crashed — out of memory (OOM).',
    fix: 'The app exceeded its RAM limit. Scale up RAM from the dashboard, or add `--max-old-space-size=<MB>` to NODE_OPTIONS env var to cap Node.js heap below the container limit.',
  },
  {
    pattern: /missing required env|required environment variable|env.*not.*set|getenv.*undefined/i,
    summary: 'App crashed — a required environment variable is not set.',
    fix: 'Run `dailey_env_list` to see what env vars are set. Add the missing variable with `dailey_env_set`, then redeploy.',
  },
  {
    pattern: /PRISMA_CLIENT_NOT_GENERATED|@prisma\/client did not initialize/i,
    summary: 'Prisma Client was not generated before the app started.',
    fix: 'Add `prisma generate` to your build step or postinstall script. In package.json: `"postinstall": "prisma generate"`.',
  },
  {
    pattern: /SyntaxError|unexpected token|Cannot use import/i,
    summary: 'App crashed — JavaScript syntax error or ESM/CJS module incompatibility.',
    fix: 'The compiled output has a syntax error or module format mismatch. Check your tsconfig `module` and `target` settings. Run `npm run build` locally and start the compiled output to reproduce.',
  },
];

function getRuntimeCrashGuidance(logs: string): { summary: string; fix: string } | null {
  if (!logs) return null;
  for (const { pattern, summary, fix } of RUNTIME_CRASH_PATTERNS) {
    if (pattern.test(logs)) return { summary, fix };
  }
  return null;
}

export function registerDeployStatusTools(server: McpServer) {
  // Project-level pre-deploy status: can I deploy? is a build running? is there a new commit?
  // Also fetches the latest build row to show progress emojis during active builds.
  server.tool(
    'dailey_deploy_status',
    'Check deploy status for a project: whether a new version exists, whether a build is in progress, the current progress stage (⚙📦🚀✅🎉) if building, and whether it is safe to trigger a new deploy. Call this AFTER dailey_deploy_multi or dailey_run_image to watch progress.',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      if (!isValidProjectId(project_id)) return invalidProjectIdResult(project_id);
      const statusRes = await apiRequest<DeployStatus>('GET', `/projects/${project_id}/deploy-status`);
      if (!statusRes.ok) return textResult(formatError(statusRes));

      const status = statusRes.data;
      const lines: string[] = [];

      if (status.mode === 'image') {
        lines.push(`Deploy mode: Docker image`);
        lines.push(`Image:       ${status.image || '-'}`);
        lines.push(`Deployed at: ${status.deployed_at || 'never'}`);
        lines.push(`Can deploy:  ${status.can_deploy ? 'yes' : 'no'}`);
      } else {
        lines.push(`Deploy mode: Git`);
        lines.push(`Branch:      ${status.branch || 'main'}`);
        lines.push(`Deployed SHA: ${status.current_sha || 'never'}`);
        lines.push(`Deployed at: ${status.deployed_at || 'never'}`);
        // Only show Latest SHA when the upstream lookup actually returned
        // something. Emitting "Latest SHA: unknown" on every healthy project
        // is noise that implies something is broken (it's almost always just
        // that the GH token hasn't been connected, or there's no activity).
        if (status.latest_sha) {
          lines.push(`Latest SHA:  ${status.latest_sha}`);
        }
        if (status.latest_message) {
          lines.push(`Latest msg:  ${status.latest_message}`);
        }
        // Only show New version when we actually have a Latest SHA to
        // compare against — otherwise the "no" is meaningless.
        if (status.latest_sha) {
          lines.push(`New version: ${status.has_new_version ? `yes (${status.new_commits || '?'} new commits)` : 'no'}`);
        }
        lines.push(`Building:    ${status.is_building ? 'yes' : 'no'}`);
        lines.push(`Can deploy:  ${status.can_deploy ? 'yes' : 'no'}`);
      }

      // If there's an active or recent build, fetch its progress.
      const historyRes = await apiRequest<{ builds: Build[] }>('GET', `/projects/${project_id}/deploys`);
      if (historyRes.ok && historyRes.data.builds?.length) {
        const latest = historyRes.data.builds[0];
        lines.push('');
        lines.push(`Latest build: ${latest.id}`);
        lines.push(`  Status:    ${latest.status || 'unknown'}`);
        lines.push(`  Started:   ${latest.started_at || '-'}`);
        if (latest.finished_at) lines.push(`  Finished:  ${latest.finished_at}`);

        // Fetch build detail (includes log) for progress + failure info.
        const buildRes = await apiRequest<BuildRow>('GET', `/builds/${latest.id}`);
        if (buildRes.ok) {
          const buildData = buildRes.data;
          const log = buildData.log || '';
          const progress = latestProgressLine(log);
          if (progress) {
            lines.push(`  Progress:  ${progress}`);
          }
          // Runtime crash — build succeeded but pod is CrashLoopBackOff
          if (status.pod_crash) {
            const crash = status.pod_crash;
            const guidance = getRuntimeCrashGuidance(crash.recent_logs);
            lines.push('');
            lines.push(`⚠️  RUNTIME CRASH (build succeeded, app crashes on startup)`);
            lines.push(`   Restarts:  ${crash.restart_count}`);
            if (guidance) {
              lines.push(`   Error:     ${guidance.summary}`);
              lines.push(`   Fix:       ${guidance.fix}`);
            } else {
              lines.push(`   Logs (last 40 lines):`);
              crash.recent_logs.split('\n').slice(-20).filter(Boolean).forEach((l) => {
                lines.push(`     ${l}`);
              });
              lines.push(`   Tip: call dailey_app_logs with project_id=${project_id} for full logs.`);
            }
          }

          if (latest.status === 'failed') {
            // Prefer the structured diagnosis fields surfaced by the deploy-service
            // (build_error_summary / build_error_fix) over the local pattern matching.
            // These are synthesised from the stored log by the deploy-service and are
            // more accurate than re-running regexes against a potentially truncated log.
            if (buildData.build_error_summary) {
              lines.push('');
              lines.push(`❌ BUILD FAILED`);
              lines.push(`   Error:     ${buildData.build_error_summary}`);
              if (buildData.build_error_fix) {
                lines.push(`   Fix:       ${buildData.build_error_fix}`);
              }
            } else {
              // Fall back to local pattern matching if no structured diagnosis
              const guidance = getFailureGuidance(log);
              if (guidance) {
                lines.push('');
                lines.push(`❌ Failure reason: ${guidance.reason}`);
                lines.push(`   How to fix:    ${guidance.fix}`);
              }
            }
            lines.push('');
            lines.push(`Tip: call dailey_build_logs with build_id=${latest.id} for the full build log.`);
          }
        }
      }

      return textResult(lines.join('\n'));
    },
  );
}
