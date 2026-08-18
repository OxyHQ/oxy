import {
  providerConnectionSchema,
  providerSecretReferenceSchema,
  safeParseContract,
} from '../index';

/**
 * A credential the length and shape of a real one, for the splicing cases below.
 *
 * COMPOSED rather than written out: `scripts/check-secret-scan.mjs` refuses any
 * `sk-` literal of 40 characters or more anywhere in the tree, and that floor is
 * what separates an issued key from a fixture without a name filter. A fixture
 * spelled in full would have to be excused by an allow-list entry, which erodes
 * the floor for every real key after it.
 */
const CREDENTIAL = `sk-ant-api03-${'9f2Ab_cD3e'.repeat(6)}AA`;

const connection = {
  schemaVersion: 1 as const,
  connectionId: 'pcx_1',
  provider: 'openai',
  ownerAccountId: 'acc_1',
  scope: { kind: 'application' as const, accountId: 'acc_1', applicationId: 'app_1' },
  environment: 'production' as const,
  status: 'active' as const,
  secretRef: 'vault:oxy/inference/byok/production/acc_1/pcx_1',
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
      'vault:oxy/inference/byok/production/acc_1/pcx_1',
      'kms:oxy/inference/byok/staging/acc_1/pcx_1',
      'ssm:oxy/inference/byok/development/acc_1/pcx_1',
      'secretsmanager:oxy/inference/byok/production/acc_1/pcx_1',
    ]) {
      expect(providerSecretReferenceSchema.safeParse(reference).success).toBe(true);
    }

    for (const notAReference of [
      'sk-live-4f9c2a7b1e6d8f3a5c0b',
      'Bearer sk-live-4f9c2a7b1e6d8f3a5c0b',
      'https://example.test/secret',
      'vault: oxy/byok',
      // Right namespace, wrong store.
      's3:oxy/inference/byok/production/acc_1/pcx_1',
      // Right store, a namespace no Oxy policy is scoped to.
      'vault:oxy/byok/acc_1/pcx_1',
      // An environment outside the closed set.
      'vault:oxy/inference/byok/prod/acc_1/pcx_1',
      // One segment too few, and one too many.
      'vault:oxy/inference/byok/production/acc_1',
      'vault:oxy/inference/byok/production/acc_1/pcx_1/extra',
    ]) {
      expect(providerSecretReferenceSchema.safeParse(notAReference).success).toBe(false);
    }
  });

  /**
   * THE CASE THIS GRAMMAR EXISTS FOR.
   *
   * The previous grammar was `<store>:<anything from a wide charset>`, and its
   * comment claimed a producer could not pass a raw key through the field and
   * have it look like a reference. Measured, it could: splicing the credential in
   * after the store name left a string that matched, and one that still ENDED
   * with `/<environment>/<account>/<connection>`, so `packages/api`'s partition
   * CHECK passed as well and the row was written.
   *
   * Both halves are asserted — that the spliced value still satisfies the
   * partition rule, and that it is nonetheless refused. Without the first, this
   * case would pass against a grammar that merely rejected some arbitrary string,
   * which is not what went wrong.
   */
  it('refuses a credential spliced into an otherwise well-formed reference', () => {
    const spliced = `vault:${CREDENTIAL}/oxy/inference/byok/production/acc_1/pcx_1`;

    expect(spliced.endsWith('/production/acc_1/pcx_1')).toBe(true);
    expect(providerSecretReferenceSchema.safeParse(spliced).success).toBe(false);
    expect(providerConnectionSchema.safeParse({ ...connection, secretRef: spliced }).success).toBe(
      false,
    );
  });

  /**
   * The one span the grammar alone cannot judge: a credential occupying an id
   * segment is still a well-formed reference to SOME connection. What refuses it
   * is that the reference must name THIS one — the contract's half of the rule
   * `inference_provider_connections_secret_ref_partition` keeps on the row.
   */
  it('requires the reference to name this connection, not merely to be well-formed', () => {
    const asAccount = `vault:oxy/inference/byok/production/${CREDENTIAL.slice(0, 64)}/pcx_1`;
    const asConnection = `vault:oxy/inference/byok/production/acc_1/${CREDENTIAL}`;

    // Well-formed on their own: the grammar has nothing left to object to.
    expect(providerSecretReferenceSchema.safeParse(asAccount).success).toBe(true);
    expect(providerSecretReferenceSchema.safeParse(asConnection).success).toBe(true);

    for (const secretRef of [asAccount, asConnection]) {
      const result = providerConnectionSchema.safeParse({ ...connection, secretRef });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('secretRef');
      }
    }

    // …and the same fields with the RIGHT reference parse, so the refusals above
    // are about the reference and not about a fixture the contract never accepted.
    expect(providerConnectionSchema.safeParse(connection).success).toBe(true);
  });

  it('refuses a reference to another account, another environment or another connection', () => {
    for (const secretRef of [
      'vault:oxy/inference/byok/production/acc_2/pcx_1',
      'vault:oxy/inference/byok/staging/acc_1/pcx_1',
      'vault:oxy/inference/byok/production/acc_1/pcx_2',
    ]) {
      expect(providerConnectionSchema.safeParse({ ...connection, secretRef }).success).toBe(false);
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
