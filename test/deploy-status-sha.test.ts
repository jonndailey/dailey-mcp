// SR-XETK3T7D (Jackson Howard, 2026-11-27): right after a successful deploy,
// dailey_deploy_status printed "Deployed SHA: unknown" while "Restart reason" in the
// same output already named the new image. During a rollout we now print the image
// tag being rolled out, labeled, and keep the settled value strict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDeployedSha } from '../src/tools/deploy-status.js';

test('settled deploy prints the current SHA unchanged', () => {
  assert.equal(formatDeployedSha({ current_sha: '5c77bdc', rollout_state: 'complete' }), '5c77bdc');
  assert.equal(formatDeployedSha({ current_sha: '2decec7' }), '2decec7');
});

test('THE BUG (new API): rolling out prints the labeled target, not unknown', () => {
  const line = formatDeployedSha({ current_sha: null, target_sha: '5c77bdc', rollout_state: 'rolling_out',
    runtime: { available: true, ready_replicas: 0, desired_replicas: 1 } });
  assert.equal(line, '5c77bdc (rolling out, 0/1 ready; not settled yet)');
  assert.ok(line.startsWith('5c77bdc'), 'a "compare Deployed SHA to my push" routine still works');
});

test('THE BUG (current prod API, no new fields): derived from runtime.desired_image', () => {
  const line = formatDeployedSha({ current_sha: null, runtime: { available: true, rollout_complete: false,
    desired_image: 'registry.dailey.cloud/customer-jacksonhoward/ashburton-bus-tracker:5c77bdc', ready_replicas: 1, desired_replicas: 1 } });
  assert.equal(line, '5c77bdc (rolling out, 1/1 ready; not settled yet)');
});

test('failed rollout with the previous version still serving says so', () => {
  assert.equal(formatDeployedSha({ current_sha: null, target_sha: '5c77bdc', rollout_state: 'failed',
    runtime: { available: true, serving_shas: ['2decec7', '5c77bdc'] } }),
  '2decec7 (rollout of 5c77bdc failed; previous version still serving)');
  // Falls back to running_images when serving_shas is absent.
  assert.equal(formatDeployedSha({ current_sha: null, target_sha: '5c77bdc', rollout_state: 'failed',
    runtime: { available: true, running_images: ['r/app:2decec7'] } }),
  '2decec7 (rollout of 5c77bdc failed; previous version still serving)');
});

test('failed rollout with nothing identifiable serving stays unknown but names the attempt', () => {
  assert.equal(formatDeployedSha({ current_sha: null, target_sha: '5c77bdc', rollout_state: 'failed', runtime: { available: true } }),
    'unknown (rollout of 5c77bdc failed)');
});

test('missing image tag (digest / latest) stays unknown during a rollout', () => {
  for (const desired_image of ['r/app@sha256:' + 'a'.repeat(64), 'r/app:latest', 'r/app', null]) {
    assert.equal(formatDeployedSha({ current_sha: null, runtime: { available: true, rollout_complete: false, desired_image, desired_replicas: 1 } }), 'unknown');
  }
});

test('unavailable runtime, stopped apps and settled-without-tag stay unknown', () => {
  assert.equal(formatDeployedSha({ current_sha: null, runtime: { available: false } }), 'unknown');
  assert.equal(formatDeployedSha({ current_sha: null }), 'unknown');
  assert.equal(formatDeployedSha({ current_sha: null, rollout_state: 'stopped', runtime: { available: true, desired_image: 'r/app:5c77bdc', desired_replicas: 0 } }), 'unknown');
  assert.equal(formatDeployedSha({ current_sha: null, runtime: { available: true, rollout_complete: false, desired_image: 'r/app:5c77bdc', desired_replicas: 0 } }), 'unknown');
  assert.equal(formatDeployedSha({ current_sha: null, rollout_state: 'complete', runtime: { available: true, rollout_complete: true, desired_image: 'r/app@sha256:abc' } }), 'unknown');
});

test('a historical build SHA is never used as the deployed SHA', () => {
  assert.equal(formatDeployedSha({ current_sha: null, runtime: { available: false } } as any), 'unknown');
});
