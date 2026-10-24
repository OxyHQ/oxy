/** Optional AWS SDK integration. Never re-export this module from another entrypoint. */
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import type { WorkloadCredentialProvider } from '../server/workloadIdentity';

/**
 * Resolve SSO/assume-role credentials using AWS's standard server credential chain.
 * The platform's workload binding decides the application and environment.
 * Long-lived IAM user access keys are deliberately not a local service identity.
 */
export function createAwsWorkloadCredentialProvider(
  options: { profile?: string } = {},
): WorkloadCredentialProvider {
  const provider = defaultProvider(options);
  return async () => {
    const credentials = await provider();
    if (
      !credentials.sessionToken ||
      !credentials.expiration ||
      credentials.expiration.getTime() <= Date.now()
    )
      throw new Error('An Oxy workload requires temporary AWS role credentials');
    return {
      AccessKeyId: credentials.accessKeyId,
      SecretAccessKey: credentials.secretAccessKey,
      Token: credentials.sessionToken,
    };
  };
}
