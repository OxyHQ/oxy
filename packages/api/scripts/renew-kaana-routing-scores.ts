#!/usr/bin/env bun
/**
 * Renew the validity of the reviewed Kaana routing scorecards, same values only.
 *
 * Safe by default: without APPLY=1 the complete transaction runs and is rolled
 * back, printing the plan SHA-256 an apply must repeat. Only rows that exactly
 * equal the `scoreRenewal.supersedes` state in
 * `src/config/kaanaInitialCatalogue.ts` are renewed; a row already at the
 * renewed state is a no-op and any other state is refused as drift. Every
 * renewal appends one immutable provenance event.
 *
 * It does not read the Kaana inventory: renewal changes no route identity, and
 * runtime attests every exact deployment ID against Kaana per request anyway.
 *
 * Required env:
 *   DATABASE_URL
 *   KAANA_CATALOGUE_REVIEWER_USER_ID               staff with inference:catalogue:publish
 *   INFERENCE_ROUTING_SCORE_MIN_VALIDITY_SECONDS   renewed validity must cover it
 *
 * Apply additionally requires the exact matching dry-run authorization:
 *   APPLY=1 EXPECTED_PLAN_SHA256=... RENEWAL_ACTOR=... RENEWAL_REASON=...
 *
 * Production runs only through .github/workflows/renew-kaana-routing-scores.yml.
 */

import { sql } from "drizzle-orm";
import { routingScoreValidityThreshold } from "../src/config/inferenceRoutingScoreValidity";
import { KAANA_INITIAL_PROVIDERS } from "../src/config/kaanaInitialCatalogue";
import { closePostgres, connectPostgres, getDb } from "../src/config/postgres";
import { requireKaanaCatalogueBootstrapApplyAuthorization } from "../src/scripts/kaanaCatalogueBootstrapPlan";
import {
  type KaanaScorecardRenewalOutcome,
  createKaanaScorecardRenewalPlanSha256,
  kaanaScorecardRenewalOperations,
  renewKaanaRoutingScorecards,
  requireKaanaCatalogueReviewer,
} from "../src/scripts/kaanaScorecardRenewal";
import { logger } from "../src/utils/logger";

const APPLY = process.env.APPLY === "1";
const RESULT_PREFIX = "KAANA_SCORE_RENEWAL_RESULT=";
// Same namespace as the catalogue bootstrap: the two writers never interleave.
const BOOTSTRAP_LOCK_NAMESPACE = "oxy-kaana-catalogue-bootstrap-v1";
const reviewerUserId = process.env.KAANA_CATALOGUE_REVIEWER_USER_ID ?? "";
const expectedPlanSha256 = process.env.EXPECTED_PLAN_SHA256 ?? "";
const renewalActor = process.env.RENEWAL_ACTOR ?? "";
const renewalReason = process.env.RENEWAL_REASON ?? "";

class DryRunRollback extends Error {}

interface RenewalSummary {
  outcomes: KaanaScorecardRenewalOutcome[];
  operations: string[];
  planSha256: string;
}

async function renew(): Promise<RenewalSummary> {
  const minimumValidUntil = routingScoreValidityThreshold(new Date());
  await connectPostgres();
  let summary: RenewalSummary | undefined;
  try {
    await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${BOOTSTRAP_LOCK_NAMESPACE}, 0))`,
      );
      await requireKaanaCatalogueReviewer(tx, reviewerUserId);
      const outcomes = await renewKaanaRoutingScorecards(tx, {
        providers: KAANA_INITIAL_PROVIDERS,
        reviewerUserId,
        minimumValidUntil,
      });
      if (outcomes.length === 0) {
        throw new Error("No reviewed provider carries a scoreRenewal; nothing to renew");
      }
      const planSha256 = createKaanaScorecardRenewalPlanSha256({
        reviewerUserId,
        outcomes,
      });
      requireKaanaCatalogueBootstrapApplyAuthorization({
        apply: APPLY,
        actualPlanSha256: planSha256,
        expectedPlanSha256,
        actor: renewalActor,
        reason: renewalReason,
      });
      summary = {
        outcomes,
        operations: kaanaScorecardRenewalOperations(outcomes),
        planSha256,
      };
      if (!APPLY) throw new DryRunRollback("dry-run rollback");
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  if (summary === undefined) throw new Error("Renewal transaction produced no summary");
  return summary;
}

renew()
  .then(async (summary) => {
    const result = {
      schemaVersion: 1,
      database: { engine: "postgresql" },
      ...summary,
      applied: APPLY,
    } as const;
    logger.info(
      APPLY ? "Kaana routing score renewal applied" : "Kaana routing score renewal dry run",
      { ...result },
    );
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
    await closePostgres();
  })
  .catch(async (error: unknown) => {
    logger.error(
      "Kaana routing score renewal failed",
      error instanceof Error ? error : new Error(String(error)),
    );
    await closePostgres().catch(() => undefined);
    process.exit(1);
  });
