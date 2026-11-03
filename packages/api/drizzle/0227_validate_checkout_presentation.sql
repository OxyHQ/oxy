-- oxy:deploy-phase=pre
ALTER TABLE "personal_plan_checkout_intents" VALIDATE CONSTRAINT "personal_plan_checkout_intents_product_id_access_products_id_fk";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" VALIDATE CONSTRAINT "personal_checkout_presentation";
