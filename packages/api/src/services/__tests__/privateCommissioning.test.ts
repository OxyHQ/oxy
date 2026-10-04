import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { ScopedExecutionAudience } from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { inferenceDeployments, inferenceDeploymentRoutingScores, inferenceModels,
  inferenceModelRevisions, inferencePublishers, inferenceProviders, priceVersions } from '../../db/schema';
import * as scoped from '../scopedExecution.service';
import { resolveEdgeRoute, resolveCatalogueViewer, UNCONSTRAINED_ROUTING,
  TEXT_COMPLETION_MODALITY, UNCONSTRAINED_EDGE_CAPACITY, selectRouteForViewer } from '../inferenceCatalogue.service';

beforeAll(async () => { await connectPostgres(); });
afterAll(closePostgres);
afterEach(() => jest.restoreAllMocks());
jest.setTimeout(60_000);
const viewer = resolveCatalogueViewer({ type: 'internal', isInternal: true });

async function fixture() {
  const key = randomUUID().replaceAll('-', '');
  const publisher = `private${key}`;
  const provider = `provider${key}`;
  const deploymentId = `deployment-${key}`;
  await getDb().insert(inferencePublishers).values({ slug: publisher, displayName: 'Synthetic commissioning publisher' });
  const [model] = await getDb().insert(inferenceModels).values({ publisherSlug: publisher, slug: 'fixture',
    displayName: 'Synthetic commissioning model', supportsTools: false, supportsParallelToolCalls: false,
    supportsStructuredOutput: true, supportsJsonMode: true, supportsReasoning: false, supportsStreaming: false, supportsPromptCaching: false, inputModalities: ['text'], outputModalities: ['text'],
    maxContextTokens: 32000, maxOutputTokens: 8192, licenseId: 'synthetic-reviewed', licenseDisplayName: 'Fixture',
    commercialUseAllowed: true, requiresAttribution: false, releaseKind: 'open_weight' }).returning();
  const [revision] = await getDb().insert(inferenceModelRevisions).values({ modelId: model.id,
    revision: 'fixture-v1', releasedAt: new Date(), isCurrent: true }).returning();
  await getDb().insert(inferenceProviders).values({ slug: provider, displayName: 'Synthetic commissioning provider', kind: 'third_party',
    retainsPayloads: false, retentionDays: 0, trainsOnCustomerData: false, zeroDataRetentionAvailable: true });
  const modelReference = `${model.modelId}@fixture-v1`;
  const [price] = await getDb().insert(priceVersions).values({ provider, modelReference, currency: 'USD',
    status: 'active', effectiveFrom: new Date(Date.now() - 60000) }).returning();
  const audience: ScopedExecutionAudience = { permitId: `permit-${key}`, idempotencyKey: `key-${key}`,
    fixtureSha256: scoped.hashScopedInput({ synthetic: true }), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    principal: { accountId: `account-${key}`, applicationId: `app-${key}`, credentialId: `credential-${key}`, environment: 'production' },
    policy: { routingPolicyId: 'synthetic-policy', policyVersion: 1 }, deploymentId, provider, keyId: `provider-key-${key}`,
    modelReference, upstreamModelId: 'fixture-v1', priceVersionId: price.id,
    providerRateCardVersionId: `card-${key}`, providerSourceVersion: `source-${key}`, maxCostUsd: '0.01' };
  const [deployment] = await getDb().insert(inferenceDeployments).values({ modelRevisionId: revision.id, providerSlug: provider,
    internalRouteId: deploymentId, priceVersionId: price.id, scopedExecution: audience, regions: [],
    availabilityScope: 'platform_internal', commercialPermission: 'standard_application_use',
    permissionState: 'pending_review', status: 'disabled', legalReviewStatus: 'approved',
    legalReviewEvidenceRef: 'synthetic-legal-review', legalReviewedAt: new Date(),
    retainsPayloads: false, retentionDays: 0, trainsOnCustomerData: false, zeroDataRetentionAvailable: true }).returning();
  await getDb().insert(inferenceDeploymentRoutingScores).values({ deploymentId, priceVersionId: price.id,
    priceScore: 42, priceSource: 'reviewed_scorecard', priceEvidenceRef: 'synthetic-real-price',
    latencySource: 'reviewed_scorecard', latencyEvidenceRef: 'synthetic-not-measured',
    latencyMeasurementWindowStart: new Date(0), latencyMeasurementWindowEnd: new Date(1), latencyValidUntil: new Date(2),
    throughputSource: 'reviewed_scorecard', throughputEvidenceRef: 'synthetic-not-measured',
    throughputMeasurementWindowStart: new Date(0), throughputMeasurementWindowEnd: new Date(1), throughputValidUntil: new Date(2),
    balancedSource: 'reviewed_scorecard', balancedEvidenceRef: 'synthetic-not-measured',
    balancedFormulaRef: 'synthetic-unmeasured', balancedValidUntil: new Date(2), changedAt: new Date(),
    fundingClass: 'standard_payg', fundingState: 'available', fundingEvidenceRef: 'synthetic-provider-price',
    reason: 'Private commissioning fixture; no measured benchmark', changedByUserId: 'fixture' });
  const resolve = (optimiseFor: 'price' | 'latency' | 'throughput' | 'balanced' = 'price', scope = audience) =>
    resolveEdgeRoute(viewer, modelReference, UNCONSTRAINED_ROUTING, TEXT_COMPLETION_MODALITY, optimiseFor,
      UNCONSTRAINED_EDGE_CAPACITY, { applicationId: audience.principal.applicationId, environment: 'production', scopedExecution: scope });
  const authorizeFixture = () => jest.spyOn(scoped, 'privateCommissioningAudience').mockImplementation((input, now = Date.now()) =>
    input !== undefined && JSON.stringify(input) === JSON.stringify(audience) && Date.parse(audience.expiresAt) > now ? audience : undefined);
  return { audience, deployment, resolve, authorizeFixture, modelReference };
}

it('wire audience alone cannot commission a pending disabled deployment', async () => {
  const f = await fixture();
  expect(await f.resolve()).toMatchObject({ status: 'unknown-model' });
  expect(await selectRouteForViewer(viewer, f.modelReference, UNCONSTRAINED_ROUTING)).toBeUndefined();
});
it('private source authority admits real price only, preserving public permission and missing scores', async () => {
  const f = await fixture();
  // Synthetic source authority only. Production getter remains absent; no caller switch is introduced.
  f.authorizeFixture();
  const result = await f.resolve();
  expect(result.status).toBe('resolved');
  if (result.status !== 'resolved') throw new Error('Fixture did not resolve');
  expect(result.alternates).toEqual([]);
  expect(result.route.scopedCatalogueEvidence).toMatchObject({ admission: 'private_commissioning',
    permissionState: 'pending_review', deploymentStatus: 'disabled', legalReviewStatus: 'approved' });
  for (const policy of ['latency', 'throughput', 'balanced'] as const) {
    expect(await f.resolve(policy)).toMatchObject({ status: 'routing-evidence-unavailable' });
  }
  expect(await selectRouteForViewer(viewer, f.modelReference, UNCONSTRAINED_ROUTING)).toBeUndefined();
  expect((await getDb().select().from(inferenceDeployments).where(eq(inferenceDeployments.id, f.deployment.id)))[0])
    .toMatchObject({ status: 'disabled', permissionState: 'pending_review' });
});
it.each(['no-legal', 'no-evidence', 'foreign-audience', 'expired', 'restricted', 'public-scope'] as const)
  ('refuses %s instead of widening private commissioning', async (failure) => {
    const f = await fixture(); f.authorizeFixture();
    if (failure === 'no-legal') await getDb().update(inferenceDeployments).set({ legalReviewStatus: 'not_started' }).where(eq(inferenceDeployments.id, f.deployment.id));
    if (failure === 'no-evidence') await getDb().update(inferenceDeployments).set({ legalReviewEvidenceRef: null, legalReviewStatus: 'not_started' }).where(eq(inferenceDeployments.id, f.deployment.id));
    if (failure === 'restricted') await getDb().update(inferenceDeployments).set({ permissionState: 'restricted' }).where(eq(inferenceDeployments.id, f.deployment.id));
    if (failure === 'public-scope') await getDb().update(inferenceDeployments).set({ availabilityScope: 'public_payg', commercialPermission: 'public_resale_approved' }).where(eq(inferenceDeployments.id, f.deployment.id));
    if (failure === 'expired') Object.assign(f.audience, { expiresAt: new Date(0).toISOString() });
    expect(await f.resolve('price', failure === 'foreign-audience' ? { ...f.audience, keyId: 'foreign' } : f.audience))
      .toMatchObject({ status: 'unknown-model' });
  });

import { users, securityActivities, accountClosureFences } from '../../db/schema';
import { executeScopedLegalReview } from '../scopedLegalReviewOperation.service';

async function legalFixture() {
  const f = await fixture();
  await getDb().update(inferenceDeployments).set({ legalReviewStatus: 'not_started', legalReviewEvidenceRef: null }).where(eq(inferenceDeployments.id, f.deployment.id));
  const reviewerUserId = randomUUID();
  await getDb().insert(users).values({ id: reviewerUserId, username: `reviewer${randomUUID().replaceAll('-', '')}`,
    isStaff: true, staffCapabilities: ['inference:catalogue:publish'] });
  const plan = { kind: 'scoped-legal-review-v1', reviewerUserId, deploymentRowId: f.deployment.id, audience: f.audience,
    expectedLegalStatus: 'not_started', expectedEvidenceRef: null as string | null,
    evidenceRef: 'synthetic-review-register/specific-terms', reason: 'Synthetic legal-operation fixture',
    operator: 'synthetic-root-operator', sessionApprovalRef: 'synthetic-reviewed-session' };
  return { ...f, plan, reviewerUserId };
}
it('legal CLI is dry-run by default and atomically records the exact review without public approval', async () => {
  const f = await legalFixture();
  const before = await getDb().select().from(inferenceDeployments).where(eq(inferenceDeployments.id, f.deployment.id));
  const dry = await executeScopedLegalReview(f.plan);
  expect(dry).toMatchObject({ applied: false, publicServingApproved: false, inferenceAuthorized: false });
  expect(await getDb().select().from(inferenceDeployments).where(eq(inferenceDeployments.id, f.deployment.id))).toEqual(before);
  expect(await getDb().select().from(securityActivities).where(eq(securityActivities.userId, f.reviewerUserId))).toEqual([]);
  expect(await executeScopedLegalReview(f.plan, { apply: true, expectedPlanSha256: dry.planSha256 })).toMatchObject({ applied: true });
  const [record] = await getDb().select().from(inferenceDeployments).where(eq(inferenceDeployments.id, f.deployment.id));
  expect(record).toMatchObject({ permissionState: 'pending_review', status: 'disabled', legalReviewStatus: 'approved',
    legalReviewEvidenceRef: f.plan.evidenceRef, legalReviewedByUserId: f.reviewerUserId });
  const audit = await getDb().select().from(securityActivities).where(eq(securityActivities.userId, f.reviewerUserId));
  expect(audit).toHaveLength(1);
  expect(audit[0].metadata).toMatchObject({ operation: 'scoped_private_commissioning_legal_review',
    authorityTransport: 'root_operator_cli', planSha256: dry.planSha256, publicServingApproved: false });
  // An ambiguous apply ACK must be reconciled; a blind second apply cannot overwrite the prior evidence.
  await expect(executeScopedLegalReview(f.plan, { apply: true, expectedPlanSha256: dry.planSha256 })).rejects.toThrow('precondition');
});
it.each(['hash', 'not-staff', 'scope', 'bot', 'archived', 'fence', 'foreign-route', 'changed-evidence'] as const)
  ('legal operation denies %s without review or audit writes', async (failure) => {
    const f = await legalFixture();
    if (failure === 'not-staff') await getDb().update(users).set({ isStaff: false }).where(eq(users.id, f.reviewerUserId));
    if (failure === 'scope') await getDb().update(users).set({ staffCapabilities: [] }).where(eq(users.id, f.reviewerUserId));
    if (failure === 'bot') await getDb().update(users).set({ type: 'agent' }).where(eq(users.id, f.reviewerUserId));
    if (failure === 'archived') await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, f.reviewerUserId));
    if (failure === 'fence') await getDb().insert(accountClosureFences).values({ accountId: f.reviewerUserId });
    if (failure === 'foreign-route') f.plan.audience = { ...f.plan.audience, deploymentId: 'foreign' };
    if (failure === 'changed-evidence') f.plan.expectedEvidenceRef = 'stale-review';
    const before = await getDb().select().from(inferenceDeployments).where(eq(inferenceDeployments.id, f.deployment.id));
    await expect(executeScopedLegalReview(f.plan, { apply: true,
      expectedPlanSha256: failure === 'hash' ? 'wrong' : scoped.hashScopedInput(f.plan) })).rejects.toThrow();
    expect(await getDb().select().from(inferenceDeployments).where(eq(inferenceDeployments.id, f.deployment.id))).toEqual(before);
    expect(await getDb().select().from(securityActivities).where(eq(securityActivities.userId, f.reviewerUserId))).toEqual([]);
  });

it('legal review rolls back when its durable audit cannot commit', async () => {
  const f = await legalFixture();
  const before = await getDb().select().from(inferenceDeployments).where(eq(inferenceDeployments.id, f.deployment.id));
  // Temporary fault only in the owned Jest database; production has no such hook.
  await getDb().execute(sql.raw(`CREATE FUNCTION commissioning_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.metadata->>'operation' = 'scoped_private_commissioning_legal_review' THEN
      RAISE EXCEPTION 'synthetic audit unavailable'; END IF; RETURN NEW; END $$`));
  await getDb().execute(sql.raw('CREATE TRIGGER commissioning_audit_fault BEFORE INSERT ON security_activities FOR EACH ROW EXECUTE FUNCTION commissioning_audit_fault()'));
  try {
    await expect(executeScopedLegalReview(f.plan, { apply: true, expectedPlanSha256: scoped.hashScopedInput(f.plan) })).rejects.toThrow();
    expect(await getDb().select().from(inferenceDeployments).where(eq(inferenceDeployments.id, f.deployment.id))).toEqual(before);
    expect(await getDb().select().from(securityActivities).where(eq(securityActivities.userId, f.reviewerUserId))).toEqual([]);
  } finally {
    await getDb().execute(sql.raw('DROP TRIGGER commissioning_audit_fault ON security_activities'));
    await getDb().execute(sql.raw('DROP FUNCTION commissioning_audit_fault()'));
  }
});

it('serializes two competing legal applies to one audit and refuses stale authority', async () => {
  const f = await legalFixture();
  const outcomes = await Promise.allSettled([1, 2].map(() => executeScopedLegalReview(f.plan,
    { apply: true, expectedPlanSha256: scoped.hashScopedInput(f.plan) })));
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  expect(await getDb().select().from(securityActivities).where(eq(securityActivities.userId, f.reviewerUserId))).toHaveLength(1);
});
it('rechecks source withdrawal after the final asynchronous catalogue lookup', async () => {
  const f = await fixture();
  const source = f.authorizeFixture();
  source.mockImplementationOnce(() => f.audience).mockImplementationOnce(() => f.audience).mockImplementation(() => undefined);
  expect(await f.resolve()).toMatchObject({ status: 'unknown-model' });
});

import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
it('compiled Node CLI performs dry-run and explicit hash-bound apply on the same owned SQL fixture', async () => {
  const f = await legalFixture();
  const folder = mkdtempSync(join(tmpdir(), 'oxy-legal-cli-'));
  const file = join(folder, 'plan.json');
  writeFileSync(file, JSON.stringify(f.plan), { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL };
  // API test shards build workspace dependencies, not API dist. Compile the
  // actual production sources with the canonical tsconfig into a fresh tree;
  // neither a stale local dist nor a test double can satisfy this check.
  const output = join(folder, 'dist');
  const command = join(output, 'scripts/recordScopedLegalReview.js');
  try {
    symlinkSync(join(process.cwd(), 'node_modules'), join(folder, 'node_modules'), 'dir');
    const build = spawnSync('node', [require.resolve('typescript/bin/tsc'), '--project',
      join(process.cwd(), 'tsconfig.json'), '--outDir', output], {
      env, encoding: 'utf8', timeout: 120_000,
    });
    expect({ exit: build.status, stdout: build.stdout, stderr: build.stderr }).toMatchObject({ exit: 0 });
    const dry = spawnSync('node', [command, file], { env, encoding: 'utf8' });
    expect({ exit: dry.status, stderr: dry.stderr }).toMatchObject({ exit: 0 });
    const dryReceipt = JSON.parse(dry.stdout.split('\n').find((line) => line.includes('"kind":"scoped-legal-review-v1"'))!);
    expect(dryReceipt).toMatchObject({ applied: false, publicServingApproved: false });
    const apply = spawnSync('node', [command, file, '--apply', dryReceipt.planSha256], { env, encoding: 'utf8' });
    expect({ exit: apply.status, stderr: apply.stderr }).toMatchObject({ exit: 0 });
    expect(JSON.parse(apply.stdout.split('\n').find((line) => line.includes('"kind":"scoped-legal-review-v1"'))!)).toMatchObject({ applied: true, planSha256: dryReceipt.planSha256 });
    expect(await getDb().select().from(securityActivities).where(eq(securityActivities.userId, f.reviewerUserId))).toHaveLength(1);
  } finally { rmSync(folder, { recursive: true }); }
}, 180_000);
