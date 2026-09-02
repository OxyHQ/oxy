import {
  authorizedRouteSchema,
  kaanaCredentialHandleSchema,
  providerConnectionSchema,
  safeParseContract,
} from '../index';

const handle = `kcred_${'a'.repeat(26)}`;
const connection = {
  schemaVersion: 1 as const,
  connectionId: 'pcx_1',
  provider: 'openai',
  ownerAccountId: 'acc_1',
  scope: {
    kind: 'application' as const,
    accountId: 'acc_1',
    applicationId: 'app_1',
  },
  environment: 'production' as const,
  status: 'active' as const,
  custodyState: 'ready' as const,
  credentialHandle: handle,
  credentialRevision: 2,
  keyPrefix: 'sk-proj-4f',
  fingerprint: 'b'.repeat(64),
  validation: {
    state: 'valid' as const,
    lastValidatedAt: '2026-08-15T08:00:00.000Z',
  },
  upstreamBillsCustomerDirectly: true as const,
  createdAt: '2026-08-01T10:00:00.000Z',
};

describe('Kaana provider credential contracts', () => {
  it('accepts only opaque Kaana handles', () => {
    expect(kaanaCredentialHandleSchema.safeParse(handle).success).toBe(true);
    for (const invalid of [
      'vault:oxy/inference/byok/production/acc_1/pcx_1',
      'ssm:/customer/key',
      'sk-live-credential',
      `kcred_${'A'.repeat(26)}`,
    ]) {
      expect(kaanaCredentialHandleSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('parses an exact handle and revision without credential material', () => {
    expect(safeParseContract(providerConnectionSchema, connection)).toEqual(connection);
    for (const secretBearing of [
      { apiKey: 'secret' },
      { secret: 'secret' },
      { token: 'secret' },
      { secretRef: 'vault:anything' },
    ]) {
      expect(providerConnectionSchema.safeParse({ ...connection, ...secretBearing }).success).toBe(
        false,
      );
    }
  });

  it('requires handle and revision together for ready/revoked and neither for pending', () => {
    expect(
      providerConnectionSchema.safeParse({
        ...connection,
        custodyState: 'pending',
        credentialHandle: undefined,
        credentialRevision: undefined,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...connection, credentialHandle: undefined },
      { ...connection, credentialRevision: undefined },
      { ...connection, custodyState: 'pending' },
    ]) {
      expect(providerConnectionSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('carries the full exact identity on a customer-authorized route', () => {
    const route = {
      substitution: 'same_model',
      deploymentId: 'dep_1',
      modelReference: 'openai/gpt@2026-09-01',
      provider: 'openai',
      regions: ['us-west-2'],
      customerProviderCredential: {
        credentialHandle: handle,
        credentialRevision: 2,
        ownerAccountId: 'acc_1',
        connectionId: 'pcx_1',
        environment: 'production',
      },
    };
    expect(authorizedRouteSchema.safeParse(route).success).toBe(true);
    expect(
      authorizedRouteSchema.safeParse({
        ...route,
        customerProviderCredential: {
          ...route.customerProviderCredential,
          credentialRevision: 0,
        },
      }).success,
    ).toBe(false);
  });
});
