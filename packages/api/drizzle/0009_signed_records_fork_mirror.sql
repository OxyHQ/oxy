-- oxy:deploy-phase=pre
-- Additive; safe while the previous image serves. See src/db/migrationPhases.ts.

-- Relax `signed_records_chain_completeness_check` so a v2 record can be stored
-- OFF the linear chain.
--
-- The original constraint required the four v2 fields together: `seq`,
-- `record_id`, `nsid`, `rkey`. That made the FORK MIRROR unrepresentable.
--
-- A genuine fork is an envelope the subject really signed whose `seq` is already
-- taken on Oxy's chain — the unique `(user_id, seq)` index exists to reject
-- exactly that. `nodeSync.service.storeForkMirror` therefore preserves the
-- authentic forked envelope with its content address and record key but WITHOUT
-- a `seq`, so both branches persist and the linear chain is untouched. It cannot
-- drop `record_id` (five tables plus `node_ingest_witnesses` reference it, and it
-- is what makes a re-pull idempotent) nor `nsid`/`rkey` (they are how the fork
-- wins last-writer-wins materialization for its key). Under the old constraint
-- every fork insert raised `23514` and the whole append-only fork-preservation
-- guarantee was dead code.
--
-- `seq` therefore becomes what it always meant: the marker for "this row is ON
-- the linear chain". Everything the old constraint rejected is still rejected —
-- a `seq` without an address (the shape `signedRecords.test.ts` pins), and any
-- partial v2 triple.

ALTER TABLE "signed_records" DROP CONSTRAINT "signed_records_chain_completeness_check";--> statement-breakpoint
ALTER TABLE "signed_records" ADD CONSTRAINT "signed_records_chain_completeness_check" CHECK (("signed_records"."seq" is null and "signed_records"."record_id" is null and "signed_records"."nsid" is null and "signed_records"."rkey" is null) or ("signed_records"."record_id" is not null and "signed_records"."nsid" is not null and "signed_records"."rkey" is not null));
