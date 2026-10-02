import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { inspectFinalImageFacts, selectFinalInspection, listFinalPages, assertFinalWaitDeadline, FINAL_INSPECTION_STEPS } from './forge-final-image-collector.mjs';
import { FINAL_IMAGE_EXECUTED_PATHS } from './forge-final-image-binding.mjs';
import { readZip, sha256 } from './forge-remediation-proof-proposal.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = readFileSync(join(root, 'docs/security/forge-candidate/queue-dag-review-2026-10-02/pr-source-proof-baseline.zip'));
assert.equal(`sha256:${sha256(baseline)}`, 'sha256:47811e6da747bab767d3be4fe175bf1a04affbac614317bd865ce39a61ee8b79');
function zip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data); centrals.push(central, n); offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const head = 'a'.repeat(40);
function fixture() {
  // DERIVED synthetic queue fixture, not actual queue/image evidence. Candidate
  // scan rows are retained from the authenticated PR artifact; context is changed.
  const entries = readZip(baseline);
  const configBytes = Buffer.from(JSON.stringify({ architecture: 'arm64', os: 'linux', config: { Labels: { 'org.opencontainers.image.revision': head } } }));
  const configId = `sha256:${sha256(configBytes)}`;
  const manifestBytes = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: configId } }));
  const manifestDigest = `sha256:${sha256(manifestBytes)}`;
  const put = (name, value) => entries.set(name, Buffer.from(JSON.stringify(value)));
  const metadata = JSON.parse(entries.get('forge-build-metadata.json'));
  metadata['containerimage.config.digest'] = configId; metadata['containerimage.digest'] = manifestDigest;
  put('forge-build-metadata.json', metadata);
  entries.set('forge-image-identity.txt', Buffer.from(`${JSON.stringify(configId)} "arm64" "linux" "${head}"\n`));
  const mount = JSON.parse(entries.get('forge-image-mount-targets.json')); mount.sourceSha = head; mount.imageId = configId; put('forge-image-mount-targets.json', mount);
  put('forge-oci-receipt.json', { schemaVersion: 1, sourceSha: head, runId: '123', archiveSha256: 'd'.repeat(64), manifestDigest, approval: false });
  put('forge-queue-execution.json', { sourceSha: head, workflowSha: head, repository: 'OxyHQ/oxy', repositoryId: '973881060', event: 'merge_group', runId: '123', runAttempt: '1', job: 'inspection', approval: false });
  put('forge-scan-image-ids.json', Object.fromEntries(['dockerConfigId', 'mountProofImageId', 'rootScanImageId', 'regressionImageId'].map(key => [key, configId])));
  entries.set('forge-oci-manifest.json', manifestBytes); entries.set('forge-oci-config.json', configBytes);
  const proofZipBytes = zip(entries);
  const run = { id: 123, run_attempt: 1, event: 'merge_group', head_sha: head, repository: { full_name: 'OxyHQ/oxy', id: 973881060 }, head_repository: { full_name: 'OxyHQ/oxy' }, path: '.github/workflows/forge-queue-image-inspection.yml', status: 'in_progress', conclusion: null };
  const job = { name: 'inspection', run_id: 123, run_attempt: 1, head_sha: head, status: 'completed', conclusion: 'success', labels: ['ubuntu-24.04-arm'], steps: FINAL_INSPECTION_STEPS.map(name => ({ name, conclusion: 'success' })) };
  const artifact = { id: 456, name: `forge-queue-proof-${head}-123`, workflow_run: { id: 123, head_sha: head, repository_id: 973881060 }, expired: false, expires_at: '2026-10-09T12:00:00Z', size_in_bytes: proofZipBytes.length, digest: `sha256:${sha256(proofZipBytes)}` };
  const archiveArtifact = { ...artifact, id: 457, name: `forge-queue-oci-${head}-123`, size_in_bytes: 999, digest: `sha256:${'e'.repeat(64)}` };
  return { execution: { head, event: 'merge_group', repository: 'OxyHQ/oxy', repositoryId: 973881060 }, producer: { run, job, executedBlobs: { source: Object.fromEntries(FINAL_IMAGE_EXECUTED_PATHS.map(p => [p, 'b'.repeat(40)])), current: Object.fromEntries(FINAL_IMAGE_EXECUTED_PATHS.map(p => [p, 'b'.repeat(40)])) } }, artifact, archiveArtifact, proofZipBytes, archiveBytes: null,
    archiveVerification: { schemaVersion: 1, artifactId: 457, zipDigest: archiveArtifact.digest, zipSizeBytes: archiveArtifact.size_in_bytes, archiveSha256: 'd'.repeat(64), archiveSizeBytes: 500 }, published: null, phase: 'prepublish', now: '2026-10-02T12:00:00Z' };
}
let count = 1;
const good = fixture();
const positive = inspectFinalImageFacts(good);
assert.equal(positive.structurallyEligible, true, positive.errors.join('\n')); count++;
assert.equal(positive.authenticatedProvenance, false); count++;
assert.equal(positive.machineChecksPassed, false); count++;
assert.equal(positive.authorized, false); count++;
const state = x => selectFinalInspection([x.producer.run], [x.producer.job], [x.artifact, x.archiveArtifact], x.execution.head);
assert.equal(state(good).state, 'ready', 'inspection can complete before workflow/publisher'); count++;
for (const [name, mutate] of [
  ['skipped scan step', x => { x.producer.job.steps[6].conclusion = 'skipped'; }],
  ['extra executed step', x => { x.producer.job.steps.push({ name: 'arbitrary extra step', conclusion: 'success' }); }],
  ['raw artifact tampered', x => { x.proofZipBytes = Buffer.from('fake zip'); }],
  ['metadata cannot substitute actual archive verification', x => { delete x.archiveVerification; }],
  ['streaming archive digest differs', x => { x.archiveVerification.archiveSha256 = 'f'.repeat(64); }],
  ['transport archive absent', x => { x.archiveArtifact = null; }],
  ['transport artifact wrong source', x => { x.archiveArtifact.workflow_run.head_sha = 'f'.repeat(40); }],
  ['old PR context', x => { x.producer.run.event = 'pull_request'; }],
  ['missing declared blob', x => { delete x.producer.executedBlobs.source['Dockerfile']; }],
  ['image digest replaced', x => { x.artifact.digest = `sha256:${'f'.repeat(64)}`; }],
]) { const x = fixture(); mutate(x); const r = inspectFinalImageFacts(x); assert.equal(r.structurallyEligible, false, name); assert.equal(r.machineChecksPassed, false); count += 2; }
for (const [name, mutate] of [
  ['stock distribution hidden in inventory', entries => { const x = JSON.parse(entries.get('forge-image-regression-proof.json')); x.copies[0].files['lib/rsa.js'] = 'f'.repeat(64); entries.set('forge-image-regression-proof.json', Buffer.from(JSON.stringify(x))); }],
  ['different executed workflow SHA', entries => { const x = JSON.parse(entries.get('forge-queue-execution.json')); x.workflowSha = 'f'.repeat(40); entries.set('forge-queue-execution.json', Buffer.from(JSON.stringify(x))); }],
  ['regression row missing', entries => { const x = JSON.parse(entries.get('forge-image-regression-proof.json')); x.regressions[0].rows.pop(); entries.set('forge-image-regression-proof.json', Buffer.from(JSON.stringify(x))); }],
  ['unknown extra artifact member', entries => { entries.set('unexpected.json', Buffer.from('{}')); }],
]) { const x = fixture(); const entries = readZip(x.proofZipBytes); mutate(entries); x.proofZipBytes = zip(entries); x.artifact.digest = `sha256:${sha256(x.proofZipBytes)}`; x.artifact.size_in_bytes = x.proofZipBytes.length; const r = inspectFinalImageFacts(x); assert.equal(r.structurallyEligible, false, name); assert.equal(r.authorized, false); count += 2; }
{ const x = fixture(); x.producer.job.status = 'in_progress'; assert.equal(state(x).state, 'pending'); count++; }
{ const x = fixture(); x.producer.job.conclusion = 'failure'; assert.equal(state(x).state, 'failed'); count++; }
{ const x = fixture(); x.producer.run.event = 'pull_request'; assert.equal(state(x).state, 'pending'); count++; }
{ const x = fixture(); x.producer.run.status = 'completed'; assert.equal(selectFinalInspection([x.producer.run], [], [], head).state, 'failed'); count++; }
const forged = { ...fixture(), authenticatedProvenance: true, approved: true };
assert.equal(inspectFinalImageFacts(forged).machineChecksPassed, false); count++;
{ const x = fixture(); const dup = { ...x.artifact, id: 999 }; assert.equal(selectFinalInspection([x.producer.run], [x.producer.job], [x.artifact, dup, x.archiveArtifact], head).state, 'failed'); count++; }
{ const x = fixture(); assert.equal(selectFinalInspection([x.producer.run], [x.producer.job, { ...x.producer.job }], [x.artifact, x.archiveArtifact], head).state, 'failed'); count++; }
{ const x = fixture(); x.producer.job.run_attempt = 2; assert.equal(state(x).state, 'pending'); count++; }
{ let page = 0; const rows = listFinalPages(path => { page++; assert.match(path, /per_page=100&page=/); return { artifacts: page === 1 ? Array(100).fill({ id: 1 }) : [{ id: 2 }] }; }, 'fixture?head_sha=synthetic', 'artifacts'); assert.equal(rows.length, 101); assert.equal(page, 2); count += 2; }
assert.throws(() => listFinalPages(() => ({ artifacts: Array(100).fill({}) }), 'fixture', 'artifacts'), /2000-record/); count++;
assert.throws(() => listFinalPages(() => ({ artifacts: null }), 'fixture', 'artifacts'), /Malformed/); count++;
assertFinalWaitDeadline(9, 10); count++;
assert.throws(() => assertFinalWaitDeadline(10, 10), /wait expired/); count++;
console.log(`${count} final-image collector/real-scan-content assertions pass on DERIVED SYNTHETIC queue context; no authenticated queue or publication claimed.`);
