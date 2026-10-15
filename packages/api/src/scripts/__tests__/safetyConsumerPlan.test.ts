import { safetyConsumerPlan, type SafetyConsumerObservation } from '../safetyConsumerPlan';
import { SAFETY_CONSUMERS, safetyWorkloadSubject } from '../../config/safetyConsumers';
function fixture(): SafetyConsumerObservation {
  const t = SAFETY_CONSUMERS.allo;
  return {
    owner: {
      id: t.ownerAccountId,
      status: 'active',
      kind: 'personal',
      reputation: 'standard',
      supervised: false,
    },
    application: {
      id: t.applicationId,
      ownerAccountId: t.ownerAccountId,
      type: t.type,
      status: 'active',
      scopes: ['user:read'],
      capabilities: ['existing:grant'],
    },
    workloads: t.roles.map((role) => ({
      id: role,
      applicationId: t.applicationId,
      provider: 'aws-iam',
      subject: safetyWorkloadSubject(role),
      scopes: [],
      expiresAt: null,
    })),
  };
}
it('preserves effective inherited scope when materializing an empty binding without enabling Kids', () => {
  const { plan } = safetyConsumerPlan('allo', 'base', [], fixture());
  expect(plan.after.workloads[0].scopes).toEqual(['safety:decide', 'user:read']);
  expect(plan.after.application.capabilities).toEqual(['existing:grant']);
  expect(safetyConsumerPlan('allo', 'base', [], plan.after).plan.after).toEqual(plan.after);
});
it('requires an independently reviewed permitted action after base provisioning and preserves unrelated grants', () => {
  expect(() => safetyConsumerPlan('allo', 'capability', ['messaging'], fixture())).toThrow(
    'base scope',
  );
  const base = safetyConsumerPlan('allo', 'base', [], fixture()).plan.after;
  expect(() => safetyConsumerPlan('allo', 'capability', ['purchases'], base)).toThrow('candidate');
  const grant = safetyConsumerPlan('allo', 'capability', ['messaging'], base);
  expect(grant.plan.after.application.capabilities).toEqual([
    'existing:grant',
    'safety:messaging:v1',
  ]);
  expect(grant.plan.after.workloads).toEqual(base.workloads);
  expect(
    safetyConsumerPlan('allo', 'capability', ['messaging'], grant.plan.after).plan.after,
  ).toEqual(grant.plan.after);
});
it('refuses wrong live authority and hashes every observed grant', () => {
  const original = fixture();
  expect(() => safetyConsumerPlan('allo', 'base', [], { ...original, workloads: [] })).toThrow(
    'binding',
  );
  expect(() =>
    safetyConsumerPlan('allo', 'base', [], {
      ...original,
      application: { ...original.application, ownerAccountId: 'other' },
    }),
  ).toThrow('identity');
  const changed = {
    ...original,
    application: { ...original.application, scopes: ['user:read', 'files:read'] },
  };
  expect(safetyConsumerPlan('allo', 'base', [], original).planSha256).not.toEqual(
    safetyConsumerPlan('allo', 'base', [], changed).planSha256,
  );
  expect(() => safetyConsumerPlan('allo', 'base', ['messaging'], original)).toThrow('never grants');
});

it('refuses unavailable or supervised owners even when workload grants still exist', () => {
  const before = fixture();
  for (const owner of [
    { ...before.owner, status: 'archived' },
    { ...before.owner, supervised: true },
    { ...before.owner, reputation: 'restricted' },
  ])
    expect(() => safetyConsumerPlan('allo', 'base', [], { ...before, owner })).toThrow('identity');
});
