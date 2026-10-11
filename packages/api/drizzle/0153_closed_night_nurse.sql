-- oxy:deploy-phase=pre
ALTER TABLE "personal_plan_checkout_intents" ADD COLUMN "provider_session_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD COLUMN "application_ref" text;--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD COLUMN "plan_ref" text;--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD COLUMN "customer_ref" text;--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD COLUMN "tax_quote_authority" text;--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD COLUMN "initial_invoice_id" text;