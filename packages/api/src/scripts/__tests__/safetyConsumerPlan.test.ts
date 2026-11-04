import { safetyConsumerPlan, type SafetyConsumerObservation } from '../safetyConsumerPlan';
import { SAFETY_CONSUMERS, safetyWorkloadSubject } from '../../config/safetyConsumers';
function fixture(): SafetyConsumerObservation {
  const t = SAFETY_CONSUMERS.allo;
  return {
    owner: {
      id: t.ownerAccountId,
      status: 'active',
      kind: t.ownerKind,
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
      environment: 'production',
      expiresAt: null,
    })),
  };
}
it('verifies workload identity without changing external scopes or enabling Kids', () => {
  const { plan } = safetyConsumerPlan('allo', 'base', [], fixture());
  expect(plan.after.workloads).toEqual(fixture().workloads);
  expect(plan.after.application.scopes).toEqual(fixture().application.scopes);
  expect(plan.after.workloads[0]).not.toHaveProperty('scopes');
  expect(plan.after.application.capabilities).toEqual(['existing:grant']);
  expect(safetyConsumerPlan('allo', 'base', [], plan.after).plan.after).toEqual(plan.after);
});
it('requires an independently reviewed permitted action after base provisioning and preserves unrelated grants', () => {
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
    { ...before.owner, kind: 'project' },
  ])
    expect(() => safetyConsumerPlan('allo', 'base', [], { ...before, owner })).toThrow('identity');
});

it('limits Clarity candidates to reviewed Experience privacy and unrated-content gates', () => {
  expect(SAFETY_CONSUMERS.clarity.candidateActions).toEqual(['profile', 'content']);
  const target = SAFETY_CONSUMERS.clarity;
  const observed = fixture();
  observed.owner = { ...observed.owner, id: target.ownerAccountId, kind: target.ownerKind };
  observed.application = {
    ...observed.application,
    id: target.applicationId,
    ownerAccountId: target.ownerAccountId,
    type: target.type,
  };
  observed.workloads = target.roles.map((role) => ({
    id: role,
    applicationId: target.applicationId,
    provider: 'aws-iam',
    subject: safetyWorkloadSubject(role),
    environment: 'production',
    expiresAt: null,
  }));
  const base = safetyConsumerPlan('clarity', 'base', [], observed).plan.after;
  expect(base.application.capabilities).not.toContain('safety:content:v1');
  expect(
    safetyConsumerPlan('clarity', 'capability', ['profile', 'content'], base).plan.after.application
      .capabilities,
  ).toEqual(['existing:grant', 'safety:content:v1', 'safety:profile:v1']);
  expect(() => safetyConsumerPlan('clarity', 'capability', ['content-publication'], base)).toThrow(
    'candidate',
  );
});

it('rejects unbound or wrong-environment identities instead of granting scopes', () => {
  for (const environment of [null, 'development', 'staging']) {
    const before = fixture();
    before.workloads = before.workloads.map((row) => ({ ...row, environment }));
    expect(() => safetyConsumerPlan('allo', 'base', [], before)).toThrow('binding');
  }
});
