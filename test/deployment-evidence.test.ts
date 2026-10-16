import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatDeploymentEvidence} from '../src/tools/deployment-evidence.js';
test('digest and failed pipeline remain distinct from an old successful build',()=>{
  const text=formatDeploymentEvidence({runtime:{available:true,desired_image:'app@sha256:abc',running_images:['app@sha256:abc'],ready_replicas:2,desired_replicas:2,rollout_complete:true,commit_sha:null},pipeline:{id:'p',status:'failed',commit_sha:'new'},last_successful_build:{commit_sha:'old'}}).join('\n');
  assert.match(text,/Runtime commit: unknown/);assert.match(text,/Latest pipeline: p — failed/);assert.match(text,/old \(historical, not runtime verification\)/);
});
test('unavailable runtime and pipeline do not imply a healthy deployment',()=>{
  const text=formatDeploymentEvidence({runtime:{available:false},pipeline_available:false}).join('\n');assert.match(text,/no deployed commit can be verified/);assert.match(text,/Pipeline status: unavailable/);
});
test('older API is explicitly identified as lacking runtime evidence',()=>{
  assert.match(formatDeploymentEvidence({current_sha:'old'}).join('\n'),/not live verification/);
});
