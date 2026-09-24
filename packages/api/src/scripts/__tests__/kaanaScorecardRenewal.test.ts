/**
 * Same-value scorecard renewal against a REAL Postgres: the renewal may move
 * only the exact superseded state forward, records one immutable event, is a
 * no-op on rerun, and refuses every other state without writing.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  KAANA_INITIAL_PROVIDERS,
  KAANA_INITIAL_SCORE_VALID_UNTIL,
  type KaanaInitialProvider,
  kaanaCurrentScorecardReview,
} from "../../config/kaanaInitialCatalogue";
import { closePostgres, connectPostgres, getDb } from "../../config/postgres";
import {
  inferenceDeploymentRoutingScoreEvents,
  inferenceDeploymentRoutingScores,
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
  priceVersions,
} from "../../db/schema";
import {
  createKaanaScorecardRenewalPlanSha256,
  decideKaanaScorecardRenewal,
  kaanaReviewedScorecardFields,
  kaanaScorecardRenewalOperations,
  renewKaanaRoutingScorecards,
} from "../kaanaScorecardRenewal";

const REVIEWER = "6981c9178fcdefaf81988ffb";
const MINIMUM_VALID_UNTIL = new Date("2026-09-25T00:00:00.000Z");

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

function suffix(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

/** A synthetic copy of a reviewed provider with its own exact identity. */
function syntheticProvider(base: KaanaInitialProvider): KaanaInitialProvider {
  return { ...base, deploymentId: `dep_renewal_fixture_${suffix()}` };
}

async function seedDeployment(provider: KaanaInitialProvider): Promise<string> {
  const db = getDb();
  const publisherSlug = `pub${suffix()}`;
  const providerSlug = `prv${suffix()}`;
  await db
    .insert(inferencePublishers)
    .values({ slug: publisherSlug, displayName: "Fixture Pub" });
  const [model] = await db
    .insert(inferenceModels)
    .values({
      publisherSlug,
      slug: `mdl${suffix()}`,
      displayName: "Fixture Model",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsTools: false,
      supportsParallelToolCalls: false,
      supportsStructuredOutput: false,
      supportsJsonMode: false,
      supportsReasoning: false,
      supportsStreaming: true,
      supportsPromptCaching: false,
      maxContextTokens: 8192,
      maxOutputTokens: 1024,
      licenseId: "apache-2.0",
      licenseDisplayName: "Apache 2.0",
      commercialUseAllowed: true,
      requiresAttribution: false,
      releaseKind: "open_weight",
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
    displayName: "Fixture Provider",
    kind: "third_party",
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
  });
  if (model.modelId === null) throw new Error("model id did not compose");
  const [priceVersion] = await db
    .insert(priceVersions)
    .values({
      modelReference: `${model.modelId}@${revisionName}`,
      provider: providerSlug,
      status: "active",
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
    availabilityScope: "platform_internal",
    commercialPermission: "standard_application_use",
    status: "active",
    internalRouteId: provider.deploymentId,
    priceVersionId: priceVersion.id,
  });
  return priceVersion.id;
}

/** Write the superseded state exactly as the original bootstrap did. */
async function seedSupersededScorecard(
  provider: KaanaInitialProvider,
  priceVersionId: string,
  overrides: { balancedScore?: number; withEvent?: boolean } = {},
): Promise<void> {
  const renewal = provider.scoreRenewal;
  if (renewal === undefined) throw new Error("fixture provider has no renewal");
  const superseded = kaanaReviewedScorecardFields(provider, renewal.supersedes, {
    priceVersionId,
    reviewerUserId: REVIEWER,
  });
  const row = {
    ...superseded,
    fundingClass: superseded.fundingClass,
    fundingState: superseded.fundingState,
    fundingEvidenceRef: superseded.fundingEvidenceRef,
    balancedScore: overrides.balancedScore ?? superseded.balancedScore,
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

describe("the reviewed scorecard renewal config", () => {
  it("renews every reviewed route to the same new validity with unchanged scores", () => {
    for (const provider of KAANA_INITIAL_PROVIDERS) {
      const review = kaanaCurrentScorecardReview(provider);
      expect(review.validUntil).toBe(KAANA_INITIAL_SCORE_VALID_UNTIL);
      expect(review.validUntil).toBe("2026-11-01T00:00:00.000Z");
      expect(review.changedAt).toBe("2026-09-24T00:00:00.000Z");
      expect(provider.scoreRenewal?.supersedes.validUntil).toBe(
        provider.slug === "openrouter"
          ? "2026-10-11T00:00:00.000Z"
          : "2026-10-02T00:00:00.000Z",
      );
      expect(
        Date.parse(provider.scoreRenewal?.supersedes.changedAt ?? ""),
      ).toBeLessThan(Date.parse(review.changedAt));
    }
  });

  it("changes only validity, reason, reviewer and changedAt between the two states", () => {
    for (const provider of KAANA_INITIAL_PROVIDERS) {
      const renewal = provider.scoreRenewal;
      if (renewal === undefined) throw new Error("missing renewal");
      const bindings = { priceVersionId: "price_exact", reviewerUserId: REVIEWER };
      const current = kaanaReviewedScorecardFields(
        provider,
        kaanaCurrentScorecardReview(provider),
        bindings,
      );
      const superseded = kaanaReviewedScorecardFields(
        provider,
        renewal.supersedes,
        bindings,
      );
      const changed = Object.keys(current).filter(
        (key) =>
          JSON.stringify(current[key as keyof typeof current]) !==
          JSON.stringify(superseded[key as keyof typeof superseded]),
      );
      expect(changed.sort()).toEqual(
        [
          "balancedValidUntil",
          "changedAt",
          "latencyValidUntil",
          "reason",
          "throughputValidUntil",
        ].sort(),
      );
    }
  });
});

describe("decideKaanaScorecardRenewal", () => {
  const current = { balancedScore: 800, balancedValidUntil: new Date("2026-11-01") };
  const superseded = { balancedScore: 800, balancedValidUntil: new Date("2026-10-02") };

  it("classifies current, renewable and drifted rows", () => {
    expect(decideKaanaScorecardRenewal(current, current, superseded)).toEqual({
      action: "current",
    });
    expect(decideKaanaScorecardRenewal(superseded, current, superseded)).toEqual({
      action: "renew",
    });
    expect(
      decideKaanaScorecardRenewal(
        { ...superseded, balancedScore: 900 },
        current,
        superseded,
      ),
    ).toEqual({ action: "drift", fields: ["balancedScore", "balancedValidUntil"] });
    expect(decideKaanaScorecardRenewal(superseded, current, undefined)).toEqual({
      action: "drift",
      fields: ["balancedValidUntil"],
    });
  });

  it("binds the plan hash to every outcome", () => {
    const outcome = {
      deploymentId: "dep_exact",
      action: "renew" as const,
      fromValidUntil: "2026-10-02T00:00:00.000Z",
      toValidUntil: "2026-11-01T00:00:00.000Z",
      toChangedAt: "2026-09-24T00:00:00.000Z",
    };
    const hash = createKaanaScorecardRenewalPlanSha256({
      reviewerUserId: REVIEWER,
      outcomes: [outcome],
    });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      createKaanaScorecardRenewalPlanSha256({
        reviewerUserId: REVIEWER,
        outcomes: [{ ...outcome, action: "current" }],
      }),
    ).not.toBe(hash);
    expect(kaanaScorecardRenewalOperations([outcome])).toEqual([
      "scorecard-renewal:dep_exact",
    ]);
    expect(
      kaanaScorecardRenewalOperations([{ ...outcome, action: "current" }]),
    ).toEqual([]);
  });
});

describe("renewKaanaRoutingScorecards against Postgres", () => {
  it("renews the exact superseded row once, appends one event and is idempotent", async () => {
    const provider = syntheticProvider(KAANA_INITIAL_PROVIDERS[0]);
    const priceVersionId = await seedDeployment(provider);
    await seedSupersededScorecard(provider, priceVersionId);

    const [renewed] = await renewInTransaction([provider]);
    expect(renewed).toEqual({
      deploymentId: provider.deploymentId,
      action: "renew",
      fromValidUntil: "2026-10-02T00:00:00.000Z",
      toValidUntil: "2026-11-01T00:00:00.000Z",
      toChangedAt: "2026-09-24T00:00:00.000Z",
    });

    const row = await readRow(provider.deploymentId);
    expect(row.balancedValidUntil.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(row.latencyValidUntil.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(row.throughputValidUntil.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(row.changedAt.toISOString()).toBe("2026-09-24T00:00:00.000Z");
    expect(row.balancedScore).toBe(provider.scores.balanced);
    expect(row.latencyMeasurementWindowEnd.toISOString()).toBe(
      "2026-09-02T00:00:00.000Z",
    );
    expect(await countEvents(provider.deploymentId)).toBe(2);
    expect(
      await countEvents(provider.deploymentId, new Date("2026-09-24T00:00:00.000Z")),
    ).toBe(1);

    const [again] = await renewInTransaction([provider]);
    expect(again.action).toBe("current");
    expect(await countEvents(provider.deploymentId)).toBe(2);
  });

  it("refuses a drifted row without writing anything", async () => {
    const provider = syntheticProvider(KAANA_INITIAL_PROVIDERS[1]);
    const priceVersionId = await seedDeployment(provider);
    await seedSupersededScorecard(provider, priceVersionId, { balancedScore: 1 });

    await expect(renewInTransaction([provider])).rejects.toThrow(
      /matches neither its renewed nor its superseded reviewed state.*balancedScore/,
    );
    const row = await readRow(provider.deploymentId);
    expect(row.balancedValidUntil.toISOString()).toBe("2026-10-02T00:00:00.000Z");
    expect(await countEvents(provider.deploymentId)).toBe(1);
  });

  it("refuses to renew a superseded row that has no audited provenance event", async () => {
    const provider = syntheticProvider(KAANA_INITIAL_PROVIDERS[2]);
    const priceVersionId = await seedDeployment(provider);
    await seedSupersededScorecard(provider, priceVersionId, { withEvent: false });

    await expect(renewInTransaction([provider])).rejects.toThrow(
      /exactly one append-only provenance event; found 0/,
    );
    const row = await readRow(provider.deploymentId);
    expect(row.balancedValidUntil.toISOString()).toBe("2026-10-11T00:00:00.000Z");
  });

  it("refuses a renewed validity that does not cover the minimum horizon", async () => {
    const provider = syntheticProvider(KAANA_INITIAL_PROVIDERS[0]);
    await expect(
      getDb().transaction((tx) =>
        renewKaanaRoutingScorecards(tx, {
          providers: [provider],
          reviewerUserId: REVIEWER,
          minimumValidUntil: new Date("2026-11-01T00:00:00.001Z"),
        }),
      ),
    ).rejects.toThrow(/does not cover the configured minimum validity horizon/);
  });
});
