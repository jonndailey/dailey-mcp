export function formatDeploymentEvidence(status: any): string[] {
  if (!('runtime' in status)) return ['Runtime artifact: not reported by this API version; build history is not live verification.'];
  const r = status.runtime;
  const lines = r?.available ? [
    `Desired image: ${r.desired_image || 'unknown'}`,
    `Running images: ${(r.running_images || []).join(', ') || 'none observed'}`,
    `Ready replicas: ${r.ready_replicas}/${r.desired_replicas}`,
    `Rollout complete: ${r.rollout_complete ? 'yes' : 'no'}`,
    `Runtime commit: ${r.commit_sha || 'unknown'}${r.commit_source ? ` (${r.commit_source})` : ''}`,
  ] : ['Runtime artifact: unavailable; no deployed commit can be verified.'];
  if (status.pipeline_available === false) lines.push('Pipeline status: unavailable');
  else if (status.pipeline) lines.push(`Latest pipeline: ${status.pipeline.id} — ${status.pipeline.status} (commit ${status.pipeline.commit_sha || 'unknown'})`);
  else lines.push('Latest pipeline: none recorded');
  if (status.active_pipeline) lines.push(`Active pipeline: ${status.active_pipeline.id} — ${status.active_pipeline.status}`);
  if (status.last_successful_build) lines.push(`Last successful legacy build: ${status.last_successful_build.commit_sha || 'unknown'} (historical, not runtime verification)`);
  return lines;
}
