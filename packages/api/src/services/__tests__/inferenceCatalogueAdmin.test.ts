/**
 * The commercial-permission workflow (issue #972, workstream 11), against a
 * REAL Postgres.
 *
 * The subject is the ORDER of two decisions — review, then approve — and the
 * fact that the second is refused by the database rather than by the service.
 * The service's own guard produces a readable message; deleting it would not
 * make an unreviewed route approvable, and the last case here proves that by
 * going around the service entirely.
 */

import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { routingScoreValidityThreshold } from '../../config/inferenceRoutingScoreValidity';
import {
  inferenceDeployments,
  inferenceDeploymentRoutingScoreEvents,
  inferenceDeploymentRoutingScores,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
  priceVersions,
  users,
} from '../../db/schema';
import {
  ROUTING_SCORE_EVENT_IMMUTABLE_MESSAGE,
  ROUTING_SCORE_EVENT_FUNCTION,
  ROUTING_SCORE_EVENT_TABLE,
  ROUTING_SCORE_EVENT_TRIGGER,
} from '../../db/schema/inferenceDeploymentRoutingScoreImmutability';
import {
  ACTION_TARGET_STATE,
  applyPermissionAction,
  DEPLOYMENT_PERMISSION_ACTIONS,
  DeploymentNotFoundError,
  DeploymentPermissionRefused,
  recordLegalReview,
  setDeploymentRoutingScores,
} from '../inferenceCatalogueAdmin.service';
import {
  listCatalogueForViewer,
  PUBLIC_CATALOGUE_VIEWER,
  selectRouteForViewer,
  UNCONSTRAINED_ROUTING,
} from '../inferenceCatalogue.service';
import {
  assessInferenceRoutingReadiness,
  readInferenceRoutingReadinessRows,
} from '../inferenceRoutingReadiness.service';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
process.env.INFERENCE_ROUTING_SCORE_MIN_VALIDITY_SECONDS = '3600';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

async function insertStaffUser(): Promise<string> {
  const tag = suffix();
  const [row] = await getDb()
    .insert(users)
    .values({ username: `staff-${tag}`, email: `staff-${tag}@example.test` })
    .returning({ id: users.id });
  return row.id;
}

/** A proposed route: default deny, no review, nothing approved. */
async function insertProposedRoute(): Promise<{
  deploymentId: string;
  modelId: string;
  internalRouteId: string;
  priceVersionId: string;
}> {
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
    .values({ modelId: model.id, revision: revisionName, releasedAt: new Date(), isCurrent: true })
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

  if (model.modelId === null) throw new Error('the generated model id did not compose');
  const [priceVersion] = await db
    .insert(priceVersions)
    .values({
      modelReference: `${model.modelId}@${revisionName}`,
      provider: providerSlug,
      status: 'active',
      effectiveFrom: new Date(Date.now() - 60_000),
    })
    .returning({ id: priceVersions.id });

  const internalRouteId = `dep_proposed_${suffix()}`;

  const [deployment] = await db
    .insert(inferenceDeployments)
    .values({
      modelRevisionId: revision.id,
      providerSlug,
      regions: ['us-west-2'],
      retainsPayloads: false,
      retentionDays: 0,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
      status: 'active',
      internalRouteId,
      priceVersionId: priceVersion.id,
    })
    .returning({ id: inferenceDeployments.id });

  return {
    deploymentId: deployment.id,
    modelId: model.modelId,
    internalRouteId,
    priceVersionId: priceVersion.id,
  };
}

function scorecardFor(priceVersionId: string, overrides: { balancedScore?: number | null } = {}) {
  const now = Date.now();
  const measurementWindowStart = new Date(now - 60 * 60 * 1000).toISOString();
  const measurementWindowEnd = new Date(now - 30 * 60 * 1000).toISOString();
  const validUntil = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  return {
    price: {
      score: 90,
      source: 'provider_contract' as const,
      evidenceRef: 'scorecard/price',
      priceVersionId,
    },
    latency: {
      score: 80,
      source: 'kaana_measurement' as const,
      evidenceRef: 'scorecard/latency',
      measurementWindowStart,
      measurementWindowEnd,
      validUntil,
    },
    throughput: {
      score: 70,
      source: 'kaana_measurement' as const,
      evidenceRef: 'scorecard/throughput',
      measurementWindowStart,
      measurementWindowEnd,
      validUntil,
    },
    balanced: {
      score: overrides.balancedScore === undefined ? 80 : overrides.balancedScore,
      source: 'reviewed_scorecard' as const,
      evidenceRef: 'scorecard/balanced',
      formulaRef: 'scorecard/formula-v1',
      validUntil,
    },
    reason: 'Reviewed routing evidence',
  };
}

async function approveLegalReview(deploymentId: string, staffUserId: string): Promise<void> {
  await recordLegalReview({
    deploymentId,
    status: 'approved',
    evidenceRef: `contract-register/${suffix()}`,
    reviewerUserId: staffUserId,
  });
}

describe('review comes before approval', () => {
  it('refuses to approve a route whose legal review has not happened', async () => {
    const staffUserId = await insertStaffUser();
    const { deploymentId, modelId } = await insertProposedRoute();

    await expect(
      applyPermissionAction({ deploymentId, action: 'approve', staffUserId })
    ).rejects.toBeInstanceOf(DeploymentPermissionRefused);

    // And it is still invisible, which is the consequence that matters.
    await expect(
      selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, modelId, UNCONSTRAINED_ROUTING)
    ).resolves.toBeUndefined();
  });

  it('serves the route once reviewed and approved, and not before', async () => {
    const staffUserId = await insertStaffUser();
    const { deploymentId, modelId, internalRouteId, priceVersionId } =
      await insertProposedRoute();

    // Before: withheld. This is the "and not before" half, measured rather than
    // assumed, so the case cannot pass on a route that was already visible.
    await expect(
      selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, modelId, UNCONSTRAINED_ROUTING)
    ).resolves.toBeUndefined();

    await recordLegalReview({
      deploymentId,
      status: 'approved',
      evidenceRef: `contract-register/${suffix()}`,
      reviewerUserId: staffUserId,
    });
    await setDeploymentRoutingScores({
      deploymentId: internalRouteId,
      staffUserId,
      scorecard: scorecardFor(priceVersionId),
    });
    const result = await applyPermissionAction({ deploymentId, action: 'approve', staffUserId });

    expect(result.permissionState).toBe('approved');
    const now = new Date();
    const readinessRows = await readInferenceRoutingReadinessRows();
    expect(readinessRows.map((row) => row.deploymentId)).toContain(internalRouteId);
    expect(
      assessInferenceRoutingReadiness(readinessRows, now, routingScoreValidityThreshold(now))
    ).toEqual({ status: 'ready' });
    await expect(selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, modelId, UNCONSTRAINED_ROUTING)).resolves.toBeDefined();
  });

  it('refuses a legal approval that cites no evidence', async () => {
    const staffUserId = await insertStaffUser();
    const { deploymentId } = await insertProposedRoute();

    await expect(
      recordLegalReview({ deploymentId, status: 'approved', reviewerUserId: staffUserId })
    ).rejects.toBeInstanceOf(DeploymentPermissionRefused);

    // Whitespace is not evidence: an empty string is a VALUE and would satisfy
    // a bare null check, which is the cheapest way to green a weaker rule.
    await expect(
      recordLegalReview({
        deploymentId,
        status: 'approved',
        evidenceRef: '   ',
        reviewerUserId: staffUserId,
      })
    ).rejects.toBeInstanceOf(DeploymentPermissionRefused);
  });

  it('is the DATABASE that refuses, not only the service', async () => {
    // The service's guard is a better message. This goes around it entirely and
    // writes the row directly: if the constraint were dropped, this case goes
    // green and every other case in this file still passes.
    const { deploymentId } = await insertProposedRoute();

    let code: string | undefined;
    try {
      await getDb()
        .update(inferenceDeployments)
        .set({ permissionState: 'approved' })
        .where(eq(inferenceDeployments.id, deploymentId));
    } catch (error) {
      for (let current: unknown = error; current instanceof Error; current = current.cause) {
        const candidate: unknown = Reflect.get(current, 'code');
        if (typeof candidate === 'string') {
          code = candidate;
          break;
        }
      }
    }
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('refuses approval without a Kaana id, without a scorecard, or with a null score', async () => {
    const staffUserId = await insertStaffUser();

    const unmapped = await insertProposedRoute();
    await approveLegalReview(unmapped.deploymentId, staffUserId);
    await getDb()
      .update(inferenceDeployments)
      .set({ internalRouteId: null })
      .where(eq(inferenceDeployments.id, unmapped.deploymentId));
    await expect(
      applyPermissionAction({ deploymentId: unmapped.deploymentId, action: 'approve', staffUserId })
    ).rejects.toThrow('exact Kaana deploymentId');

    const missing = await insertProposedRoute();
    await approveLegalReview(missing.deploymentId, staffUserId);
    await expect(
      applyPermissionAction({ deploymentId: missing.deploymentId, action: 'approve', staffUserId })
    ).rejects.toThrow('complete routing scorecard');

    const incomplete = await insertProposedRoute();
    await setDeploymentRoutingScores({
      deploymentId: incomplete.internalRouteId,
      staffUserId,
      scorecard: scorecardFor(incomplete.priceVersionId, { balancedScore: null }),
    });
    await approveLegalReview(incomplete.deploymentId, staffUserId);
    await expect(
      applyPermissionAction({
        deploymentId: incomplete.deploymentId,
        action: 'approve',
        staffUserId,
      })
    ).rejects.toThrow('all four routing scores');
  });

  it('refuses approval after the price version changes or evidence falls inside the horizon', async () => {
    const staffUserId = await insertStaffUser();
    const mismatched = await insertProposedRoute();
    const other = await insertProposedRoute();
    await setDeploymentRoutingScores({
      deploymentId: mismatched.internalRouteId,
      staffUserId,
      scorecard: scorecardFor(mismatched.priceVersionId),
    });
    await getDb()
      .update(inferenceDeployments)
      .set({ priceVersionId: other.priceVersionId })
      .where(eq(inferenceDeployments.id, mismatched.deploymentId));
    await approveLegalReview(mismatched.deploymentId, staffUserId);
    await expect(
      applyPermissionAction({
        deploymentId: mismatched.deploymentId,
        action: 'approve',
        staffUserId,
      })
    ).rejects.toThrow('current exact priceVersionId');

    const stale = await insertProposedRoute();
    await setDeploymentRoutingScores({
      deploymentId: stale.internalRouteId,
      staffUserId,
      scorecard: scorecardFor(stale.priceVersionId),
    });
    await getDb()
      .update(inferenceDeploymentRoutingScores)
      .set({ balancedValidUntil: new Date(Date.now() + 30 * 60 * 1000) })
      .where(eq(inferenceDeploymentRoutingScores.deploymentId, stale.internalRouteId));
    await approveLegalReview(stale.deploymentId, staffUserId);
    await expect(
      applyPermissionAction({ deploymentId: stale.deploymentId, action: 'approve', staffUserId })
    ).rejects.toThrow('minimum validity horizon');

    const future = await insertProposedRoute();
    await setDeploymentRoutingScores({
      deploymentId: future.internalRouteId,
      staffUserId,
      scorecard: scorecardFor(future.priceVersionId),
    });
    await getDb()
      .update(inferenceDeploymentRoutingScores)
      .set({ latencyMeasurementWindowEnd: new Date(Date.now() + 60 * 60 * 1000) })
      .where(eq(inferenceDeploymentRoutingScores.deploymentId, future.internalRouteId));
    await approveLegalReview(future.deploymentId, staffUserId);
    await expect(
      applyPermissionAction({ deploymentId: future.deploymentId, action: 'approve', staffUserId })
    ).rejects.toThrow('ends in the future');
  });

  it('refuses a second approved row for one Kaana id in service and database', async () => {
    const staffUserId = await insertStaffUser();
    const first = await insertProposedRoute();
    const second = await insertProposedRoute();
    await setDeploymentRoutingScores({
      deploymentId: first.internalRouteId,
      staffUserId,
      scorecard: scorecardFor(first.priceVersionId),
    });
    await getDb()
      .update(inferenceDeployments)
      .set({ internalRouteId: first.internalRouteId, priceVersionId: first.priceVersionId })
      .where(eq(inferenceDeployments.id, second.deploymentId));
    await approveLegalReview(first.deploymentId, staffUserId);
    await approveLegalReview(second.deploymentId, staffUserId);
    await applyPermissionAction({ deploymentId: first.deploymentId, action: 'approve', staffUserId });
    await expect(
      applyPermissionAction({ deploymentId: second.deploymentId, action: 'approve', staffUserId })
    ).rejects.toThrow('already backs another approved');

    let code: string | undefined;
    try {
      await getDb()
        .update(inferenceDeployments)
        .set({ permissionState: 'approved' })
        .where(eq(inferenceDeployments.id, second.deploymentId));
    } catch (error) {
      for (let current: unknown = error; current instanceof Error; current = current.cause) {
        const candidate: unknown = Reflect.get(current, 'code');
        if (typeof candidate === 'string') {
          code = candidate;
          break;
        }
      }
    }
    expect(code).toBe(UNIQUE_VIOLATION);
  });
});

describe('routing-score authoring', () => {
  it('replaces all four scores by exact Kaana deployment identity', async () => {
    const staffUserId = await insertStaffUser();
    const deployment = await insertProposedRoute();
    const initial = scorecardFor(deployment.priceVersionId, { balancedScore: null });
    initial.reason = '  Initial reviewed ordering  ';
    initial.price.evidenceRef = '  scorecard/route-2026-09/price  ';

    const result = await setDeploymentRoutingScores({
      deploymentId: deployment.internalRouteId,
      staffUserId,
      scorecard: initial,
    });

    expect(result.deploymentId).toBe(deployment.internalRouteId);
    expect(result.scorecard).toMatchObject({
      price: { score: 90, evidenceRef: 'scorecard/route-2026-09/price' },
      latency: { score: 80 },
      throughput: { score: 70 },
      balanced: { score: null },
      reason: 'Initial reviewed ordering',
    });
    const [stored] = await getDb()
      .select({
        price: inferenceDeploymentRoutingScores.priceScore,
        latency: inferenceDeploymentRoutingScores.latencyScore,
        throughput: inferenceDeploymentRoutingScores.throughputScore,
        balanced: inferenceDeploymentRoutingScores.balancedScore,
        priceSource: inferenceDeploymentRoutingScores.priceSource,
        priceEvidenceRef: inferenceDeploymentRoutingScores.priceEvidenceRef,
        priceVersionId: inferenceDeploymentRoutingScores.priceVersionId,
        reason: inferenceDeploymentRoutingScores.reason,
        changedByUserId: inferenceDeploymentRoutingScores.changedByUserId,
      })
      .from(inferenceDeploymentRoutingScores)
      .where(eq(inferenceDeploymentRoutingScores.deploymentId, deployment.internalRouteId));
    expect(stored).toEqual({
      price: 90,
      latency: 80,
      throughput: 70,
      balanced: null,
      priceSource: 'provider_contract',
      priceEvidenceRef: 'scorecard/route-2026-09/price',
      priceVersionId: deployment.priceVersionId,
      reason: 'Initial reviewed ordering',
      changedByUserId: staffUserId,
    });

    const refreshed = scorecardFor(deployment.priceVersionId);
    refreshed.price.score = 91;
    refreshed.price.evidenceRef = 'scorecard/review-42/price';
    await setDeploymentRoutingScores({
      deploymentId: deployment.internalRouteId,
      staffUserId,
      scorecard: refreshed,
    });
    const events = await getDb()
      .select({
        id: inferenceDeploymentRoutingScoreEvents.id,
        price: inferenceDeploymentRoutingScoreEvents.priceScore,
        source: inferenceDeploymentRoutingScoreEvents.priceSource,
        evidenceRef: inferenceDeploymentRoutingScoreEvents.priceEvidenceRef,
        changedByUserId: inferenceDeploymentRoutingScoreEvents.changedByUserId,
      })
      .from(inferenceDeploymentRoutingScoreEvents)
      .where(eq(inferenceDeploymentRoutingScoreEvents.deploymentId, deployment.internalRouteId))
      .orderBy(
        asc(inferenceDeploymentRoutingScoreEvents.createdAt),
        asc(inferenceDeploymentRoutingScoreEvents.id)
      );
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          price: 90,
          source: 'provider_contract',
          evidenceRef: 'scorecard/route-2026-09/price',
          changedByUserId: staffUserId,
        }),
        expect.objectContaining({
          price: 91,
          source: 'provider_contract',
          evidenceRef: 'scorecard/review-42/price',
          changedByUserId: staffUserId,
        }),
      ])
    );

    const triggers = await getDb().execute<{ tgname: string }>(sql`
      select t.tgname
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relname = ${ROUTING_SCORE_EVENT_TABLE}
    `);
    expect(triggers.map((trigger) => trigger.tgname)).toContain(ROUTING_SCORE_EVENT_TRIGGER);
    const functions = await getDb().execute<{ definition: string }>(sql`
      select pg_get_functiondef(p.oid) as definition
      from pg_proc p
      where p.proname = ${ROUTING_SCORE_EVENT_FUNCTION}
    `);
    expect(functions).toHaveLength(1);
    expect(functions[0].definition).toContain('a routing score change is recorded by a new event');

    let immutabilityCode: string | undefined;
    const immutabilityMessages: string[] = [];
    try {
      await getDb()
        .update(inferenceDeploymentRoutingScoreEvents)
        .set({ reason: 'tampered history' })
        .where(eq(inferenceDeploymentRoutingScoreEvents.id, events[0].id));
    } catch (error) {
      for (let current: unknown = error; current instanceof Error; current = current.cause) {
        immutabilityMessages.push(current.message);
        const candidate: unknown = Reflect.get(current, 'code');
        if (typeof candidate === 'string') {
          immutabilityCode = candidate;
          break;
        }
      }
    }
    expect(immutabilityCode).toBe(CHECK_VIOLATION);
    expect(
      immutabilityMessages.some((message) =>
        message.includes(ROUTING_SCORE_EVENT_IMMUTABLE_MESSAGE)
      )
    ).toBe(true);
  });

  it('does not treat a provider slug or catalogue row id as a deployment identity', async () => {
    const staffUserId = await insertStaffUser();
    const deployment = await insertProposedRoute();

    await expect(
      setDeploymentRoutingScores({
        deploymentId: deployment.deploymentId,
        staffUserId,
        scorecard: scorecardFor(deployment.priceVersionId),
      })
    ).rejects.toBeInstanceOf(DeploymentNotFoundError);
  });

  it('rejects mismatched price provenance, future measurements and expired evidence', async () => {
    const staffUserId = await insertStaffUser();
    const deployment = await insertProposedRoute();
    const other = await insertProposedRoute();

    await expect(
      setDeploymentRoutingScores({
        deploymentId: deployment.internalRouteId,
        staffUserId,
        scorecard: scorecardFor(other.priceVersionId),
      })
    ).rejects.toThrow('not assigned');

    const future = scorecardFor(deployment.priceVersionId);
    future.latency.measurementWindowEnd = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await expect(
      setDeploymentRoutingScores({
        deploymentId: deployment.internalRouteId,
        staffUserId,
        scorecard: future,
      })
    ).rejects.toThrow('cannot end in the future');

    const expired = scorecardFor(deployment.priceVersionId);
    expired.balanced.validUntil = new Date(Date.now() - 1000).toISOString();
    await expect(
      setDeploymentRoutingScores({
        deploymentId: deployment.internalRouteId,
        staffUserId,
        scorecard: expired,
      })
    ).rejects.toThrow('must still be valid');
  });

  it('refuses score authoring when one Kaana id maps to multiple catalogue rows', async () => {
    const staffUserId = await insertStaffUser();
    const first = await insertProposedRoute();
    const second = await insertProposedRoute();
    await getDb()
      .update(inferenceDeployments)
      .set({ internalRouteId: first.internalRouteId, priceVersionId: first.priceVersionId })
      .where(eq(inferenceDeployments.id, second.deploymentId));

    await expect(
      setDeploymentRoutingScores({
        deploymentId: first.internalRouteId,
        staffUserId,
        scorecard: scorecardFor(first.priceVersionId),
      })
    ).rejects.toThrow('more than one catalogue row');
  });

  it.each(['disabled', 'retired'] as const)(
    'will not degrade evidence for an approved serving-scope route whose status is %s',
    async (status) => {
    const staffUserId = await insertStaffUser();
    const deployment = await insertProposedRoute();
    const other = await insertProposedRoute();
    await setDeploymentRoutingScores({
      deploymentId: deployment.internalRouteId,
      staffUserId,
      scorecard: scorecardFor(deployment.priceVersionId),
    });
    await approveLegalReview(deployment.deploymentId, staffUserId);
    await applyPermissionAction({
      deploymentId: deployment.deploymentId,
      action: 'approve',
      staffUserId,
    });

    await getDb()
      .update(inferenceDeployments)
      .set({ status })
      .where(eq(inferenceDeployments.id, deployment.deploymentId));

    await expect(
      setDeploymentRoutingScores({
        deploymentId: deployment.internalRouteId,
        staffUserId,
        scorecard: scorecardFor(deployment.priceVersionId, { balancedScore: null }),
      })
    ).rejects.toThrow('approved serving-scope route');

    const shortLived = scorecardFor(deployment.priceVersionId);
    const shortValidUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    shortLived.latency.validUntil = shortValidUntil;
    shortLived.throughput.validUntil = shortValidUntil;
    shortLived.balanced.validUntil = shortValidUntil;
    await expect(
      setDeploymentRoutingScores({
        deploymentId: deployment.internalRouteId,
        staffUserId,
        scorecard: shortLived,
      })
    ).rejects.toThrow('configured minimum validity horizon');

    await expect(
      setDeploymentRoutingScores({
        deploymentId: deployment.internalRouteId,
        staffUserId,
        scorecard: scorecardFor(other.priceVersionId),
      })
    ).rejects.toThrow('not assigned to this exact Kaana deployment');

    await applyPermissionAction({
      deploymentId: deployment.deploymentId,
      action: 'suspend',
      staffUserId,
    });
    await expect(
      setDeploymentRoutingScores({
        deploymentId: deployment.internalRouteId,
        staffUserId,
        scorecard: scorecardFor(deployment.priceVersionId, { balancedScore: null }),
      })
    ).resolves.toBeDefined();
    }
  );
});

describe('the other three transitions', () => {
  it.each(['restrict', 'suspend', 'retire'] as const)(
    '%s takes an approved route back out of the catalogue',
    async (action) => {
      const staffUserId = await insertStaffUser();
      const { deploymentId, modelId, internalRouteId, priceVersionId } =
        await insertProposedRoute();

      await recordLegalReview({
        deploymentId,
        status: 'approved',
        evidenceRef: `contract-register/${suffix()}`,
        reviewerUserId: staffUserId,
      });
      await setDeploymentRoutingScores({
        deploymentId: internalRouteId,
        staffUserId,
        scorecard: scorecardFor(priceVersionId),
      });
      await applyPermissionAction({ deploymentId, action: 'approve', staffUserId });

      // Control: it really was being served, so the assertion below measures
      // the transition rather than a route that was never visible.
      await expect(selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, modelId, UNCONSTRAINED_ROUTING)).resolves.toBeDefined();

      const result = await applyPermissionAction({ deploymentId, action, staffUserId });
      expect(result.permissionState).toBe(ACTION_TARGET_STATE[action]);

      await expect(
        selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, modelId, UNCONSTRAINED_ROUTING)
      ).resolves.toBeUndefined();
      expect(
        (await listCatalogueForViewer(PUBLIC_CATALOGUE_VIEWER)).map((entry) => entry.modelId)
      ).not.toContain(modelId);
    }
  );

  it('keeps a retired route retired', async () => {
    const staffUserId = await insertStaffUser();
    const { deploymentId } = await insertProposedRoute();

    await recordLegalReview({
      deploymentId,
      status: 'approved',
      evidenceRef: `contract-register/${suffix()}`,
      reviewerUserId: staffUserId,
    });
    await applyPermissionAction({ deploymentId, action: 'retire', staffUserId });

    await expect(
      applyPermissionAction({ deploymentId, action: 'approve', staffUserId })
    ).rejects.toBeInstanceOf(DeploymentPermissionRefused);
  });

  it('records who moved the state and when', async () => {
    const staffUserId = await insertStaffUser();
    const { deploymentId } = await insertProposedRoute();

    await applyPermissionAction({
      deploymentId,
      action: 'suspend',
      staffUserId,
      note: 'Provider incident 2026-08-15',
    });

    const [row] = await getDb()
      .select({
        changedBy: inferenceDeployments.permissionStateChangedByUserId,
        changedAt: inferenceDeployments.permissionStateChangedAt,
        note: inferenceDeployments.permissionStateNote,
      })
      .from(inferenceDeployments)
      .where(eq(inferenceDeployments.id, deploymentId));

    expect(row.changedBy).toBe(staffUserId);
    expect(row.changedAt).toBeInstanceOf(Date);
    expect(row.note).toBe('Provider incident 2026-08-15');
  });

  it('names an unknown route rather than silently doing nothing', async () => {
    await expect(
      applyPermissionAction({
        deploymentId: `missing-${suffix()}`,
        action: 'suspend',
        staffUserId: await insertStaffUser(),
      })
    ).rejects.toBeInstanceOf(DeploymentNotFoundError);
  });
});

describe('the action → state map', () => {
  it('covers every action and never lands back on the default', () => {
    // A transition that walked a route back to `pending_review` would be
    // indistinguishable from never having reviewed it, which is the one state
    // this workflow must not be able to forge.
    expect(Object.keys(ACTION_TARGET_STATE).sort()).toEqual([...DEPLOYMENT_PERMISSION_ACTIONS].sort());
    expect(Object.values(ACTION_TARGET_STATE)).not.toContain('pending_review');
  });
});
