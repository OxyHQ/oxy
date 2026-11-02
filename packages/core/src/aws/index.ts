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
  // An explicitly selected profile is an authority boundary. defaultProvider
  // falls through a missing profile to ambient ECS/IMDS credentials, which may
  // name another application. fromIni resolves only the selected profile and
  // its declared source chain, or rejects; there is no ambient fallback.
  if (options.profile !== undefined && !options.profile.trim())
    throw new Error('An explicit AWS workload profile must not be empty');
  const ambient = options.profile === undefined ? defaultProvider(options) : undefined;
  const resolveProfile = async () =>
    (await import('@aws-sdk/credential-provider-ini')).fromIni(options);
  let selectedProfile: ReturnType<typeof resolveProfile> | undefined;
  return async () => {
    let provider = ambient;
    if (!provider) {
      selectedProfile ??= resolveProfile();
      provider = await selectedProfile;
    }
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
