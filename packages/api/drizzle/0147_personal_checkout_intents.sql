-- oxy:deploy-phase=pre
CREATE TABLE "personal_plan_checkout_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_account_id" text NOT NULL,
	"mode" text NOT NULL,
	"environment" text NOT NULL,
	"idempotency_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"offer_id" text NOT NULL,
	"offer_version" integer NOT NULL,
	"provider_account_ref" text NOT NULL,
	"price_id" text NOT NULL,
	"selection" jsonb NOT NULL,
	"state" text NOT NULL,
	"closed_reason" text,
	"provider_session_id" text,
	"checkout_url" text,
	"fulfilled_source_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "personal_checkout_namespace" CHECK (("personal_plan_checkout_intents"."mode" = 'live' and "personal_plan_checkout_intents"."environment" = 'production') or ("personal_plan_checkout_intents"."mode" = 'test' and "personal_plan_checkout_intents"."environment" in ('test', 'staging', 'development'))),
	CONSTRAINT "personal_checkout_state" CHECK ("personal_plan_checkout_intents"."state" in ('reserved', 'pending', 'fulfilled', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD CONSTRAINT "personal_plan_checkout_intents_subject_account_id_users_id_fk" FOREIGN KEY ("subject_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "personal_checkout_request_key" ON "personal_plan_checkout_intents" USING btree ("subject_account_id","mode","environment","idempotency_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_checkout_pending_subject" ON "personal_plan_checkout_intents" USING btree ("subject_account_id","mode","environment") WHERE "personal_plan_checkout_intents"."state" in ('reserved', 'pending');