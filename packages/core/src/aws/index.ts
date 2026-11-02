/** Optional AWS SDK integration. Never re-export this module from another entrypoint. */
import { fromIni } from '@aws-sdk/credential-provider-ini';
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
  // An explicitly selected profile is an authority boundary. defaultProvider
  // falls through a missing profile to ambient ECS/IMDS credentials, which may
  // name another application. fromIni resolves only the selected profile and
  // its declared source chain, or rejects; there is no ambient fallback.
  if (options.profile !== undefined && !options.profile.trim())
    throw new Error('An explicit AWS workload profile must not be empty');
  const provider = options.profile !== undefined ? fromIni(options) : defaultProvider(options);
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
