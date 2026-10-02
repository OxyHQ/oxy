-- oxy:deploy-phase=pre
-- I06 regenerated after scoped execution; source DDL equality verified.
CREATE TABLE "billing_stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"stripe_event_id" text NOT NULL,
	"type" text NOT NULL,
	"stripe_object_id" text,
	"stripe_created_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" text,
	"outcome_detail" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_stripe_events_stripe_event_id_key" UNIQUE("stripe_event_id"),
	CONSTRAINT "billing_stripe_events_outcome_check" CHECK ("billing_stripe_events"."outcome" is null or "billing_stripe_events"."outcome" in ('granted', 'duplicate', 'synced', 'stale', 'not_granted', 'ignored', 'processed', 'failed')),
	CONSTRAINT "billing_stripe_events_processed_check" CHECK (("billing_stripe_events"."processed_at" is null) = ("billing_stripe_events"."outcome" is null)),
	CONSTRAINT "billing_stripe_events_attempts_check" CHECK ("billing_stripe_events"."attempts" >= 1)
);
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "provider_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD COLUMN "stripe_invoice_id" text;--> statement-breakpoint
CREATE INDEX "billing_stripe_events_object_idx" ON "billing_stripe_events" USING btree ("stripe_object_id","stripe_created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_transactions_subscription_invoice_key" ON "billing_transactions" USING btree ("stripe_invoice_id","type") WHERE "billing_transactions"."type" = 'subscription_payment' and "billing_transactions"."stripe_invoice_id" is not null;