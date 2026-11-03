-- oxy:deploy-phase=post
-- The image arriving with Peable 0.7 neither reads nor writes these; 0226 already
-- removed them from every CHECK.
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "tax_quote_quoted_at_lexeme";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP COLUMN "tax_quote_expires_at_lexeme";