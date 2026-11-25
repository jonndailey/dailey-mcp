import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/tools/deploy-status.ts', import.meta.url), 'utf8');

test('deploy-status shows unknown instead of never when a date or SHA is missing', () => {
  assert.match(source, /status\.deployed_at \|\| 'unknown'/);
  assert.equal(source.includes("status.deployed_at || 'never'"), false);
  assert.equal(source.includes("status.current_sha || 'never'"), false);
  assert.match(source, /status\.current_sha \|\| 'unknown'/);
  assert.match(source, /Restart reason: \$\{status\.restart_reason\}/);
});
