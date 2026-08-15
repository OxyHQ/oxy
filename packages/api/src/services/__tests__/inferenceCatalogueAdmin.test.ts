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
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
  users,
} from '../../db/schema';
import {
  ACTION_TARGET_STATE,
  applyPermissionAction,
  DEPLOYMENT_PERMISSION_ACTIONS,
  DeploymentNotFoundError,
  DeploymentPermissionRefused,
  recordLegalReview,
} from '../inferenceCatalogueAdmin.service';
import {
  listCatalogueForViewer,
  PUBLIC_CATALOGUE_VIEWER,
  selectRouteForViewer,
} from '../inferenceCatalogue.service';

const CHECK_VIOLATION = '23514';

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
async function insertProposedRoute(): Promise<{ deploymentId: string; modelId: string }> {
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

  const [revision] = await db
    .insert(inferenceModelRevisions)
    .values({ modelId: model.id, revision: `r${suffix()}`, releasedAt: new Date(), isCurrent: true })
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
    })
    .returning({ id: inferenceDeployments.id });

  if (model.modelId === null) throw new Error('the generated model id did not compose');
  return { deploymentId: deployment.id, modelId: model.modelId };
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
      selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, modelId)
    ).resolves.toBeUndefined();
  });

  it('serves the route once reviewed and approved, and not before', async () => {
    const staffUserId = await insertStaffUser();
    const { deploymentId, modelId } = await insertProposedRoute();

    // Before: withheld. This is the "and not before" half, measured rather than
    // assumed, so the case cannot pass on a route that was already visible.
    await expect(
      selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, modelId)
    ).resolves.toBeUndefined();

    await recordLegalReview({
      deploymentId,
      status: 'approved',
      evidenceRef: `contract-register/${suffix()}`,
      reviewerUserId: staffUserId,
    });
    const result = await applyPermissionAction({ deploymentId, action: 'approve', staffUserId });

    expect(result.permissionState).toBe('approved');
    await expect(selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, modelId)).resolves.toBeDefined();
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
});

describe('the other three transitions', () => {
  it.each(['restrict', 'suspend', 'retire'] as const)(
    '%s takes an approved route back out of the catalogue',
    async (action) => {
      const staffUserId = await insertStaffUser();
      const { deploymentId, modelId } = await insertProposedRoute();

      await recordLegalReview({
        deploymentId,
        status: 'approved',
        evidenceRef: `contract-register/${suffix()}`,
        reviewerUserId: staffUserId,
      });
      await applyPermissionAction({ deploymentId, action: 'approve', staffUserId });

      // Control: it really was being served, so the assertion below measures
      // the transition rather than a route that was never visible.
      await expect(selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, modelId)).resolves.toBeDefined();

      const result = await applyPermissionAction({ deploymentId, action, staffUserId });
      expect(result.permissionState).toBe(ACTION_TARGET_STATE[action]);

      await expect(
        selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, modelId)
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
