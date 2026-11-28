import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/tools/deploy-status.ts', import.meta.url), 'utf8');

test('deploy-status shows unknown instead of never when a date or SHA is missing', () => {
  assert.match(source, /status\.deployed_at \|\| 'unknown'/);
  assert.equal(source.includes("status.deployed_at || 'never'"), false);
  assert.equal(source.includes("status.current_sha || 'never'"), false);
  // The SHA line now goes through formatDeployedSha (falls back to 'unknown';
  // behavior pinned in deploy-status-sha.test.ts).
  assert.match(source, /Deployed SHA: \$\{formatDeployedSha\(status\)\}/);
  assert.match(source, /return 'unknown';/);
  assert.match(source, /Restart reason: \$\{status\.restart_reason\}/);
});
