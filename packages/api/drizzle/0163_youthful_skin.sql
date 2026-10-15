-- oxy:deploy-phase=pre
ALTER TABLE "access_grants" DROP CONSTRAINT "access_grants_segment_benefit_key";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD COLUMN "billing_interval" text DEFAULT 'month' NOT NULL;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_segment_benefit_key" UNIQUE("source_segment_id","benefit_index","period_start");--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD CONSTRAINT "personal_checkout_interval" CHECK ("personal_plan_checkout_intents"."billing_interval" IN ('month', 'year') AND ("personal_plan_checkout_intents"."price_kind" <> 'oxy_one' OR "personal_plan_checkout_intents"."billing_interval" = 'month'));