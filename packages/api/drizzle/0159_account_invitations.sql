-- oxy:deploy-phase=pre
-- Additive invitation records; existing clients never read this table.
CREATE TABLE "account_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"inherit" boolean DEFAULT true NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "account_invitations_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "account_invitations_role_check" CHECK ("account_invitations"."role" in ('admin', 'editor', 'developer', 'billing', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_invitations_account_id_idx" ON "account_invitations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "account_invitations_expires_at_idx" ON "account_invitations" USING btree ("expires_at");