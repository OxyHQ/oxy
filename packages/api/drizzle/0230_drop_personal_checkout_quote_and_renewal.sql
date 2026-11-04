-- oxy:deploy-phase=post
-- The image arriving with native Orbit billing neither reads nor writes these: no
-- signed tax quote is frozen, and a renewal is the subscription's own invoice.
ALTER TABLE "personal_plan_checkout_intents" DROP CONSTRAINT "personal_plan_checkout_intents_renewal_source_id_access_subscription_sources_id_fk";
--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "renewal_source_id";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "plan_ref";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "tax_quote_ref";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "tax_quote_currency";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "tax_quote_net_minor_units";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "tax_quote_tax_minor_units";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "tax_quote_seller_ref";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "tax_quote_invoice_issuer_ref";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "tax_quote_tax_remitter_ref";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "tax_quote_tax_service_ref";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "tax_quote_country";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "tax_quote_coverage_evidence_ref";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "tax_quote_tax_rate_evidence_ref";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "tax_quote_customer_location_evidence_ref";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "tax_quote_quoted_at";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "tax_quote_expires_at";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "tax_quote_signature_key_ref";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "tax_quote_signature_value";