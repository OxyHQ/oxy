import {
  authorizedRouteSchema,
  kaanaCredentialMutationSchema,
  kaanaCredentialOutcomeRequestSchema,
  kaanaCredentialOutcomeSchema,
  kaanaCredentialHandleSchema,
  kaanaCredentialValidationOutcomeSchema,
  providerCredentialValidationOperationSchema,
  providerConnectionSchema,
  safeParseContract,
} from '../index';

const handle = `kcred_${'a'.repeat(26)}`;
const connection = {
  schemaVersion: 2 as const,
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

  it('binds mutations to one exact operation, identity, actor and action shape', () => {
    const create = {
      schemaVersion: 1,
      operationId: 'op_create_1',
      action: 'create',
      provider: 'openai',
      ownerAccountId: 'acc_1',
      connectionId: 'pcx_1',
      environment: 'production',
      operationActor: 'user:user_1',
      secretBase64: Buffer.from('customer-provider-key').toString('base64'),
    };
    expect(kaanaCredentialMutationSchema.safeParse(create).success).toBe(true);
    expect(
      kaanaCredentialMutationSchema.safeParse({ ...create, credentialHandle: handle }).success,
    ).toBe(false);
    expect(
      kaanaCredentialMutationSchema.safeParse({ ...create, ownerAccountId: 'acc/guessed' }).success,
    ).toBe(false);
    expect(kaanaCredentialMutationSchema.safeParse({ ...create, actor: {} }).success).toBe(false);

    for (const invalidSecret of [
      Buffer.from([0]),
      Buffer.from(' customer-provider-key '),
      Buffer.from('customer\tprovider'),
      Buffer.from('credencial-ñ'),
      Buffer.from('a'.repeat(4097)),
    ]) {
      expect(
        kaanaCredentialMutationSchema.safeParse({
          ...create,
          secretBase64: invalidSecret.toString('base64'),
        }).success,
      ).toBe(false);
    }
    expect(
      kaanaCredentialMutationSchema.safeParse({
        ...create,
        secretBase64: Buffer.from('a'.repeat(4096)).toString('base64'),
      }).success,
    ).toBe(true);
    expect(
      kaanaCredentialMutationSchema.safeParse({ ...create, secretBase64: 'YR==' }).success,
    ).toBe(false);
    expect(
      kaanaCredentialMutationSchema.safeParse({ ...create, secretBase64: 'YWJ=' }).success,
    ).toBe(false);
    expect(
      kaanaCredentialMutationSchema.safeParse({ ...create, secretBase64: 'YQ==' }).success,
    ).toBe(true);
    expect(
      kaanaCredentialMutationSchema.safeParse({ ...create, secretBase64: 'YWI=' }).success,
    ).toBe(true);
  });

  it('keeps outcome queries metadata-only and conflicts reference-free', () => {
    const request = {
      schemaVersion: 1,
      operationId: 'op_rotate_1',
      action: 'rotate',
      provider: 'openai',
      ownerAccountId: 'acc_1',
      connectionId: 'pcx_1',
      environment: 'production',
      credentialHandle: handle,
      expectedRevision: 2,
    };
    expect(kaanaCredentialOutcomeRequestSchema.safeParse(request).success).toBe(true);
    expect(
      kaanaCredentialOutcomeRequestSchema.safeParse({ ...request, secretBase64: 'c2VjcmV0' })
        .success,
    ).toBe(false);
    expect(
      kaanaCredentialOutcomeSchema.safeParse({
        schemaVersion: 1,
        operationId: 'op_rotate_1',
        action: 'rotate',
        status: 'conflict',
      }).success,
    ).toBe(true);
    expect(
      kaanaCredentialOutcomeSchema.safeParse({
        schemaVersion: 1,
        operationId: 'op_rotate_1',
        action: 'rotate',
        status: 'conflict',
        credentialHandle: handle,
        revision: 3,
      }).success,
    ).toBe(false);
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

  it.each(['unvalidated', 'expired'] as const)(
    'rejects an active connection whose current generation is %s',
    (state) => {
      expect(
        providerConnectionSchema.safeParse({
          ...connection,
          validation: { state },
        }).success,
      ).toBe(false);
    },
  );

  it('rejects secret-derived metadata additions', () => {
    expect(
      providerConnectionSchema.safeParse({ ...connection, fingerprint: 'b'.repeat(64) }).success,
    ).toBe(false);
    expect(
      providerConnectionSchema.safeParse({ ...connection, keyPrefix: 'sk-partial' }).success,
    ).toBe(false);
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

  it('separates exact internal bootstrap binding from the customer-safe operation', () => {
    const task = {
      schemaVersion: 1,
      operationId: 'operation_exact',
      applicationId: 'app_1',
      provider: 'openai',
      ownerAccountId: 'acc_1',
      connectionId: 'pcx_1',
      environment: 'production',
      credentialHandle: handle,
      credentialRevision: 2,
      deploymentId: 'kaana_deployment_exact',
    };
    expect(
      kaanaCredentialValidationOutcomeSchema.safeParse({
        ...task,
        state: 'inconclusive',
        failureCode: 'forbidden',
      }).success,
    ).toBe(true);
    expect(
      kaanaCredentialValidationOutcomeSchema.safeParse({
        ...task,
        state: 'invalid',
        failureCode: 'forbidden',
      }).success,
    ).toBe(false);
    expect(
      providerCredentialValidationOperationSchema.safeParse({
        schemaVersion: 1,
        operationId: task.operationId,
        applicationId: task.applicationId,
        connectionId: task.connectionId,
        deploymentId: 'oxy_catalogue_deployment_exact',
        state: 'inconclusive',
        failureCode: 'forbidden',
        createdAt: '2026-09-03T00:00:00.000Z',
        completedAt: '2026-09-03T00:00:01.000Z',
      }).success,
    ).toBe(true);
  });
});
