-- oxy:deploy-phase=pre
--
-- PRE despite the DROP INDEX, and the reason is worth stating rather than
-- assuming. `post` exists because drizzle selects COLUMNS by name, so removing
-- one 500s every read the image still serving performs. An index is never named
-- by a query — and `follow_events` has exactly one consumer in the image now
-- live, the INSERT in `followCommand.service.ts`, which this cannot affect.
-- Marking it `post` would be the harmful choice: the arriving image's worker
-- would claim against a table whose claim query has no index until somebody
-- dispatched the second half.
--
-- The five columns are additive and defaulted; the index is REPLACED rather
-- than added beside the old one, because two overlapping partial indexes on one
-- queue table is write amplification for a predicate nothing would use. The
-- narrower predicate exists so a dead-lettered event stops being scanned past:
-- dead letters are by definition the OLDEST unprocessed rows, so under the old
-- predicate every future claim would walk the whole graveyard first.
--
-- DROP + CREATE, not CONCURRENTLY: the migrator runs inside a transaction, and
-- `follow_events` holds only what has been written since 0016 reached
-- production, so the SHARE lock is taken over approximately nothing.
--
-- WHAT `drizzle-kit generate` ALSO EMITTED HERE, AND WHY IT WAS REMOVED
--
-- The generated file additionally contained `CREATE TABLE follow_namespaces`,
-- the namespace foreign key, and all five CHECK constraints — everything 0018
-- and 0019 already do. Both of those were hand-written with no snapshot beside
-- them, so `meta/`'s chain still ended at 0016 and drizzle diffed today's
-- TypeScript schema against a model of the database two migrations stale. Every
-- one of those statements has already been applied, production included;
-- `CREATE TABLE follow_namespaces` would fail outright.
--
-- So the SQL below is only what has NOT been applied, while
-- `meta/0020_snapshot.json` is kept exactly as generated — it is the first
-- snapshot that models 0018 and 0019, and keeping it is what stops the next
-- `generate` proposing them a second time. Snapshot and SQL therefore describe
-- different things deliberately, the same way 0016's header records that its
-- snapshot omits `users.organization_category`. Do not "reconcile" this file by
-- regenerating it; that re-arms the problem.
DROP INDEX "follow_events_pending_idx";--> statement-breakpoint
ALTER TABLE "follow_events" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "follow_events" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "follow_events" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "follow_events" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "follow_events" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE INDEX "follow_events_dead_letter_idx" ON "follow_events" USING btree ("failed_at") WHERE "follow_events"."failed_at" is not null;--> statement-breakpoint
CREATE INDEX "follow_events_pending_idx" ON "follow_events" USING btree ("created_at") WHERE "follow_events"."processed_at" is null and "follow_events"."failed_at" is null;
