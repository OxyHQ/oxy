-- oxy:deploy-phase=pre
ALTER TABLE "personal_plan_checkout_intents" ADD COLUMN "product_id" text;--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD COLUMN "presentation" text DEFAULT 'hosted' NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD CONSTRAINT "personal_plan_checkout_intents_product_id_access_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."access_products"("id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD CONSTRAINT "personal_checkout_presentation" CHECK ("personal_plan_checkout_intents"."presentation" IN ('hosted', 'embedded')) NOT VALID;
