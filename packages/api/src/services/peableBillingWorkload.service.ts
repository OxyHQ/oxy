import { OxyServer } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';
import { peableForOxyService, type Peable, type PeableOxyHost } from '@peable.to/sdk';

export function assertPeableBillingWorkloadConfiguration(
  injectedAuthority = false,
): string | undefined {
  if (process.env.OXY_ONE_PEABLE_PUBLIC_KEY?.trim() || process.env.OXY_ONE_PEABLE_SECRET?.trim())
    throw new Error(
      'Peable billing uses workload identity; remove OXY_ONE_PEABLE_PUBLIC_KEY and OXY_ONE_PEABLE_SECRET',
    );
  const profile = process.env.OXY_PEABLE_BILLING_AWS_PROFILE?.trim();
  if (!profile && !injectedAuthority)
    throw new Error(
      'Peable billing requires OXY_PEABLE_BILLING_AWS_PROFILE; ambient workload identity is not billing authority',
    );
  return profile;
}

/** This profile must attest the reviewed billing application, never the ambient
 * oxy-api/Inbox application. The merchant readback below proves that binding.
 * Injected hosts remain owned by deployment composition, not this client. */
export function createPeableBillingClient(injectedOxy?: PeableOxyHost): {
  client: Peable;
  dispose(): void;
} {
  const profile = assertPeableBillingWorkloadConfiguration(!!injectedOxy);
  const ownedOxy = injectedOxy
    ? undefined
    : new OxyServer({
        baseURL: (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, ''),
        workloadCredentials: createAwsWorkloadCredentialProvider({ profile }),
      });
  const oxy = injectedOxy ?? ownedOxy;
  if (!oxy) throw new Error('Peable billing workload unavailable');
  try {
    const client = peableForOxyService({ oxy });
    let disposed = false;
    return {
      client,
      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          client.dispose();
        } finally {
          ownedOxy?.dispose();
        }
      },
    };
  } catch (error) {
    ownedOxy?.dispose();
    throw error;
  }
}

export async function assertPeableBillingMerchant(
  client: Peable,
  configuration: { merchantId: string; applicationId: string; namespace: { environment: string } },
): Promise<void> {
  const merchant = await client.merchants.retrieve();
  if (
    merchant.id !== configuration.merchantId ||
    merchant.oxy_app_id !== configuration.applicationId ||
    merchant.environment !== configuration.namespace.environment
  )
    throw new Error('Peable personal workload owner differs');
}
