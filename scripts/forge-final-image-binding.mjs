/** Preparation only: structural contract for the unapplied image DAG. No audit authority. */
import { sha256 } from './forge-remediation-proof-proposal.mjs';
export const FINAL_IMAGE_EXECUTED_PATHS = Object.freeze([
  '.github/workflows/ci.yml', '.github/workflows/forge-queue-image-inspection.yml',
  '.github/workflows/merge-queue-image.yml', '.github/workflows/deploy-aws.yml',
  '.github/scripts/resolve-queue-image.sh', 'Dockerfile',
  'scripts/check-published-forge-image.mjs', 'scripts/check-dependency-audit.mjs', 'scripts/forge-audit-policy.mjs',
  'scripts/forge-policy-record.mjs', 'scripts/forge-final-image-binding.mjs', 'scripts/forge-final-image-collector.mjs',
  'scripts/forge-remediation-proof-proposal.mjs', 'scripts/forge-source-topology.mjs',
  'scripts/forge-candidate-image-proof.mjs', 'scripts/forge-candidate-image-roots.mjs',
  'scripts/verify-forge-oci-artifact.py', 'scripts/forge-candidate-regression.cjs', 'scripts/forge-candidate-dangling-links.mjs',
  'patches/node-forge@1.4.0.patch', 'docs/security/forge-candidate/candidate-hashes.json',
]);
const sha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
export function checkFinalImageBinding(input) {
  const errors = [];
  const { execution, producer, artifact, receipt, archiveBytes, archiveArtifact, archiveVerification, manifestBytes, configBytes, published, phase, inspected, now } = input ?? {};
  const fail = message => errors.push(message);
  if (!exact(execution, ['event', 'head', 'repository', 'repositoryId']) || !commit(execution?.head)
    || !['merge_group', 'push', 'workflow_dispatch'].includes(execution.event)
    || execution.repository !== 'OxyHQ/oxy' || execution.repositoryId !== 973881060) fail('Exact authenticated execution context required');
  if (!producer || producer.run?.event !== 'merge_group' || producer.run?.head_sha !== execution?.head
    || producer.run?.repository?.full_name !== 'OxyHQ/oxy' || producer.run?.repository?.id !== 973881060
    || producer.run?.head_repository?.full_name !== 'OxyHQ/oxy'
    || producer.run?.path !== '.github/workflows/forge-queue-image-inspection.yml'
    || producer.job?.run_attempt !== producer.run?.run_attempt || producer.job?.run_id !== producer.run?.id || producer.job?.head_sha !== execution?.head
    || producer.job?.name !== 'inspection' || producer.job?.status !== 'completed' || producer.job?.conclusion !== 'success'
    || JSON.stringify(producer.job?.labels) !== JSON.stringify(['ubuntu-24.04-arm'])) fail('Successful exact-SHA ARM inspection job required; PR images and different main SHA are insufficient');
  if (!exact(producer?.executedBlobs?.source, FINAL_IMAGE_EXECUTED_PATHS) || !exact(producer?.executedBlobs?.current, FINAL_IMAGE_EXECUTED_PATHS)
    || Object.entries(producer.executedBlobs.source).some(([path, blob]) => !commit(blob) || blob !== producer.executedBlobs.current?.[path])) fail('Frozen image workflow and every scan executable must match producer blobs');
  // The producer may still be publishing. Inspection itself must have completed;
  // waiting for the whole workflow here would create Guards -> publisher -> Guards.
  if (!artifact || artifact.name !== `forge-queue-proof-${execution?.head}-${producer?.run?.id}-${producer?.run?.run_attempt}` || artifact.workflow_run?.id !== producer?.run?.id || artifact.workflow_run?.head_sha !== execution?.head
    || artifact.workflow_run?.repository_id !== 973881060 || artifact.expired !== false
    || !sha(artifact.digest) || artifact.digest !== `sha256:${sha256(input?.proofZipBytes ?? '')}`
    || artifact.size_in_bytes !== input?.proofZipBytes?.length
    || !(Date.parse(now) < Date.parse(artifact.expires_at))) fail('Authenticated exact-SHA proof ZIP and unexpired digest required');
  if (!exact(receipt, ['schemaVersion', 'sourceSha', 'runId', 'archiveSha256', 'manifestDigest', 'approval'])
    || receipt.schemaVersion !== 1 || receipt.approval !== false || receipt.sourceSha !== execution?.head
    || receipt.runId !== String(producer?.run?.id) || !/^[a-f0-9]{64}$/.test(receipt.archiveSha256 ?? '')
    || !sha(receipt.manifestDigest)) fail('Closed non-approval OCI receipt required');
  if (archiveBytes?.length) {
    if (sha256(archiveBytes) !== receipt?.archiveSha256) fail('Imported archive differs from the scanned OCI archive');
  } else {
    if (!archiveArtifact || archiveArtifact.workflow_run?.id !== producer?.run?.id
      || archiveArtifact.workflow_run?.head_sha !== execution?.head || archiveArtifact.workflow_run?.repository_id !== 973881060
      || archiveArtifact.name !== `forge-queue-oci-${execution?.head}-${producer?.run?.id}-${producer?.run?.run_attempt}`
      || archiveArtifact.expired !== false || !sha(archiveArtifact.digest) || !(archiveArtifact.size_in_bytes > 0)
      || !(Date.parse(now) < Date.parse(archiveArtifact.expires_at))) fail('Scanned OCI transport artifact missing or unauthenticated');
    if (!exact(archiveVerification, ['schemaVersion', 'artifactId', 'zipDigest', 'zipSizeBytes', 'archiveSha256', 'archiveSizeBytes'])
      || archiveVerification.schemaVersion !== 1 || archiveVerification.artifactId !== archiveArtifact?.id
      || archiveVerification.zipDigest !== archiveArtifact?.digest || archiveVerification.zipSizeBytes !== archiveArtifact?.size_in_bytes
      || archiveVerification.archiveSha256 !== receipt?.archiveSha256 || !(archiveVerification.archiveSizeBytes > 0)
      || archiveVerification.archiveSizeBytes > 8 * 1024 ** 3) fail('Actual streaming archive verification required; metadata or null cannot replace bytes');
  }
  if (!manifestBytes?.length || `sha256:${sha256(manifestBytes)}` !== receipt?.manifestDigest) fail('Manifest bytes differ from the scanned image digest');
  let manifest, config;
  try { manifest = JSON.parse(manifestBytes); config = JSON.parse(configBytes); } catch { fail('OCI manifest/config unreadable'); }
  if (!sha(manifest?.config?.digest) || `sha256:${sha256(configBytes ?? '')}` !== manifest.config.digest
    || config?.architecture !== 'arm64' || config?.os !== 'linux'
    || config?.config?.Labels?.['org.opencontainers.image.revision'] !== execution?.head) fail('Manifest config must bind ARM and the actual execution source SHA');
  if (!exact(inspected, ['dockerConfigId', 'mountProofImageId', 'rootScanImageId', 'regressionImageId'])
    || Object.values(inspected).some(id => id !== manifest?.config?.digest)) fail('OCI config and every Docker inspection/scan must identify the exact same image');
  if (!['prepublish', 'published'].includes(phase)) fail('Explicit image phase required');
  if (phase === 'prepublish' && published !== null) fail('Prepublish proof cannot claim registry publication');
  if (phase === 'published' && (!exact(published, ['repository', 'tag', 'digest', 'manifestBytes'])
    || published.repository !== 'oxy/oxy-api' || published.tag !== `mq-${execution?.head}`
    || published.digest !== receipt?.manifestDigest || `sha256:${sha256(published.manifestBytes ?? '')}` !== receipt?.manifestDigest)) fail('Registry must contain precisely the inspected digest and manifest; no rebuild or retag from a different SHA');
  return { structurallyEligible: errors.length === 0, authorized: false, errors,
    limitation: 'Synthetic/caller inputs are not authenticated. Only the fixed live collector can authenticate producer, artifact bytes and full Forge scan validation; explicit human policy remains separate.' };
}
