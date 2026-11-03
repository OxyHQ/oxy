-- oxy:deploy-phase=pre
ALTER TABLE "personal_plan_checkout_intents" ADD COLUMN "tax_quote_schema_version" integer DEFAULT 1 NOT NULL;