import { PRIVATE_AUTO_EXECUTION_CONTRACT_VERSION } from '@oxy.so/contracts';
import { KaanaProtocolError, type KaanaDeploymentAttestation } from './kaanaClient';

/** Signed metadata is evidence, never approval. Caller must independently reread its source getter. */
export function validatePrivateAutoAttestation(
  attestation: KaanaDeploymentAttestation,
  requested: '3.7.0' | undefined,
): void {
  if (attestation.privateAutoExecutionContractVersion !== requested) {
    throw new KaanaProtocolError('Private Auto attestation negotiation mismatch.');
  }
  for (const row of attestation.deployments) {
    const approval = row.privateAutoSourceApproval;
    if (approval === undefined) continue;
    if (requested !== PRIVATE_AUTO_EXECUTION_CONTRACT_VERSION || row.scopedExecution !== undefined ||
      row.deploymentId !== approval.deploymentId || row.modelReference !== approval.modelReference ||
      row.provider !== approval.provider || row.keyId !== approval.keyId ||
      row.upstreamModelId !== approval.upstreamModelId ||
      row.providerRateCardVersionId !== approval.providerRateCardVersionId ||
      row.providerSourceVersion !== approval.providerSourceVersion ||
      new Set(row.regions).size !== row.regions.length || row.regions.length !== approval.regions.length ||
      row.regions.some((region) => !approval.regions.includes(region))) {
      throw new KaanaProtocolError('Private Auto descriptor identity mismatch.');
    }
  }
}
