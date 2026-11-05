-- oxy:deploy-phase=pre
-- Personal checkout binds to Orbit's native objects: Orbit prices and taxes the
-- order, so no signed tax quote is frozen. Both images satisfy the new CHECK (the
-- old one writes the three binding columns with the rest); 0230 drops the rest.
ALTER TABLE "personal_plan_checkout_intents" DROP CONSTRAINT "personal_checkout_authority_complete";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP CONSTRAINT "personal_checkout_quote_amounts";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP CONSTRAINT "personal_checkout_quote_timestamps";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP CONSTRAINT "personal_checkout_quote_country";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD CONSTRAINT "personal_checkout_binding_complete" CHECK (("personal_plan_checkout_intents"."application_ref" is null and "personal_plan_checkout_intents"."customer_ref" is null and "personal_plan_checkout_intents"."return_url" is null) or ("personal_plan_checkout_intents"."application_ref" is not null and "personal_plan_checkout_intents"."customer_ref" is not null and "personal_plan_checkout_intents"."return_url" is not null));