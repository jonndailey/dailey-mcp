import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

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

export function registerDeployStatusTools(server: McpServer) {
  // Project-level pre-deploy status: can I deploy? is a build running? is there a new commit?
  // Also fetches the latest build row to show progress emojis during active builds.
  server.tool(
    'dailey_deploy_status',
    'Check deploy status for a project: whether a new version exists, whether a build is in progress, the current progress stage (⚙📦🚀✅🎉) if building, and whether it is safe to trigger a new deploy. Call this AFTER dailey_deploy_multi or dailey_run_image to watch progress.',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
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
          const log = buildRes.data.log || '';
          const progress = latestProgressLine(log);
          if (progress) {
            lines.push(`  Progress:  ${progress}`);
          }
          if (latest.status === 'failed') {
            const guidance = getFailureGuidance(log);
            if (guidance) {
              lines.push('');
              lines.push(`❌ Failure reason: ${guidance.reason}`);
              lines.push(`   How to fix:    ${guidance.fix}`);
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
