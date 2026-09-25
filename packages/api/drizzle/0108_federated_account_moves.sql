-- oxy:deploy-phase=pre
-- The audit and idempotency record of applied ActivityPub Moves
-- (POST /federation/move). A new table nothing in the previous image reads or
-- writes, so it is safe ahead of the rollout.
CREATE TABLE "federated_account_moves" (
	"id" text PRIMARY KEY NOT NULL,
	"activity_id" text NOT NULL,
	"old_actor_uri" text NOT NULL,
	"target_actor_uri" text NOT NULL,
	"old_user_id" text,
	"target_user_id" text NOT NULL,
	"requested_by_application_id" text,
	"followers_moved" integer DEFAULT 0 NOT NULL,
	"already_following" integer DEFAULT 0 NOT NULL,
	"skipped_blocked" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "federated_account_moves_counts_check" CHECK ("federated_account_moves"."followers_moved" >= 0 and "federated_account_moves"."already_following" >= 0 and "federated_account_moves"."skipped_blocked" >= 0)
);
--> statement-breakpoint
ALTER TABLE "federated_account_moves" ADD CONSTRAINT "federated_account_moves_old_user_id_users_id_fk" FOREIGN KEY ("old_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federated_account_moves" ADD CONSTRAINT "federated_account_moves_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federated_account_moves" ADD CONSTRAINT "federated_account_moves_requested_by_application_id_applications_id_fk" FOREIGN KEY ("requested_by_application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federated_account_moves_activity_id_key" ON "federated_account_moves" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "federated_account_moves_target_user_id_idx" ON "federated_account_moves" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "federated_account_moves_old_user_id_idx" ON "federated_account_moves" USING btree ("old_user_id");