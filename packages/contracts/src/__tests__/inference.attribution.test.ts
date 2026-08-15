import {
  authenticatedPrincipalSchema,
  billingPrincipalSchema,
  INFERENCE_SCOPES,
  inferenceAttributionSchema,
  inferenceScopeSchema,
  safeParseContract,
} from '../index';

const principal = {
  billing: { accountId: 'acc_1' },
  applicationId: 'app_1',
  credentialId: 'cred_1',
  environment: 'production' as const,
  inferenceScopes: ['inference:invoke'],
};

const attribution = {
  principal,
  userId: 'usr_1',
  requestId: 'req_1',
  generationId: 'gen_1',
};

describe('billingPrincipalSchema', () => {
  it('carries exactly the account that pays', () => {
    expect(Object.keys(billingPrincipalSchema.shape)).toEqual(['accountId']);
    expect(safeParseContract(billingPrincipalSchema, { accountId: 'acc_1' })).toEqual({
      accountId: 'acc_1',
    });
  });

  it('rejects a delegated user id smuggled into the billing block', () => {
    // ADR 0007: the delegated end user is never the billing identity. Strict
    // rather than stripping, because a stripped field still exists upstream of
    // the parse — in the caller that set it, and in whatever it logs.
    expect(
      billingPrincipalSchema.safeParse({ accountId: 'acc_1', userId: 'usr_1' }).success,
    ).toBe(false);
  });

  it('rejects an empty account id', () => {
    expect(billingPrincipalSchema.safeParse({ accountId: '' }).success).toBe(false);
  });
});

describe('authenticatedPrincipalSchema', () => {
  it('parses the envelope a verified credential resolves to', () => {
    expect(authenticatedPrincipalSchema.safeParse(principal).success).toBe(true);
  });

  it('requires the environment the credential was issued into', () => {
    const { environment, ...withoutEnvironment } = principal;
    expect(environment).toBe('production');
    expect(authenticatedPrincipalSchema.safeParse(withoutEnvironment).success).toBe(false);
  });

  it('rejects an environment outside the closed set', () => {
    expect(
      authenticatedPrincipalSchema.safeParse({ ...principal, environment: 'sandbox' }).success,
    ).toBe(false);
  });

  it('accepts every inference scope and refuses anything else', () => {
    for (const scope of INFERENCE_SCOPES) {
      expect(inferenceScopeSchema.safeParse(scope).success).toBe(true);
    }
    expect(inferenceScopeSchema.safeParse('inference:admin').success).toBe(false);
    // A credential's non-inference scopes are the control plane's business and
    // do not cross the boundary.
    expect(inferenceScopeSchema.safeParse('users:read').success).toBe(false);
  });
});

describe('inferenceAttributionSchema', () => {
  it('parses a fully attributed request', () => {
    expect(safeParseContract(inferenceAttributionSchema, attribution)).toEqual(attribution);
  });

  it('treats the delegated user as optional and the request id as not', () => {
    const { userId, ...withoutUser } = attribution;
    expect(userId).toBe('usr_1');
    expect(inferenceAttributionSchema.safeParse(withoutUser).success).toBe(true);

    const { requestId, ...withoutRequestId } = attribution;
    expect(requestId).toBe('req_1');
    expect(inferenceAttributionSchema.safeParse(withoutRequestId).success).toBe(false);
  });

  it('keeps the delegated user outside the billing block', () => {
    const parsed = inferenceAttributionSchema.parse(attribution);
    expect(Object.keys(parsed.principal.billing)).toEqual(['accountId']);
    expect(parsed.userId).toBe('usr_1');
  });

  it('rejects a request with no application or credential behind it', () => {
    const { applicationId, ...noApplication } = principal;
    expect(applicationId).toBe('app_1');
    expect(
      inferenceAttributionSchema.safeParse({ ...attribution, principal: noApplication }).success,
    ).toBe(false);

    const { credentialId, ...noCredential } = principal;
    expect(credentialId).toBe('cred_1');
    expect(
      inferenceAttributionSchema.safeParse({ ...attribution, principal: noCredential }).success,
    ).toBe(false);
  });
});
