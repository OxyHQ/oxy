-- oxy:deploy-phase=pre
CREATE TABLE "organization_identity_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text,
	"public_key" text NOT NULL,
	"method" text NOT NULL,
	"linked_by_user_id" text,
	"previous_key_proven" boolean DEFAULT false NOT NULL,
	"linked_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "organization_identity_keys_public_key_key" UNIQUE("public_key"),
	CONSTRAINT "organization_identity_keys_method_check" CHECK ("organization_identity_keys"."method" in ('create', 'replace')),
	CONSTRAINT "organization_identity_keys_public_key_check" CHECK ("organization_identity_keys"."public_key" ~ '^04[0-9a-f]{128}$'),
	CONSTRAINT "organization_identity_keys_previous_key_proven_check" CHECK ("organization_identity_keys"."method" = 'replace' or not "organization_identity_keys"."previous_key_proven")
);
--> statement-breakpoint
ALTER TABLE "organization_identity_keys" ADD CONSTRAINT "organization_identity_keys_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_identity_keys" ADD CONSTRAINT "organization_identity_keys_linked_by_user_id_users_id_fk" FOREIGN KEY ("linked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_identity_keys_current_key" ON "organization_identity_keys" USING btree ("account_id") WHERE "organization_identity_keys"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "organization_identity_keys_account_id_idx" ON "organization_identity_keys" USING btree ("account_id","linked_at");--> statement-breakpoint
CREATE INDEX "organization_identity_keys_linked_by_user_id_idx" ON "organization_identity_keys" USING btree ("linked_by_user_id");