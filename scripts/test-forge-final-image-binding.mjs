import assert from 'node:assert/strict';
import { checkFinalImageBinding, FINAL_IMAGE_EXECUTED_PATHS } from './forge-final-image-binding.mjs';
import { sha256 } from './forge-remediation-proof-proposal.mjs';
const head = 'a'.repeat(40);
function fixture(phase = 'prepublish') {
  const archiveBytes = Buffer.from('SYNTHETIC OCI archive; not an image');
  const configBytes = Buffer.from(JSON.stringify({ architecture: 'arm64', os: 'linux', config: { Labels: { 'org.opencontainers.image.revision': head } } }));
  const manifestBytes = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: `sha256:${sha256(configBytes)}` } }));
  const proofZipBytes = Buffer.from('SYNTHETIC proof ZIP; not authenticated evidence');
  const digest = `sha256:${sha256(manifestBytes)}`;
  return { execution: { event: 'merge_group', head, repository: 'OxyHQ/oxy', repositoryId: 973881060 },
    producer: { run: { id: 123, run_attempt: 1, event: 'merge_group', head_sha: head, repository: { id: 973881060, full_name: 'OxyHQ/oxy' }, head_repository: { full_name: 'OxyHQ/oxy' }, path: '.github/workflows/forge-queue-image-inspection.yml' },
      job: { run_id: 123, run_attempt: 1, head_sha: head, name: 'inspection', status: 'completed', conclusion: 'success', labels: ['ubuntu-24.04-arm'] },
      executedBlobs: { source: Object.fromEntries(FINAL_IMAGE_EXECUTED_PATHS.map(path => [path, 'b'.repeat(40)])), current: Object.fromEntries(FINAL_IMAGE_EXECUTED_PATHS.map(path => [path, 'b'.repeat(40)])) } },
    artifact: { workflow_run: { id: 123, head_sha: head, repository_id: 973881060 }, expired: false, expires_at: '2026-10-09T12:00:00Z', digest: `sha256:${sha256(proofZipBytes)}`, size_in_bytes: proofZipBytes.length },
    receipt: { schemaVersion: 1, sourceSha: head, runId: '123', archiveSha256: sha256(archiveBytes), manifestDigest: digest, approval: false },
    archiveBytes, manifestBytes, configBytes, proofZipBytes,
    inspected: Object.fromEntries(['dockerConfigId', 'mountProofImageId', 'rootScanImageId', 'regressionImageId'].map(key => [key, `sha256:${sha256(configBytes)}`])),
    published: phase === 'published' ? { repository: 'oxy/oxy-api', tag: `mq-${head}`, digest, manifestBytes } : null,
    phase, now: '2026-10-02T12:00:00Z' };
}
let count = 0;
for (const phase of ['prepublish', 'published']) { const x = fixture(phase); const r = checkFinalImageBinding(x); assert.equal(r.structurallyEligible, true, r.errors.join('\n')); assert.equal(r.authorized, false); count += 2; }
{ const x = fixture(); x.producer.run.status = 'in_progress'; x.producer.run.conclusion = null; const r = checkFinalImageBinding(x); assert.equal(r.structurallyEligible, true, 'completed inspection while publisher/workflow still in progress avoids cycle'); assert.equal(r.authorized, false); count += 2; }
for (const [name, mutate] of [
  ['scans used a different image', x => { x.inspected.regressionImageId = `sha256:${'f'.repeat(64)}`; }],
  ['Docker load config differs from OCI', x => { x.inspected.dockerConfigId = `sha256:${'f'.repeat(64)}`; }],
  ['PR artifact is not queue proof', x => { x.producer.run.event = 'pull_request'; }],
  ['main has a different SHA even with an otherwise identical source', x => { x.execution.event = 'push'; x.execution.head = 'c'.repeat(40); }],
  ['different image archive', x => { x.archiveBytes = Buffer.from('unscanned rebuild'); }],
  ['rewritten manifest', x => { x.manifestBytes = Buffer.from('{}'); }],
  ['wrong architecture', x => { x.configBytes = Buffer.from('{}'); }],
  ['caller approval flag', x => { x.receipt.approval = true; }],
  ['extra receipt field', x => { x.receipt.accepted = true; }],
  ['no archive', x => { x.archiveBytes = null; }],
  ['expired artifact', x => { x.artifact.expires_at = x.now; }],
  ['omitted scan executable', x => { delete x.producer.executedBlobs.source['scripts/forge-candidate-image-proof.mjs']; delete x.producer.executedBlobs.current['scripts/forge-candidate-image-proof.mjs']; }],
  ['unexpected executable', x => { x.producer.executedBlobs.source['arbitrary-code.mjs'] = 'b'.repeat(40); }],
  ['changed producer executable', x => { x.producer.executedBlobs.current[FINAL_IMAGE_EXECUTED_PATHS[0]] = 'f'.repeat(40); }],
  ['unfinished inspection', x => { x.producer.job.status = 'in_progress'; }],
  ['different published digest', x => { x.published.digest = `sha256:${'f'.repeat(64)}`; }],
  ['different published manifest', x => { x.published.manifestBytes = Buffer.from('rebuild'); }],
  ['different SHA tag', x => { x.published.tag = `mq-${'d'.repeat(40)}`; }],
]) { const x = fixture('published'); mutate(x); const r = checkFinalImageBinding(x); assert.equal(r.structurallyEligible, false, name); assert.equal(r.authorized, false); count += 2; }
assert.equal(checkFinalImageBinding(undefined).structurallyEligible, false); count++;
console.log(`${count} synthetic final-image binding assertions pass; no real image, publication or approval claimed.`);
