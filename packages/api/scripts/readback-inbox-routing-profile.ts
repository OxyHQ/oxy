import { eq, sql } from "drizzle-orm";
import { closePostgres, connectPostgres, getDb } from "../src/config/postgres";
import {
  inferenceModelRevisions,
  inferenceModels,
  inferenceRoutingProfileCandidates,
  inferenceRoutingProfiles,
} from "../src/db/schema";
import {
  InboxRoutingProfileReadbackError,
  validateInboxRoutingProfileReadback,
} from "../src/scripts/inboxRoutingProfileReadback";

const RESULT_PREFIX = "INBOX_ROUTING_PROFILE_READBACK_RESULT=";

async function readback(): Promise<void> {
  const requestedRoutingProfileId =
    process.env.INBOX_ROUTING_PROFILE_READBACK_ID ?? "";

  await connectPostgres();
  try {
    const result = await getDb().transaction(async (tx) => {
      // This must be the first transaction statement. PostgreSQL then refuses
      // every write independently of application intent for the full readback.
      await tx.execute(sql`set transaction read only`);
      const readOnlyRows = await tx.execute<{ transaction_read_only: string }>(
        sql`show transaction_read_only`,
      );
      const transactionReadOnly =
        readOnlyRows.length === 1 &&
        readOnlyRows[0]?.transaction_read_only === "on";

      const profiles = await tx
        .select({
          id: inferenceRoutingProfiles.id,
          slug: inferenceRoutingProfiles.slug,
          displayName: inferenceRoutingProfiles.displayName,
          description: inferenceRoutingProfiles.description,
          optimiseFor: inferenceRoutingProfiles.optimiseFor,
          isProductPreset: inferenceRoutingProfiles.isProductPreset,
        })
        .from(inferenceRoutingProfiles)
        .where(eq(inferenceRoutingProfiles.id, requestedRoutingProfileId));

      const candidateRows = await tx
        .select({
          routingProfileId: inferenceRoutingProfileCandidates.routingProfileId,
          modelId: inferenceModels.modelId,
          revision: inferenceModelRevisions.revision,
          priority: inferenceRoutingProfileCandidates.priority,
        })
        .from(inferenceRoutingProfileCandidates)
        .leftJoin(
          inferenceModelRevisions,
          eq(
            inferenceRoutingProfileCandidates.modelRevisionId,
            inferenceModelRevisions.id,
          ),
        )
        .leftJoin(
          inferenceModels,
          eq(inferenceModelRevisions.modelId, inferenceModels.id),
        )
        .where(
          eq(
            inferenceRoutingProfileCandidates.routingProfileId,
            requestedRoutingProfileId,
          ),
        );
      const candidates = candidateRows.map((candidate) => ({
        routingProfileId: candidate.routingProfileId,
        modelReference:
          candidate.modelId === null || candidate.revision === null
            ? null
            : `${candidate.modelId}@${candidate.revision}`,
        priority: candidate.priority,
      }));

      return validateInboxRoutingProfileReadback({
        requestedRoutingProfileId,
        transactionReadOnly,
        profiles,
        candidates,
      });
    });

    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
  } finally {
    await closePostgres();
  }
}

void readback().catch((error: unknown) => {
  const message =
    error instanceof InboxRoutingProfileReadbackError
      ? error.message
      : "Unexpected PostgreSQL readback failure";
  process.stderr.write(`Inbox routing-profile readback failed: ${message}\n`);
  process.exitCode = 1;
});
