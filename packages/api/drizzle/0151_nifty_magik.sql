-- oxy:deploy-phase=pre
CREATE TABLE "access_provider_refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_account_ref" text NOT NULL,
	"mode" text NOT NULL,
	"environment" text NOT NULL,
	"invoice_id" text NOT NULL,
	"line_id" text NOT NULL,
	"price_id" text NOT NULL,
	"payment_intent_id" text NOT NULL,
	"charge_id" text NOT NULL,
	"source_id" text NOT NULL,
	"segment_id" text NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"payer_account_id" text NOT NULL,
	"beneficiary_account_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "access_provider_refunds_segment_key" UNIQUE("segment_id"),
	CONSTRAINT "access_provider_refunds_financial_key" UNIQUE("provider","provider_account_ref","mode","environment","invoice_id","line_id"),
	CONSTRAINT "access_provider_refunds_provider" CHECK ("access_provider_refunds"."provider"='peable'),
	CONSTRAINT "access_provider_refunds_namespace" CHECK (("access_provider_refunds"."mode"='live' and "access_provider_refunds"."environment"='production') or ("access_provider_refunds"."mode"='test' and "access_provider_refunds"."environment" in ('test','staging','development'))),
	CONSTRAINT "access_provider_refunds_period" CHECK ("access_provider_refunds"."period_end">"access_provider_refunds"."period_start"),
	CONSTRAINT "access_provider_refunds_parties" CHECK ("access_provider_refunds"."payer_account_id"="access_provider_refunds"."beneficiary_account_id")
);
--> statement-breakpoint
ALTER TABLE "access_provider_refunds" ADD CONSTRAINT "access_provider_refunds_payer_account_id_users_id_fk" FOREIGN KEY ("payer_account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_provider_refunds" ADD CONSTRAINT "access_provider_refunds_beneficiary_account_id_users_id_fk" FOREIGN KEY ("beneficiary_account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER access_provider_refunds_immutable BEFORE UPDATE OR DELETE ON access_provider_refunds FOR EACH ROW EXECUTE FUNCTION product_access_immutable();
