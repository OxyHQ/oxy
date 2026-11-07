-- oxy:deploy-phase=pre
-- A person who deleted their encrypted identity backup, recorded on the account
-- so no device re-uploads one without their choice (owner's decision,
-- 2026-11-07). A new table: additive, and no lock on an existing one beyond the
-- foreign key's brief one on `users` (as 0235).
CREATE TABLE "identity_backup_opt_outs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"opted_out_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "identity_backup_opt_outs_user_id_key" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "identity_backup_opt_outs" ADD CONSTRAINT "identity_backup_opt_outs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;