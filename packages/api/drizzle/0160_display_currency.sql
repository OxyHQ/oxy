-- oxy:deploy-phase=pre
ALTER TABLE "users" ADD COLUMN "preference_display_currency" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_display_currency_check" CHECK ("users"."preference_display_currency" IN ('USD', 'EUR', 'FAIR'));
