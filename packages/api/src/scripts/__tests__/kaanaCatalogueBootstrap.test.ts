/**
 * The reviewed catalogue bootstrap against a REAL Postgres, over the state
 * production holds: the three gpt-oss routes written by the first bootstrap
 * still store `availability_scope = internal_alia` (the storage rename's
 * backfill has not run) and carry the approval note written on 2026-09-02.
 *
 * A dry run over that state must plan exactly the speech inserts, and must not
 * rewrite a stored text route. Identities are synthetic copies of the reviewed
 * catalogues so the suite cannot collide with rows another suite committed in
 * the same worker database; every reviewed FACT is the real one.
 */

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  KAANA_SPEECH_CATALOGUE,
  KAANA_TEXT_CATALOGUE,
  type KaanaInitialProvider,
  type KaanaReviewedModelCatalogue,
  kaanaReviewedCatalogueOperations,
} from "../../config/kaanaInitialCatalogue";
import { closePostgres, connectPostgres, getDb } from "../../config/postgres";
import { inferenceDeployments, users } from "../../db/schema";

type BootstrapWriter = typeof import("../../../scripts/bootstrap-kaana-catalogue");
type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** The bytes the 2026-09-02 bootstrap wrote on the Cerebras and Groq routes. */
const PRODUCTION_TEXT_NOTE =
  "Owner-approved initial internal Alia route; primary-source review 2026-09-02.";

const ENVIRONMENT = [
  "KAANA_CATALOGUE_REVIEWER_USER_ID",
  "INFERENCE_ROUTING_SCORE_MIN_VALIDITY_SECONDS",
] as const;
const ORIGINAL_ENVIRONMENT = Object.fromEntries(
  ENVIRONMENT.map((key) => [key, process.env[key]]),
);

let writer: BootstrapWriter;

class Rollback extends Error {}

function suffix(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

/**
 * The reviewed catalogue under fresh identities. Scorecard validity is moved
 * far out so the proof does not expire with the reviewed 2026-11-01 horizon;
 * nothing else about the reviewed facts changes.
 */
function synthetic(catalogue: KaanaReviewedModelCatalogue): KaanaReviewedModelCatalogue {
  const id = suffix();
  const publisherSlug = `${catalogue.publisher.slug}-${id}`;
  const modelId = `${publisherSlug}/${catalogue.model.slug}`;
  return {
    ...catalogue,
    publisher: { ...catalogue.publisher, slug: publisherSlug },
    model: { ...catalogue.model, publisherSlug } as KaanaReviewedModelCatalogue["model"],
    modelId,
    modelReference: `${modelId}@${catalogue.revision.revision}`,
    providers: catalogue.providers.map(
      (provider): KaanaInitialProvider => ({
        ...provider,
        slug: `${provider.slug}-${id}` as KaanaInitialProvider["slug"],
        deploymentId: `${provider.deploymentId}_${id}`,
        scoreValidUntil: "2099-01-01T00:00:00.000Z",
      }),
    ),
    routingProfiles: catalogue.routingProfiles.map((profile) => ({
      ...profile,
      id: randomUUID(),
      slug: `${profile.slug}-${id}`,
    })),
  };
}

/** Run inside one transaction that always rolls back, as the dry run does. */
async function rolledBack(work: (tx: Transaction) => Promise<void>): Promise<void> {
  try {
    await getDb().transaction(async (tx) => {
      await work(tx);
      throw new Rollback("rollback");
    });
  } catch (error) {
    // Anything but the deliberate rollback is the test's real failure.
    if (error instanceof Rollback) return;
    throw error;
  }
  throw new Error("The test transaction committed instead of rolling back");
}

/** Write the text catalogue, then put it in the state production holds. */
async function seedProductionText(
  tx: Transaction,
  text: KaanaReviewedModelCatalogue,
): Promise<void> {
  await writer.ensureCatalogue(tx, text, []);
  for (const provider of text.providers) {
    await tx
      .update(inferenceDeployments)
      .set({
        // Legacy storage bytes; the contract type no longer names them.
        availabilityScope: "internal_alia" as "platform_internal",
        permissionStateNote: provider.permissionStateNote ?? PRODUCTION_TEXT_NOTE,
      })
      .where(eq(inferenceDeployments.internalRouteId, provider.deploymentId));
  }
}

async function storedScopes(
  tx: Transaction,
  catalogue: KaanaReviewedModelCatalogue,
): Promise<string[]> {
  const rows = await tx
    .select({
      id: inferenceDeployments.internalRouteId,
      scope: inferenceDeployments.availabilityScope,
    })
    .from(inferenceDeployments)
    .where(
      inArray(
        inferenceDeployments.internalRouteId,
        catalogue.providers.map((provider) => provider.deploymentId),
      ),
    );
  return catalogue.providers.map(
    (provider) => rows.find((row) => row.id === provider.deploymentId)?.scope ?? "absent",
  );
}

beforeAll(async () => {
  await connectPostgres();
  const [reviewer] = await getDb()
    .insert(users)
    .values({
      username: `kaana-bootstrap-${suffix()}`,
      isStaff: true,
      staffCapabilities: ["inference:catalogue:publish"],
    })
    .returning({ id: users.id });
  process.env.KAANA_CATALOGUE_REVIEWER_USER_ID = reviewer.id;
  process.env.INFERENCE_ROUTING_SCORE_MIN_VALIDITY_SECONDS = "3600";
  // The writer binds its reviewer when it loads, exactly as the one-shot does.
  writer = await import("../../../scripts/bootstrap-kaana-catalogue");
});

afterAll(async () => {
  for (const [key, value] of Object.entries(ORIGINAL_ENVIRONMENT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await closePostgres();
});

describe("the reviewed catalogue bootstrap over production's legacy-scope text routes", () => {
  it("plans only the speech inserts and leaves every stored text route untouched", async () => {
    const text = synthetic(KAANA_TEXT_CATALOGUE);
    const speech = synthetic(KAANA_SPEECH_CATALOGUE);
    await rolledBack(async (tx) => {
      await seedProductionText(tx, text);
      expect(await storedScopes(tx, text)).toEqual(
        text.providers.map(() => "internal_alia"),
      );

      const inserted: string[] = [];
      await writer.requireReviewer(tx);
      await writer.ensureCatalogue(tx, text, inserted);
      await writer.ensureCatalogue(tx, speech, inserted);

      expect(inserted).toEqual(kaanaReviewedCatalogueOperations(speech));
      // Compared as the scope it means, never rewritten.
      expect(await storedScopes(tx, text)).toEqual(
        text.providers.map(() => "internal_alia"),
      );
      // A new route is written in the current vocabulary only.
      expect(await storedScopes(tx, speech)).toEqual(["platform_internal"]);
    });
  });

  it("is a no-op once the speech route exists beside the legacy text routes", async () => {
    const text = synthetic(KAANA_TEXT_CATALOGUE);
    const speech = synthetic(KAANA_SPEECH_CATALOGUE);
    await rolledBack(async (tx) => {
      await seedProductionText(tx, text);
      await writer.ensureCatalogue(tx, speech, []);

      const inserted: string[] = [];
      await writer.ensureCatalogue(tx, text, inserted);
      await writer.ensureCatalogue(tx, speech, inserted);
      expect(inserted).toEqual([]);
    });
  });

  it("still refuses a text route stored under any other scope", async () => {
    const text = synthetic(KAANA_TEXT_CATALOGUE);
    const [first] = text.providers;
    await rolledBack(async (tx) => {
      await seedProductionText(tx, text);
      await tx
        .update(inferenceDeployments)
        .set({ availabilityScope: "enterprise" })
        .where(eq(inferenceDeployments.internalRouteId, first.deploymentId));

      await expect(writer.ensureCatalogue(tx, text, [])).rejects.toThrow(
        `deployment:${first.deploymentId}.availabilityScope differs from the reviewed bootstrap: expected "platform_internal", found "enterprise"`,
      );
    });
  });

  it("still refuses a text route whose approval note drifted", async () => {
    const text = synthetic(KAANA_TEXT_CATALOGUE);
    const [first] = text.providers;
    await rolledBack(async (tx) => {
      await seedProductionText(tx, text);
      await tx
        .update(inferenceDeployments)
        .set({ permissionStateNote: "Owner-approved initial platform-internal route." })
        .where(eq(inferenceDeployments.internalRouteId, first.deploymentId));

      await expect(writer.ensureCatalogue(tx, text, [])).rejects.toThrow(
        `deployment:${first.deploymentId}.permissionStateNote differs from the reviewed bootstrap`,
      );
    });
  });
});
