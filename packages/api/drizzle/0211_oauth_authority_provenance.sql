-- oxy:deploy-phase=pre
-- Additive provenance; legacy NULL requests/codes restart rather than inherit current trust.
ALTER TABLE "auth_codes" ADD COLUMN "authority" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "oauth_authority" text;--> statement-breakpoint
ALTER TABLE "auth_codes" ADD CONSTRAINT "auth_codes_authority_check" CHECK ("auth_codes"."authority" in ('first_party', 'external'));--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_oauth_authority_check" CHECK ("auth_sessions"."oauth_authority" in ('first_party', 'external'));