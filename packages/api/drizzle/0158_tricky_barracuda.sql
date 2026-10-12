-- oxy:deploy-phase=pre
ALTER TABLE "personal_plan_checkout_intents" ADD COLUMN "dispatch_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD CONSTRAINT "personal_checkout_dispatch_state" CHECK ("personal_plan_checkout_intents"."dispatch_claimed_at" is null or "personal_plan_checkout_intents"."state" <> 'reserved');