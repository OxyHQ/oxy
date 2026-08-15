import {
  providerConnectionSchema,
  providerSecretReferenceSchema,
  safeParseContract,
} from '../index';

const connection = {
  schemaVersion: 1 as const,
  connectionId: 'pcx_1',
  provider: 'openai',
  ownerAccountId: 'acc_1',
  scope: { kind: 'application' as const, accountId: 'acc_1', applicationId: 'app_1' },
  environment: 'production' as const,
  status: 'active' as const,
  secretRef: 'vault:oxy/byok/acc_1/openai/pcx_1',
  keyPrefix: 'sk-proj-4f',
  fingerprint: 'b'.repeat(64),
  validation: { state: 'valid' as const, lastValidatedAt: '2026-08-15T08:00:00.000Z' },
  upstreamBillsCustomerDirectly: true as const,
  createdAt: '2026-08-01T10:00:00.000Z',
};

describe('providerConnectionSchema', () => {
  it('parses a validated, active connection', () => {
    expect(safeParseContract(providerConnectionSchema, connection)).toEqual(connection);
  });

  it('cannot carry credential material under any field name', () => {
    for (const secretBearing of [
      { apiKey: 'sk-live-4f9c2a7b1e6d8f3a5c0b' },
      { secret: 'sk-live-4f9c2a7b1e6d8f3a5c0b' },
      { token: 'sk-live-4f9c2a7b1e6d8f3a5c0b' },
      { privateKey: '-----BEGIN PRIVATE KEY-----' },
      { headers: { Authorization: 'Bearer sk-live-4f9c2a7b1e6d8f3a5c0b' } },
      { credentials: { apiKey: 'sk-live-4f9c2a7b1e6d8f3a5c0b' } },
    ]) {
      expect(providerConnectionSchema.safeParse({ ...connection, ...secretBearing }).success).toBe(
        false,
      );
    }
  });

  it('caps the recognisable prefix below any usable credential length', () => {
    expect(
      providerConnectionSchema.safeParse({ ...connection, keyPrefix: 'sk-proj-4f9c' }).success,
    ).toBe(true);
    expect(
      providerConnectionSchema.safeParse({
        ...connection,
        keyPrefix: 'sk-live-4f9c2a7b1e6d8f3a5c0b',
      }).success,
    ).toBe(false);
  });

  it('takes a store locator, not a key, as the secret reference', () => {
    for (const reference of [
      'vault:oxy/byok/acc_1/openai/pcx_1',
      'kms:alias/oxy-byok/pcx_1',
      'ssm:/oxy/byok/acc_1/openai',
      'secretsmanager:oxy/byok/pcx_1',
    ]) {
      expect(providerSecretReferenceSchema.safeParse(reference).success).toBe(true);
    }

    for (const notAReference of [
      'sk-live-4f9c2a7b1e6d8f3a5c0b',
      'Bearer sk-live-4f9c2a7b1e6d8f3a5c0b',
      'https://example.test/secret',
      'vault: oxy/byok',
    ]) {
      expect(providerSecretReferenceSchema.safeParse(notAReference).success).toBe(false);
    }
  });

  it('validates the fingerprint as a full sha256 hex digest', () => {
    expect(providerConnectionSchema.safeParse({ ...connection, fingerprint: 'abc' }).success).toBe(
      false,
    );
    expect(
      providerConnectionSchema.safeParse({ ...connection, fingerprint: 'B'.repeat(64) }).success,
    ).toBe(false);
  });

  it('cannot leave a rejected credential routing live traffic', () => {
    expect(
      providerConnectionSchema.safeParse({
        ...connection,
        validation: { state: 'invalid', failureCode: 'unauthorized' },
      }).success,
    ).toBe(false);

    expect(
      providerConnectionSchema.safeParse({
        ...connection,
        status: 'disabled',
        validation: { state: 'invalid', failureCode: 'unauthorized' },
      }).success,
    ).toBe(true);
  });

  it('requires a reason when a credential check failed', () => {
    expect(
      providerConnectionSchema.safeParse({
        ...connection,
        status: 'disabled',
        validation: { state: 'invalid' },
      }).success,
    ).toBe(false);
  });

  it('records the connection as account-wide, project-wide or application-only', () => {
    for (const scope of [
      { kind: 'account', accountId: 'acc_1' },
      { kind: 'project', accountId: 'acc_project_1' },
      { kind: 'application', accountId: 'acc_1', applicationId: 'app_1' },
    ]) {
      expect(providerConnectionSchema.safeParse({ ...connection, scope }).success).toBe(true);
    }

    expect(
      providerConnectionSchema.safeParse({
        ...connection,
        scope: { kind: 'application', accountId: 'acc_1' },
      }).success,
    ).toBe(false);
  });

  it('states that the upstream bills the customer directly', () => {
    // BYOK does not move the billing relationship; Oxy charges its platform fee
    // only. A record cannot claim otherwise.
    expect(
      providerConnectionSchema.safeParse({ ...connection, upstreamBillsCustomerDirectly: false })
        .success,
    ).toBe(false);
  });
});
