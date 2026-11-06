-- oxy:deploy-phase=pre
CREATE TABLE "personal_identity_key_retirements" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"public_key" text NOT NULL,
	"retired_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "personal_identity_key_retirements_public_key_key" UNIQUE("public_key"),
	CONSTRAINT "personal_identity_key_retirements_public_key_check" CHECK ("personal_identity_key_retirements"."public_key" ~ '^04[0-9a-f]{128}$')
);
--> statement-breakpoint
ALTER TABLE "personal_identity_key_retirements" ADD CONSTRAINT "personal_identity_key_retirements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_identity_key_retirements_user_id_idx" ON "personal_identity_key_retirements" USING btree ("user_id","retired_at");