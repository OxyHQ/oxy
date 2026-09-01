-- oxy:deploy-phase=pre
-- Additive; safe while the previous image serves. See src/db/migrationPhases.ts.

ALTER TABLE "billing_subscriptions" DROP CONSTRAINT "billing_subscriptions_status_check";--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_status_check" CHECK ("billing_subscriptions"."status" in ('active', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'paused', 'trialing', 'unpaid'));