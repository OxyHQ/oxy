import type { WorkloadServiceToken, WorkloadServiceTokenOptions } from './workloadIdentity';

/** Workload attestation belongs to a Node host, never a browser or device. */
export function canAttestWorkloadIdentity(): boolean {
  return false;
}

export async function requestWorkloadServiceToken(
  _options: WorkloadServiceTokenOptions,
): Promise<WorkloadServiceToken> {
  throw new Error('Workload identity is only available on a Node host');
}
