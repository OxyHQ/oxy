-- oxy:deploy-phase=pre
-- Storage deletes owed for a deleted account's uploads (OxyHQ/Mention#1178): a
-- new table nothing in the running image reads or writes. Additive only, so it
-- is safe ahead of the rollout; `post` would leave the new image's
-- DELETE /users/me writing to a table that does not exist yet.
CREATE TABLE "storage_object_deletions" (
	"id" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"sha256" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"completed_at" timestamp with time zone,
	"outcome" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "storage_object_deletions_account_id_kind_target_key" UNIQUE("account_id","kind","target"),
	CONSTRAINT "storage_object_deletions_reason_check" CHECK ("storage_object_deletions"."reason" in ('account.deleted')),
	CONSTRAINT "storage_object_deletions_kind_check" CHECK ("storage_object_deletions"."kind" in ('object', 'prefix')),
	CONSTRAINT "storage_object_deletions_outcome_check" CHECK ("storage_object_deletions"."outcome" is null or "storage_object_deletions"."outcome" in ('deleted', 'retained_shared')),
	CONSTRAINT "storage_object_deletions_completed_check" CHECK (("storage_object_deletions"."completed_at" is null) = ("storage_object_deletions"."outcome" is null)),
	CONSTRAINT "storage_object_deletions_attempts_check" CHECK ("storage_object_deletions"."attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX "storage_object_deletions_due_idx" ON "storage_object_deletions" USING btree ("next_attempt_at") WHERE "storage_object_deletions"."completed_at" is null;--> statement-breakpoint
CREATE INDEX "storage_object_deletions_completed_at_idx" ON "storage_object_deletions" USING btree ("completed_at");