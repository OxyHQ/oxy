import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { inspectFinalImageFacts, selectFinalInspection, listFinalPages, assertFinalWaitDeadline, checkFinalProofFreshness, FINAL_INSPECTION_STEPS } from './forge-final-image-collector.mjs';
import { FINAL_IMAGE_EXECUTED_PATHS } from './forge-final-image-binding.mjs';
import { readZip, sha256 } from './forge-remediation-proof-proposal.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = readFileSync(join(root, 'docs/security/forge-candidate/queue-dag-review-2026-10-02/pr-source-proof-baseline.zip'));
assert.equal(`sha256:${sha256(baseline)}`, 'sha256:47811e6da747bab767d3be4fe175bf1a04affbac614317bd865ce39a61ee8b79');
export function zip(entries) {
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
export const head = 'a'.repeat(40);
export function fixture() {
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
