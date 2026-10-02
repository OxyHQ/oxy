/** Preparation only: structural contract for the unapplied image DAG. No audit authority. */
import { sha256 } from './forge-remediation-proof-proposal.mjs';
const sha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
export function checkFinalImageBinding(input) {
  const errors = [];
  const { execution, producer, artifact, receipt, archiveBytes, manifestBytes, configBytes, published, phase, inspected, now } = input ?? {};
  const fail = message => errors.push(message);
  if (!exact(execution, ['event', 'head', 'repository', 'repositoryId']) || !commit(execution?.head)
    || !['merge_group', 'push', 'workflow_dispatch'].includes(execution.event)
    || execution.repository !== 'OxyHQ/oxy' || execution.repositoryId !== 973881060) fail('Exact authenticated execution context required');
  if (!producer || producer.run?.event !== 'merge_group' || producer.run?.head_sha !== execution?.head
    || producer.run?.repository?.full_name !== 'OxyHQ/oxy' || producer.run?.repository?.id !== 973881060
    || producer.run?.head_repository?.full_name !== 'OxyHQ/oxy'
    || producer.run?.path !== '.github/workflows/forge-queue-image-inspection.yml'
    || producer.job?.run_id !== producer.run?.id || producer.job?.head_sha !== execution?.head
    || producer.job?.name !== 'inspection' || producer.job?.status !== 'completed' || producer.job?.conclusion !== 'success'
    || JSON.stringify(producer.job?.labels) !== JSON.stringify(['ubuntu-24.04-arm'])) fail('Successful exact-SHA ARM inspection job required; PR images and different main SHA are insufficient');
  if (!plain(producer?.executedBlobs?.source) || Object.keys(producer.executedBlobs.source).length === 0
    || Object.entries(producer.executedBlobs.source).some(([path, blob]) => !commit(blob) || blob !== producer.executedBlobs.current?.[path])) fail('Frozen image workflow and every scan executable must match producer blobs');
  // The producer may still be publishing. Inspection itself must have completed;
  // waiting for the whole workflow here would create Guards -> publisher -> Guards.
  if (!artifact || artifact.workflow_run?.id !== producer?.run?.id || artifact.workflow_run?.head_sha !== execution?.head
    || artifact.workflow_run?.repository_id !== 973881060 || artifact.expired !== false
    || !sha(artifact.digest) || artifact.digest !== `sha256:${sha256(input?.proofZipBytes ?? '')}`
    || artifact.size_in_bytes !== input?.proofZipBytes?.length
    || !(Date.parse(now) < Date.parse(artifact.expires_at))) fail('Authenticated exact-SHA proof ZIP and unexpired digest required');
  if (!exact(receipt, ['schemaVersion', 'sourceSha', 'runId', 'archiveSha256', 'manifestDigest', 'approval'])
    || receipt.schemaVersion !== 1 || receipt.approval !== false || receipt.sourceSha !== execution?.head
    || receipt.runId !== String(producer?.run?.id) || !/^[a-f0-9]{64}$/.test(receipt.archiveSha256 ?? '')
    || !sha(receipt.manifestDigest)) fail('Closed non-approval OCI receipt required');
  if (!archiveBytes?.length || sha256(archiveBytes) !== receipt?.archiveSha256) fail('Imported archive differs from the scanned OCI archive');
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
    limitation: 'Synthetic/caller inputs are not authenticated. Live producer/artifact collection and full Forge scan validation remain required companion implementations.' };
}
