import { scopedExecutionAudienceSchema } from '@oxy.so/contracts';
import type { EdgeExecutionContext } from '../inferenceEdge.service';
import { bindScopedPermit, hashScopedInput, privateCommissioningAudience,
  scopedPermitForContext, sourceReviewedScopedAudience } from '../scopedExecution.service';
import audienceJson from '../../../../../docs/audits/2026-10-05-mention-native-second-source/audience.json';
import consumedOriginal from '../../../../../docs/audits/2026-10-05-mention-native-source-revalidation/audience.json';
import priorMentionAudience from '../../../../../docs/audits/2026-10-05-mention-native-source-activation/audience.json';
import retiredAudience from '../../../../../docs/audits/2026-10-04-jev-exact-activation/frozen-audience-2030.json';
import syntheticInput from '../../../../../docs/audits/2026-10-04-jev-exact-activation/fixture.json';

const audience = scopedExecutionAudienceSchema.parse(audienceJson);
const expires = Date.parse(audience.expiresAt);
const at = expires - 1000;
const context = {
  principal: { ownerAccountId: audience.principal.accountId,
    applicationId: audience.principal.applicationId, credentialId: audience.principal.credentialId,
    environment: 'production', scopes: ['inference:invoke'] },
  idempotencyKey: audience.idempotencyKey,
  request: { input: syntheticInput, stream: false, operation: { kind: 'decisions' },
    target: { kind: 'model', modelReference: audience.modelReference } },
} as EdgeExecutionContext;

afterEach(() => jest.useRealTimers());

it('compiles the exact own-Mention audience without renewing the retired Alia operation', () => {
  expect(sourceReviewedScopedAudience(at)).toEqual(audience);
  expect(privateCommissioningAudience(audience, at)).toEqual(audience);
  expect(privateCommissioningAudience(scopedExecutionAudienceSchema.parse(priorMentionAudience), at)).toBeUndefined();
  expect(privateCommissioningAudience(scopedExecutionAudienceSchema.parse(consumedOriginal), at)).toBeUndefined();
  expect(privateCommissioningAudience(scopedExecutionAudienceSchema.parse(retiredAudience), at)).toBeUndefined();
  expect(audience.principal.applicationId).toBe('6a2f851751b784a86fd0e916');
  expect(audience.idempotencyKey).toBe('mention_jev_native_en_d5c4e4815e9bfb2b998af67bb7677011');
  expect(audience.fixtureSha256).toBe('207a9c8fa2847e7263d6e8d525a951bca72d82bfb762aeb37cf546ca8762966a');
});

it('requires the actual selected input rather than substituting a synthetic or retired input', () => {
  jest.useFakeTimers().setSystemTime(at);
  expect(hashScopedInput(syntheticInput)).not.toBe(audience.fixtureSha256);
  expect(scopedPermitForContext(context)).toBeUndefined();
  expect(bindScopedPermit(undefined, context, at)).toBeUndefined();
  // Isolate principal/key checks with a synthetic permit; this is never compiled approval.
  const syntheticPermit = { ...audience, fixtureSha256: hashScopedInput(syntheticInput) };
  expect(bindScopedPermit(syntheticPermit, context, at)).toEqual(syntheticPermit);
  for (const changed of [
    { ...context, principal: { ...context.principal, applicationId: retiredAudience.principal.applicationId } },
    { ...context, principal: { ...context.principal, ownerAccountId: 'foreign' } },
    { ...context, principal: { ...context.principal, credentialId: 'foreign' } },
    { ...context, principal: { ...context.principal, scopes: [] } },
    { ...context, idempotencyKey: 'new-operation' },
    { ...context, request: { ...context.request, stream: true } },
  ]) expect(bindScopedPermit(syntheticPermit, changed as EdgeExecutionContext, at)).toBeUndefined();
  for (const changed of [
    { ...audience, keyId: 'foreign' }, { ...audience, priceVersionId: 'foreign' },
    { ...audience, policy: { ...audience.policy, policyVersion: 2 } },
    { ...audience, expiresAt: '2099-01-01T00:00:00.000Z' },
  ]) expect(privateCommissioningAudience(changed, at)).toBeUndefined();
});

it('closes exactly at frozen expiry, rejects invalid clocks and isolates caller mutations', () => {
  expect(sourceReviewedScopedAudience(expires - 1)).toEqual(audience);
  for (const now of [expires, expires + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(sourceReviewedScopedAudience(now)).toBeUndefined();
    expect(bindScopedPermit(audience, context, now)).toBeUndefined();
  }
  const changed = sourceReviewedScopedAudience(at)!;
  changed.principal.applicationId = 'foreign';
  expect(sourceReviewedScopedAudience(at)).toEqual(audience);
  jest.useFakeTimers().setSystemTime(expires);
  expect(scopedPermitForContext(context)).toBeUndefined();
});
