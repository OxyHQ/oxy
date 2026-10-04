import { scopedExecutionAudienceSchema } from '@oxy.so/contracts';
import type { EdgeExecutionContext } from '../inferenceEdge.service';
import { bindScopedPermit, hashScopedInput, privateCommissioningAudience,
  scopedPermitForContext, sourceReviewedScopedAudience } from '../scopedExecution.service';
import audienceJson from '../../../../../docs/audits/2026-10-04-jev-exact-activation/frozen-audience-2030.json';
import input from '../../../../../docs/audits/2026-10-04-jev-exact-activation/fixture.json';

const audience = scopedExecutionAudienceSchema.parse(audienceJson);
const at = Date.parse('2026-10-04T20:30:00.000Z');
const expires = Date.parse(audience.expiresAt);
const context = {
  principal: { ownerAccountId: audience.principal.accountId,
    applicationId: audience.principal.applicationId, credentialId: audience.principal.credentialId,
    environment: 'production', scopes: ['inference:invoke'] },
  idempotencyKey: audience.idempotencyKey,
  request: { input, stream: false, operation: { kind: 'decisions' },
    target: { kind: 'model', modelReference: audience.modelReference } },
} as EdgeExecutionContext;

afterEach(() => jest.useRealTimers());

it('compiles the exact root-reviewed Alia source and v2 Noul/Choice/Score input, with no absent-source fallback', () => {
  expect(hashScopedInput(input)).toBe(audience.fixtureSha256);
  expect(sourceReviewedScopedAudience(at)).toEqual(audience);
  expect(bindScopedPermit(undefined, context, at)).toBeUndefined();
  jest.useFakeTimers().setSystemTime(at);
  expect(scopedPermitForContext(context)).toEqual(audience);
  expect(privateCommissioningAudience(audience, at)).toEqual(audience);
});

it('denies Mention, another credential/key/input and every unapproved operation before granting a permit', () => {
  jest.useFakeTimers().setSystemTime(at);
  for (const changed of [
    { ...context, principal: { ...context.principal, applicationId: 'foreign-Mention' } },
    { ...context, principal: { ...context.principal, credentialId: 'foreign' } },
    { ...context, principal: { ...context.principal, scopes: [] } },
    { ...context, idempotencyKey: 'retry-with-new-key' },
    { ...context, request: { ...context.request, stream: true } },
    { ...context, request: { ...context.request, input: { ...input, decisions: { ...input.decisions, state: 'changed' } } } },
  ]) expect(scopedPermitForContext(changed as EdgeExecutionContext)).toBeUndefined();
  for (const changed of [
    { ...audience, keyId: 'foreign' }, { ...audience, priceVersionId: 'foreign' },
    { ...audience, policy: { ...audience.policy, policyVersion: 2 } },
    { ...audience, expiresAt: '2099-01-01T00:00:00.000Z' },
  ]) expect(privateCommissioningAudience(changed, at)).toBeUndefined();
});

it('closes exactly at source expiry, refuses invalid clocks and never extends consumed approval', () => {
  expect(sourceReviewedScopedAudience(expires - 1)).toEqual(audience);
  for (const now of [expires, expires + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(sourceReviewedScopedAudience(now)).toBeUndefined();
    expect(bindScopedPermit(audience, context, now)).toBeUndefined();
  }
  jest.useFakeTimers().setSystemTime(expires);
  expect(scopedPermitForContext(context)).toBeUndefined();
  expect(sourceReviewedScopedAudience(at)).toEqual(audience);
});
