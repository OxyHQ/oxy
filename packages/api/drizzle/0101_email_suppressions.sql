-- oxy:deploy-phase=pre
-- A new table nothing reads yet. The suppression check and the bounce/complaint
-- ingestion routes arrive with the image that follows, and the previous image
-- never selects from it, so it is safe to apply before the rollout.
CREATE TABLE "email_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"address" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"diagnostic" text,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "email_suppressions_scope_address_key" UNIQUE NULLS NOT DISTINCT("user_id","address"),
	CONSTRAINT "email_suppressions_reason_check" CHECK ("email_suppressions"."reason" in ('bounce_permanent', 'bounce_transient', 'complaint', 'manual')),
	CONSTRAINT "email_suppressions_source_check" CHECK ("email_suppressions"."source" in ('ses', 'brevo', 'smtp', 'manual')),
	CONSTRAINT "email_suppressions_complaint_is_scoped_check" CHECK ("email_suppressions"."reason" <> 'complaint' or "email_suppressions"."user_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_suppressions_address_idx" ON "email_suppressions" USING btree ("address");--> statement-breakpoint
CREATE INDEX "email_suppressions_expires_idx" ON "email_suppressions" USING btree ("expires_at");