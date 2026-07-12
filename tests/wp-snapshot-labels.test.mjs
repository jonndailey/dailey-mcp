import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerWordPressSnapshotTools } from '../dist/tools/wordpress-snapshot.js';

function collect() {
  const regs = [];
  registerWordPressSnapshotTools({ tool: (name, description, schema, handler) => regs.push({ name, description, schema, handler }) });
  return regs;
}

test('dailey_wp_snapshot exposes an optional label param', () => {
  const reg = collect().find((r) => r.name === 'dailey_wp_snapshot');
  assert.ok(reg, 'tool must be registered');
  assert.ok('label' in reg.schema, 'schema must include a label field');
});

test('dailey_wp_snapshots source references reason + label columns', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../dist/tools/wordpress-snapshot.js', import.meta.url), 'utf8'));
  assert.ok(/reason/i.test(src), 'list output should surface provenance (reason)');
  assert.ok(/label/i.test(src), 'list output should surface label');
});
