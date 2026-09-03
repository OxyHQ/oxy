import {
  providerCredentialBody,
  providerConnectionReconcileBody,
  providerConnectionRotateBody,
  providerConnectionValidationBody,
  providerCredentialValidationBootstrapBody,
  providerCredentialValidationOutcomeBody,
} from '../inferenceProviderConnection.schemas';

describe('provider credential transport boundary', () => {
  const create = {
    provider: 'openai',
    environment: 'production' as const,
    secret: 'customer-provider-key_123',
  };

  it('accepts an opaque visible-ASCII provider key for create and rotate', () => {
    expect(providerCredentialBody.safeParse(create).success).toBe(true);
    expect(
      providerConnectionRotateBody.safeParse({ secret: create.secret }).success,
    ).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
  ])('refuses a %s credential on create and rotate', (_label, secret) => {
    const createBody = { ...create } as Record<string, unknown>;
    const rotateBody: Record<string, unknown> = {};
    if (secret !== undefined) {
      createBody.secret = secret;
      rotateBody.secret = secret;
    } else {
      delete createBody.secret;
    }
    expect(providerCredentialBody.safeParse(createBody).success).toBe(false);
    expect(providerConnectionRotateBody.safeParse(rotateBody).success).toBe(false);
  });

  it.each([
    ['one byte', '!'],
    ['4096 bytes', 'a'.repeat(4096)],
  ])('accepts the %s boundary on create, rotate and reconcile', (_label, secret) => {
    expect(providerCredentialBody.safeParse({ ...create, secret }).success).toBe(true);
    expect(providerConnectionRotateBody.safeParse({ secret }).success).toBe(true);
    expect(providerConnectionReconcileBody.safeParse({ secret }).success).toBe(true);
  });

  it('refuses 4097 bytes on create, rotate and reconcile', () => {
    const secret = 'a'.repeat(4097);
    expect(providerCredentialBody.safeParse({ ...create, secret }).success).toBe(false);
    expect(providerConnectionRotateBody.safeParse({ secret }).success).toBe(false);
    expect(providerConnectionReconcileBody.safeParse({ secret }).success).toBe(false);
  });

  it('keeps reconcile optional for revoke, but refuses null and empty credentials', () => {
    expect(providerConnectionReconcileBody.safeParse({}).success).toBe(true);
    expect(providerConnectionReconcileBody.safeParse({ secret: null }).success).toBe(false);
    expect(providerConnectionReconcileBody.safeParse({ secret: '' }).success).toBe(false);
  });

  it('refuses extra fields on every credential-bearing request shape', () => {
    expect(providerCredentialBody.safeParse({ ...create, extra: true }).success).toBe(false);
    expect(
      providerConnectionRotateBody.safeParse({ secret: create.secret, extra: true }).success,
    ).toBe(false);
    expect(
      providerConnectionReconcileBody.safeParse({ secret: create.secret, extra: true }).success,
    ).toBe(false);
  });

  it('requires exact bootstrap IDs and treats billing as inconclusive, never invalid', () => {
    expect(
      providerCredentialValidationBootstrapBody.safeParse({
        applicationId: 'app_exact',
        deploymentId: 'deployment_exact',
      }).success,
    ).toBe(true);
    expect(
      providerConnectionValidationBody.safeParse({
        credentialHandle: `kcred_${'a'.repeat(26)}`,
        credentialRevision: 1,
        state: 'invalid',
        failureCode: 'forbidden',
      }).success,
    ).toBe(false);
    expect(
      providerCredentialValidationOutcomeBody.safeParse({
        schemaVersion: 1,
        operationId: 'operation_exact',
        applicationId: 'app_exact',
        provider: 'openai',
        ownerAccountId: 'account_exact',
        connectionId: 'connection_exact',
        environment: 'production',
        credentialHandle: `kcred_${'a'.repeat(26)}`,
        credentialRevision: 1,
        deploymentId: 'kaana_deployment_exact',
        state: 'inconclusive',
        failureCode: 'forbidden',
      }).success,
    ).toBe(true);
  });

  for (const [name, secret] of [
    ['NUL control byte', 'valid\0tail'],
    ['newline', 'valid\ntail'],
    ['tab', 'valid\ttail'],
    ['surrounding whitespace', ' customer-provider-key '],
    ['non-ASCII', 'credencial-ñ'],
  ] as const) {
    it(`refuses ${name} before Kaana custody`, () => {
      expect(
        providerCredentialBody.safeParse({ ...create, secret }).success,
      ).toBe(false);
      expect(providerConnectionRotateBody.safeParse({ secret }).success).toBe(
        false,
      );
    });
  }
});
