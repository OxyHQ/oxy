-- oxy:deploy-phase=pre
--
-- A failed federated avatar mirror is owed a retry, durably.
--
-- WHY. #1449 made a federated avatar an Oxy file id or NULL. A mirror that
-- failed left NULL and relied on someone resolving that user again to retry it.
-- Nothing guaranteed that: the prod repair (run 36322196708) cleared 880 rows,
-- 842 of them for TRANSIENT reasons (mostly the old 15 s per-origin gap refusing
-- consecutive fetches from cdn.masto.host / files.mastodon.social / pbs.twimg.com),
-- and none were re-queued.
--
--   federation_avatar_retry_at   when the retry sweep owes this user a mirror of
--                                its CURRENT source picture; NULL = nothing owed.
--   federation_avatar_attempts   consecutive failures (backoff input).
--   federation_avatar_failure    last failure reason, for reports.
--
-- PRE, additive: nullable/defaulted columns nothing in the previous image reads,
-- and a partial index over a column that is NULL everywhere but the backfill.
--
-- The trailing UPDATE queues every federated user already left without an avatar
-- by a failed mirror (`federation_last_avatar_fetched_at` is set only by a
-- mirror attempt), so the sweep recovers them without an operator. Idempotent.
ALTER TABLE "users" ADD COLUMN "federation_avatar_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "federation_avatar_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "federation_avatar_failure" text;--> statement-breakpoint
CREATE INDEX "users_federation_avatar_retry_at_idx" ON "users" USING btree ("federation_avatar_retry_at") WHERE "users"."federation_avatar_retry_at" is not null;--> statement-breakpoint
UPDATE "users"
SET "federation_avatar_retry_at" = now(), "federation_avatar_failure" = 'recovery_backfill'
WHERE "type" = 'federated'
  AND "account_status" <> 'archived'
  AND "avatar" IS NULL
  AND "federation_last_avatar_fetched_at" IS NOT NULL
  AND "federation_avatar_retry_at" IS NULL;
