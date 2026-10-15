import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';

// The `image` (SDXL) and `tts` (Kokoro) Dailey Compute workloads were retired
// 2026-10-08 (customer-api now answers 410). The AI must be steered to Dailey
// Images / Dailey Voice instead and never told Compute can do either.
function tools(): Record<string, any> {
  const server = buildServer({ includeAdmin: true, includeLocalAuth: true, includeAccountSwitch: true });
  return (server as any)._registeredTools ?? {};
}

async function guideText(): Promise<string> {
  const t = tools().dailey_os_guide;
  const run = t.handler ?? t.callback;
  const out = await run({}, {});
  return out.content.map((c: any) => c.text).join('\n');
}

test('dailey_compute_enable lists only live workloads and points to Images / Voice', () => {
  const d: string = tools().dailey_compute_enable.description;
  assert.match(d, /transcribe/);
  assert.match(d, /image-edit/);
  assert.match(d, /dailey_images_generate/);
  assert.match(d, /Dailey Voice/);
  assert.match(d, /ai\/audio\/speech/);
  assert.doesNotMatch(d, /—/, 'no em dash in customer-facing copy');
});

test('platform guide marks image + tts compute workloads retired and names replacements', async () => {
  const g = await guideText();
  const compute = g.slice(g.indexOf('### Dailey Compute'), g.indexOf('### Dailey Images'));
  assert.match(compute, /transcribe/);
  assert.match(compute, /image-edit/);
  assert.match(compute, /retired/);
  assert.match(compute, /Dailey Images/);
  assert.match(compute, /Dailey Voice/);
  assert.match(g, /images\/generations/);
  assert.match(g, /ai\/audio\/speech/);
});

test('no tool description advertises an image or tts compute workload', () => {
  for (const [name, t] of Object.entries(tools())) {
    const d = String(t.description ?? '');
    assert.doesNotMatch(d, /compute\/(image|tts)\b/, `${name} advertises a retired compute route`);
    assert.doesNotMatch(d, /\b(SDXL|Kokoro)\b/, `${name} mentions a retired compute model`);
  }
});
