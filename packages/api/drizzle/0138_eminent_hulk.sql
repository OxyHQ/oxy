-- oxy:deploy-phase=pre
CREATE TABLE "billing_credit_consumptions" (
	"spend_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_credit_consumptions_spend_id_grant_id_pk" PRIMARY KEY("spend_id","grant_id"),
	CONSTRAINT "billing_credit_consumptions_count_check" CHECK ("billing_credit_consumptions"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "billing_credit_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"provider_account_ref" text NOT NULL,
	"invoice_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"source_type" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"amount_paid" bigint NOT NULL,
	"granted" bigint NOT NULL,
	"consumed" bigint DEFAULT 0 NOT NULL,
	"clawed" bigint DEFAULT 0 NOT NULL,
	"promotion_id" text,
	"once_per_account_promotion_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_credit_grants_invoice_key" UNIQUE("provider_account_ref","invoice_id","source_type"),
	CONSTRAINT "billing_credit_grants_transaction_key" UNIQUE("transaction_id"),
	CONSTRAINT "billing_credit_grants_account_identity_key" UNIQUE("id","user_id"),
	CONSTRAINT "billing_credit_grants_trial_key" UNIQUE("user_id","once_per_account_promotion_id"),
	CONSTRAINT "billing_credit_grants_source_check" CHECK ("billing_credit_grants"."source_type" in ('subscription_payment','subscription_proration','subscription_promotional_grant')),
	CONSTRAINT "billing_credit_grants_amount_check" CHECK ("billing_credit_grants"."amount_paid" >= 0 and "billing_credit_grants"."granted" >= 0 and "billing_credit_grants"."consumed" >= 0 and "billing_credit_grants"."clawed" >= 0 and "billing_credit_grants"."consumed" + "billing_credit_grants"."clawed" <= "billing_credit_grants"."granted"),
	CONSTRAINT "billing_credit_grants_period_check" CHECK ("billing_credit_grants"."period_end" > "billing_credit_grants"."period_start"),
	CONSTRAINT "billing_credit_grants_identity_check" CHECK (length("billing_credit_grants"."provider_account_ref") between 1 and 160 and length("billing_credit_grants"."invoice_id") between 1 and 160 and length("billing_credit_grants"."subscription_id") between 1 and 160 and "billing_credit_grants"."currency" ~ '^[a-z]{3}$'),
	CONSTRAINT "billing_credit_grants_promotion_check" CHECK (("billing_credit_grants"."source_type" = 'subscription_promotional_grant' and "billing_credit_grants"."promotion_id" is not null and "billing_credit_grants"."amount_paid" = 0) or ("billing_credit_grants"."source_type" <> 'subscription_promotional_grant' and "billing_credit_grants"."promotion_id" is null and "billing_credit_grants"."once_per_account_promotion_id" is null and "billing_credit_grants"."amount_paid" > 0))
);
--> statement-breakpoint
CREATE TABLE "billing_credit_invoices" (
	"provider_account_ref" text NOT NULL,
	"invoice_id" text NOT NULL,
	"user_id" text NOT NULL,
	"currency" text NOT NULL,
	"amount_paid" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_credit_invoices_provider_account_ref_invoice_id_pk" PRIMARY KEY("provider_account_ref","invoice_id"),
	CONSTRAINT "billing_credit_invoices_attribution_key" UNIQUE("provider_account_ref","invoice_id","user_id","currency","amount_paid"),
	CONSTRAINT "billing_credit_invoices_amount_check" CHECK ("billing_credit_invoices"."amount_paid" >= 0),
	CONSTRAINT "billing_credit_invoices_identity_check" CHECK (length("billing_credit_invoices"."provider_account_ref") between 1 and 160 and length("billing_credit_invoices"."invoice_id") between 1 and 160 and "billing_credit_invoices"."currency" ~ '^[a-z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "billing_credit_refund_observations" (
	"provider_account_ref" text NOT NULL,
	"event_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"charge_id" text NOT NULL,
	"user_id" text NOT NULL,
	"currency" text NOT NULL,
	"amount_paid" bigint NOT NULL,
	"amount_refunded" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_credit_refund_observations_provider_account_ref_event_id_pk" PRIMARY KEY("provider_account_ref","event_id"),
	CONSTRAINT "billing_credit_refund_observations_amount_check" CHECK ("billing_credit_refund_observations"."amount_paid" > 0 and "billing_credit_refund_observations"."amount_refunded" >= 0 and "billing_credit_refund_observations"."amount_refunded" <= "billing_credit_refund_observations"."amount_paid"),
	CONSTRAINT "billing_credit_refund_observations_identity_check" CHECK (length("billing_credit_refund_observations"."provider_account_ref") between 1 and 160 and length("billing_credit_refund_observations"."event_id") between 1 and 160 and length("billing_credit_refund_observations"."invoice_id") between 1 and 160 and length("billing_credit_refund_observations"."charge_id") between 1 and 160 and "billing_credit_refund_observations"."currency" ~ '^[a-z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "billing_credit_spends" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"tracked_paid" bigint NOT NULL,
	"legacy_paid" bigint NOT NULL,
	"free" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_credit_spends_intent_key" UNIQUE("user_id","operation_id"),
	CONSTRAINT "billing_credit_spends_account_identity_key" UNIQUE("id","user_id"),
	CONSTRAINT "billing_credit_spends_count_check" CHECK ("billing_credit_spends"."amount" >= 0 and "billing_credit_spends"."tracked_paid" >= 0 and "billing_credit_spends"."legacy_paid" >= 0 and "billing_credit_spends"."free" >= 0 and "billing_credit_spends"."amount" = "billing_credit_spends"."tracked_paid" + "billing_credit_spends"."legacy_paid" + "billing_credit_spends"."free"),
	CONSTRAINT "billing_credit_spends_intent_check" CHECK (length("billing_credit_spends"."operation_id") between 1 and 160)
);
--> statement-breakpoint
ALTER TABLE "billing_transactions" DROP CONSTRAINT "billing_transactions_type_check";--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD COLUMN "promotion_id" text;--> statement-breakpoint
ALTER TABLE "billing_credit_consumptions" ADD CONSTRAINT "billing_credit_consumptions_spend_fk" FOREIGN KEY ("spend_id","user_id") REFERENCES "public"."billing_credit_spends"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_consumptions" ADD CONSTRAINT "billing_credit_consumptions_grant_fk" FOREIGN KEY ("grant_id","user_id") REFERENCES "public"."billing_credit_grants"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_grants" ADD CONSTRAINT "billing_credit_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_grants" ADD CONSTRAINT "billing_credit_grants_transaction_id_billing_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."billing_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_grants" ADD CONSTRAINT "billing_credit_grants_invoice_fk" FOREIGN KEY ("provider_account_ref","invoice_id","user_id","currency","amount_paid") REFERENCES "public"."billing_credit_invoices"("provider_account_ref","invoice_id","user_id","currency","amount_paid") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_invoices" ADD CONSTRAINT "billing_credit_invoices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_refund_observations" ADD CONSTRAINT "billing_credit_refund_observations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_refund_observations" ADD CONSTRAINT "billing_credit_refund_observations_invoice_fk" FOREIGN KEY ("provider_account_ref","invoice_id","user_id","currency","amount_paid") REFERENCES "public"."billing_credit_invoices"("provider_account_ref","invoice_id","user_id","currency","amount_paid") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_spends" ADD CONSTRAINT "billing_credit_spends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_credit_grants_fifo_idx" ON "billing_credit_grants" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "billing_credit_refund_observations_invoice_idx" ON "billing_credit_refund_observations" USING btree ("provider_account_ref","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_transactions_proration_invoice_key" ON "billing_transactions" USING btree ("stripe_invoice_id","type") WHERE "billing_transactions"."type" = 'subscription_proration' and "billing_transactions"."stripe_invoice_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_transactions_promotional_period_key" ON "billing_transactions" USING btree ("stripe_subscription_id","stripe_subscription_period_start","type") WHERE "billing_transactions"."type" = 'subscription_promotional_grant' and "billing_transactions"."stripe_subscription_id" is not null and "billing_transactions"."stripe_subscription_period_start" is not null;--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD CONSTRAINT "billing_transactions_type_check" CHECK ("billing_transactions"."type" in ('credit_purchase', 'subscription_payment', 'subscription_proration', 'subscription_promotional_grant', 'refund'));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION billing_credit_immutable_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credit ledger provenance cannot be rewritten or deleted' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION billing_credit_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'credit grant history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['consumed','clawed']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['consumed','clawed']) OR NEW.consumed < OLD.consumed OR NEW.clawed < OLD.clawed THEN
    RAISE EXCEPTION 'credit grant identity is immutable and consumption/refund monotone' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER billing_credit_grants_guard BEFORE UPDATE OR DELETE ON billing_credit_grants FOR EACH ROW EXECUTE FUNCTION billing_credit_grant_guard();
--> statement-breakpoint
CREATE TRIGGER billing_credit_invoices_immutable BEFORE UPDATE OR DELETE ON billing_credit_invoices FOR EACH ROW EXECUTE FUNCTION billing_credit_immutable_history();
--> statement-breakpoint
CREATE TRIGGER billing_credit_spends_immutable BEFORE UPDATE OR DELETE ON billing_credit_spends FOR EACH ROW EXECUTE FUNCTION billing_credit_immutable_history();
--> statement-breakpoint
CREATE TRIGGER billing_credit_consumptions_immutable BEFORE UPDATE OR DELETE ON billing_credit_consumptions FOR EACH ROW EXECUTE FUNCTION billing_credit_immutable_history();
--> statement-breakpoint
CREATE TRIGGER billing_credit_refund_observations_immutable BEFORE UPDATE OR DELETE ON billing_credit_refund_observations FOR EACH ROW EXECUTE FUNCTION billing_credit_immutable_history();
