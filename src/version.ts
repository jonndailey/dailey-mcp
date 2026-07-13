/**
 * Version identity + staleness self-check.
 *
 * WHY (2026-07-13 dogfood incident): sessions silently ran a months-old MCP
 * (global-install shadowing + stale npx cache), so the agent was missing ~35
 * tools and told the customer the platform had no AI. Staleness must never be
 * silent again:
 *   - OWN_VERSION is read from package.json (the server previously hardcoded a
 *     stale string) and sent on every API request as X-Dailey-Client-Version,
 *     so the platform can see exactly which versions are live in the field.
 *   - checkForNewerVersion() asks the npm registry (fail-open, hard timeout)
 *     whether this copy is behind; the caller surfaces the notice to the AGENT
 *     via server instructions, so the agent itself tells the user to update.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const OWN_VERSION: string = (() => {
  try {
    return require('../package.json').version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** Numeric semver compare (a<b → -1). Non-numeric parts compare as 0. */
function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
  }
  return 0;
}

/**
 * Returns the newer registry version when this copy is outdated, else null.
 * Fail-open: any network error / timeout returns null (never blocks startup).
 */
export async function checkForNewerVersion(timeoutMs = 1500): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch('https://registry.npmjs.org/@daileyos%2Fmcp-server/latest', {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    const latest = data?.version;
    if (latest && cmpSemver(OWN_VERSION, latest) < 0) return latest;
    return null;
  } catch {
    return null;
  }
}

/** The notice shown to the agent (via server instructions) when outdated. */
export function outdatedNotice(latest: string): string {
  return (
    `NOTE: this Dailey OS MCP server is v${OWN_VERSION}, but v${latest} is available. ` +
    `Some platform tools/documentation may be missing from this session. ` +
    `Tell the user: "My Dailey OS tools are outdated (v${OWN_VERSION} vs v${latest}) — ` +
    `restart the app to pick up the latest," and prefer verifying capabilities with ` +
    `dailey_platform_info / dailey_os_guide rather than assuming a feature does not exist.`
  );
}
