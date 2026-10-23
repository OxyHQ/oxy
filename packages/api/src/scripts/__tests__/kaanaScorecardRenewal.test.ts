/**
 * Same-value scorecard renewal against a REAL Postgres: the renewal moves an
 * audited reviewed row to the derived validity, records one immutable event,
 * is a no-op on rerun, and refuses every other state without writing.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  KAANA_INITIAL_PROVIDERS,
  type KaanaInitialProvider,
  kaanaInitialScorecardReview,
  kaanaScorecardRenewalReview,
} from '../../config/kaanaInitialCatalogue';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  inferenceDeploymentRoutingScoreEvents,
  inferenceDeploymentRoutingScores,
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
  priceVersions,
} from '../../db/schema';
import {
  createKaanaScorecardRenewalPlanSha256,
  decideKaanaScorecardRenewal,
  kaanaReviewedScorecardFields,
  kaanaScorecardRenewalOperations,
  renewKaanaRoutingScorecards,
} from '../kaanaScorecardRenewal';

const REVIEWER = '6981c9178fcdefaf81988ffb';
const RENEWAL = kaanaScorecardRenewalReview(new Date());
const MINIMUM_VALID_UNTIL = new Date(Date.now() + 3_600_000);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

/** A synthetic copy of a reviewed provider with its own exact identity. */
function syntheticProvider(base: KaanaInitialProvider): KaanaInitialProvider {
  return { ...base, deploymentId: `dep_renewal_fixture_${suffix()}` };
}

async function seedDeployment(provider: KaanaInitialProvider): Promise<string> {
  const db = getDb();
  const publisherSlug = `pub${suffix()}`;
  const providerSlug = `prv${suffix()}`;
  await db.insert(inferencePublishers).values({ slug: publisherSlug, displayName: 'Fixture Pub' });
  const [model] = await db
    .insert(inferenceModels)
    .values({
      publisherSlug,
      slug: `mdl${suffix()}`,
      displayName: 'Fixture Model',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: false,
      supportsParallelToolCalls: false,
      supportsStructuredOutput: false,
      supportsJsonMode: false,
      supportsReasoning: false,
      supportsStreaming: true,
      supportsPromptCaching: false,
      maxContextTokens: 8192,
      maxOutputTokens: 1024,
      licenseId: 'apache-2.0',
      licenseDisplayName: 'Apache 2.0',
      commercialUseAllowed: true,
      requiresAttribution: false,
      releaseKind: 'open_weight',
    })
    .returning({ id: inferenceModels.id, modelId: inferenceModels.modelId });
  const revisionName = `r${suffix()}`;
  const [revision] = await db
    .insert(inferenceModelRevisions)
    .values({
      modelId: model.id,
      revision: revisionName,
      releasedAt: new Date(),
      isCurrent: true,
    })
    .returning({ id: inferenceModelRevisions.id });
  await db.insert(inferenceProviders).values({
    slug: providerSlug,
    displayName: 'Fixture Provider',
    kind: 'third_party',
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
  });
  if (model.modelId === null) throw new Error('model id did not compose');
  const [priceVersion] = await db
    .insert(priceVersions)
    .values({
      modelReference: `${model.modelId}@${revisionName}`,
      provider: providerSlug,
      status: 'active',
      effectiveFrom: new Date(Date.now() - 60_000),
    })
    .returning({ id: priceVersions.id });
  await db.insert(inferenceDeployments).values({
    modelRevisionId: revision.id,
    providerSlug,
    regions: [],
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
    availabilityScope: 'platform_internal',
    commercialPermission: 'standard_application_use',
    status: 'active',
    internalRouteId: provider.deploymentId,
    priceVersionId: priceVersion.id,
  });
  return priceVersion.id;
}

/** Write the initial reviewed state exactly as the bootstrap does. */
async function seedInitialScorecard(
  provider: KaanaInitialProvider,
  priceVersionId: string,
  overrides: { balancedScore?: number; withEvent?: boolean } = {},
): Promise<void> {
  const initial = kaanaReviewedScorecardFields(provider, kaanaInitialScorecardReview(provider), {
    priceVersionId,
    reviewerUserId: REVIEWER,
  });
  const row = {
    ...initial,
    fundingClass: initial.fundingClass,
    fundingState: initial.fundingState,
    fundingEvidenceRef: initial.fundingEvidenceRef,
    balancedScore: overrides.balancedScore ?? initial.balancedScore,
  };
  await getDb().insert(inferenceDeploymentRoutingScores).values(row);
  if (overrides.withEvent !== false) {
    const { changedAt, ...eventValues } = row;
    await getDb()
      .insert(inferenceDeploymentRoutingScoreEvents)
      .values({
        ...eventValues,
        fundingClass: row.fundingClass,
        fundingState: row.fundingState,
        fundingEvidenceRef: row.fundingEvidenceRef,
        createdAt: changedAt,
      });
  }
}

function renewInTransaction(providers: readonly KaanaInitialProvider[]) {
  return getDb().transaction((tx) =>
    renewKaanaRoutingScorecards(tx, {
      providers,
      reviewerUserId: REVIEWER,
      renewal: RENEWAL,
      minimumValidUntil: MINIMUM_VALID_UNTIL,
    }),
  );
}

async function readRow(deploymentId: string) {
  const [row] = await getDb()
    .select()
    .from(inferenceDeploymentRoutingScores)
    .where(eq(inferenceDeploymentRoutingScores.deploymentId, deploymentId));
  return row;
}

async function countEvents(deploymentId: string, createdAt?: Date) {
  const rows = await getDb()
    .select({ id: inferenceDeploymentRoutingScoreEvents.id })
    .from(inferenceDeploymentRoutingScoreEvents)
    .where(
      createdAt === undefined
        ? eq(inferenceDeploymentRoutingScoreEvents.deploymentId, deploymentId)
        : and(
            eq(inferenceDeploymentRoutingScoreEvents.deploymentId, deploymentId),
            eq(inferenceDeploymentRoutingScoreEvents.createdAt, createdAt),
          ),
    );
  return rows.length;
}

describe('the derived renewal validity', () => {
  it('is the UTC day of the run plus the reviewed window, the same all day', () => {
    const morning = kaanaScorecardRenewalReview(new Date('2026-10-23T00:00:00.000Z'));
    expect(morning).toEqual(kaanaScorecardRenewalReview(new Date('2026-10-23T23:59:59.999Z')));
    expect(morning.changedAt).toBe('2026-10-23T00:00:00.000Z');
    expect(morning.validUntil).toBe('2026-11-22T00:00:00.000Z');
    expect(morning.reason).toContain('on 2026-10-23');
    expect(morning.reason).toContain('extended to 2026-11-22');
  });
});

describe('decideKaanaScorecardRenewal', () => {
  const at = (iso: string) => new Date(iso);
  const values = { balancedScore: 800 };
  const row = {
    balancedScore: 800,
    latencyValidUntil: at('2026-11-01'),
    throughputValidUntil: at('2026-11-01'),
    balancedValidUntil: at('2026-11-01'),
    reason: 'reviewed',
    changedByUserId: REVIEWER,
    changedAt: at('2026-09-24'),
  };
  const renewal = { validUntil: at('2026-11-22'), changedAt: at('2026-10-23') };

  it('classifies current, renewable and drifted rows', () => {
    expect(decideKaanaScorecardRenewal(row, values, renewal)).toEqual({ action: 'renew' });
    expect(
      decideKaanaScorecardRenewal(
        { ...row, balancedValidUntil: at('2026-11-22') },
        values,
        renewal,
      ),
    ).toEqual({ action: 'drift', fields: ['latencyValidUntil', 'throughputValidUntil'] });
    expect(
      decideKaanaScorecardRenewal(row, values, { ...renewal, validUntil: at('2026-11-01') }),
    ).toEqual({ action: 'current' });
    expect(decideKaanaScorecardRenewal({ ...row, balancedScore: 900 }, values, renewal)).toEqual({
      action: 'drift',
      fields: ['balancedScore'],
    });
    expect(
      decideKaanaScorecardRenewal(
        { ...row, changedAt: at('2026-10-23T09:00:00Z') },
        values,
        renewal,
      ),
    ).toEqual({ action: 'drift', fields: ['changedAt'] });
  });

  it('binds the plan hash to every outcome', () => {
    const outcome = {
      deploymentId: 'dep_exact',
      action: 'renew' as const,
      fromValidUntil: '2026-11-01T00:00:00.000Z',
      toValidUntil: '2026-11-22T00:00:00.000Z',
      toChangedAt: '2026-10-23T00:00:00.000Z',
    };
    const hash = createKaanaScorecardRenewalPlanSha256({
      reviewerUserId: REVIEWER,
      outcomes: [outcome],
    });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      createKaanaScorecardRenewalPlanSha256({
        reviewerUserId: REVIEWER,
        outcomes: [{ ...outcome, action: 'current' }],
      }),
    ).not.toBe(hash);
    expect(kaanaScorecardRenewalOperations([outcome])).toEqual(['scorecard-renewal:dep_exact']);
    expect(kaanaScorecardRenewalOperations([{ ...outcome, action: 'current' }])).toEqual([]);
  });
});

describe('renewKaanaRoutingScorecards against Postgres', () => {
  it('renews an audited reviewed row once, appends one event and is idempotent', async () => {
    const provider = syntheticProvider(KAANA_INITIAL_PROVIDERS[0]);
    const priceVersionId = await seedDeployment(provider);
    await seedInitialScorecard(provider, priceVersionId);
    const initial = kaanaInitialScorecardReview(provider);

    const [renewed] = await renewInTransaction([provider]);
    expect(renewed).toEqual({
      deploymentId: provider.deploymentId,
      action: 'renew',
      fromValidUntil: initial.validUntil,
      toValidUntil: RENEWAL.validUntil,
      toChangedAt: RENEWAL.changedAt,
    });

    const row = await readRow(provider.deploymentId);
    expect(row.balancedValidUntil.toISOString()).toBe(RENEWAL.validUntil);
    expect(row.latencyValidUntil.toISOString()).toBe(RENEWAL.validUntil);
    expect(row.throughputValidUntil.toISOString()).toBe(RENEWAL.validUntil);
    expect(row.changedAt.toISOString()).toBe(RENEWAL.changedAt);
    expect(row.reason).toBe(RENEWAL.reason);
    expect(row.balancedScore).toBe(provider.scores.balanced);
    expect(row.latencyMeasurementWindowEnd.toISOString()).toBe(initial.changedAt);
    expect(await countEvents(provider.deploymentId)).toBe(2);
    expect(await countEvents(provider.deploymentId, new Date(RENEWAL.changedAt))).toBe(1);

    const [again] = await renewInTransaction([provider]);
    expect(again.action).toBe('current');
    expect(await countEvents(provider.deploymentId)).toBe(2);
  });

  it('refuses a drifted row without writing anything', async () => {
    const provider = syntheticProvider(KAANA_INITIAL_PROVIDERS[1]);
    const priceVersionId = await seedDeployment(provider);
    await seedInitialScorecard(provider, priceVersionId, { balancedScore: 1 });

    await expect(renewInTransaction([provider])).rejects.toThrow(
      /not a reviewed state this renewal may move forward.*balancedScore/,
    );
    const row = await readRow(provider.deploymentId);
    expect(row.balancedValidUntil.toISOString()).toBe(
      kaanaInitialScorecardReview(provider).validUntil,
    );
    expect(await countEvents(provider.deploymentId)).toBe(1);
  });

  it('refuses to renew a row that has no audited provenance event', async () => {
    const provider = syntheticProvider(KAANA_INITIAL_PROVIDERS[2]);
    const priceVersionId = await seedDeployment(provider);
    await seedInitialScorecard(provider, priceVersionId, { withEvent: false });

    await expect(renewInTransaction([provider])).rejects.toThrow(
      /exactly one append-only provenance event; found 0/,
    );
    const row = await readRow(provider.deploymentId);
    expect(row.balancedValidUntil.toISOString()).toBe(
      kaanaInitialScorecardReview(provider).validUntil,
    );
  });

  it('refuses a renewed validity that does not cover the minimum horizon', async () => {
    const provider = syntheticProvider(KAANA_INITIAL_PROVIDERS[0]);
    await expect(
      getDb().transaction((tx) =>
        renewKaanaRoutingScorecards(tx, {
          providers: [provider],
          reviewerUserId: REVIEWER,
          renewal: RENEWAL,
          minimumValidUntil: new Date(Date.parse(RENEWAL.validUntil) + 1),
        }),
      ),
    ).rejects.toThrow(/does not cover the configured minimum validity horizon/);
  });
});
