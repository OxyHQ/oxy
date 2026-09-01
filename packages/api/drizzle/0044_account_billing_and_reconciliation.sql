-- oxy:deploy-phase=pre
--
-- Account-scoped billing, the payment-processor boundary and internal cost
-- centres (issue #972, sections 7.1, 7.4 and 7.5).
--
-- Five new tables, nothing altered, nothing dropped. Every one of them is empty
-- on arrival and no running image reads or writes any of them, so this breaks no
-- write the previous image performs — which is the test for `pre` rather than
-- `post`, and `pre` is the safer side here for the usual reason: a zero-capacity
-- deploy skips `post` entirely, and a skipped `post` blocks every subsequent
-- `pre` behind it until somebody unblocks it by hand.
--
-- WHAT EACH TABLE IS FOR, in one line each. The reasoning lives in the schema
-- modules, which are the authoritative copy of it.
--
--   billing_external_payments        the record of a processor charge that
--                                    funded a balance, and the ONLY join between
--                                    Oxy's ledger and Stripe's. Its
--                                    (provider, external_ref) unique key is the
--                                    second, independent webhook idempotency
--                                    guard beside the ledger's own key.
--   billing_auto_recharge_attempts   one row per automatic top-up, staked BEFORE
--                                    the card is charged, because a duplicate
--                                    off-session charge is not a bookkeeping
--                                    mistake and no compensating row undoes it.
--   billing_reconciliation_runs      one pass comparing the two systems.
--   billing_reconciliation_discrepancies  what that pass found, by kind.
--   internal_cost_centers            labels an existing project ACCOUNT as a
--                                    first-party cost centre. Not a second
--                                    hierarchy — there is no parent link here.
--
-- All four financial tables are on the NEVER_SWEPT list in
-- `src/db/__tests__/inferenceLedgerRetention.test.ts`: telemetry retention and
-- financial retention are different windows, and that separation is a gate
-- rather than a comment.
--
-- The append-only triggers over the two tables that record FACTS rather than
-- state are `0045_account_billing_immutability.sql`; drizzle-kit cannot emit a
-- trigger, so they are hand-written from
-- `src/db/schema/accountBillingImmutability.ts`.

CREATE TABLE "billing_auto_recharge_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"account_id" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"requested_amount" numeric(30, 12) NOT NULL,
	"balance_at_trigger" numeric(30, 12) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"external_ref" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_auto_recharge_attempts_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "billing_auto_recharge_attempts_status_check" CHECK ("billing_auto_recharge_attempts"."status" in ('pending', 'succeeded', 'failed')),
	CONSTRAINT "billing_auto_recharge_attempts_currency_check" CHECK ("billing_auto_recharge_attempts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "billing_auto_recharge_attempts_amount_check" CHECK ("billing_auto_recharge_attempts"."requested_amount" > 0),
	CONSTRAINT "billing_auto_recharge_attempts_balance_check" CHECK ("billing_auto_recharge_attempts"."balance_at_trigger" >= 0),
	CONSTRAINT "billing_auto_recharge_attempts_success_ref_check" CHECK ("billing_auto_recharge_attempts"."status" <> 'succeeded' or "billing_auto_recharge_attempts"."external_ref" is not null),
	CONSTRAINT "billing_auto_recharge_attempts_failure_code_check" CHECK ("billing_auto_recharge_attempts"."failure_code" is null or "billing_auto_recharge_attempts"."status" = 'failed'),
	CONSTRAINT "billing_auto_recharge_attempts_failure_code_length_check" CHECK ("billing_auto_recharge_attempts"."failure_code" is null or length("billing_auto_recharge_attempts"."failure_code") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "billing_external_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"provider" text NOT NULL,
	"external_kind" text NOT NULL,
	"external_ref" text NOT NULL,
	"amount" numeric(30, 12) NOT NULL,
	"ledger_entry_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_external_payments_provider_ref_key" UNIQUE("provider","external_ref"),
	CONSTRAINT "billing_external_payments_provider_check" CHECK ("billing_external_payments"."provider" in ('stripe')),
	CONSTRAINT "billing_external_payments_external_kind_check" CHECK ("billing_external_payments"."external_kind" in ('payment_intent', 'invoice')),
	CONSTRAINT "billing_external_payments_currency_check" CHECK ("billing_external_payments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "billing_external_payments_external_ref_check" CHECK (length("billing_external_payments"."external_ref") > 0),
	CONSTRAINT "billing_external_payments_amount_check" CHECK ("billing_external_payments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "billing_reconciliation_discrepancies" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"account_id" text,
	"external_ref" text,
	"ledger_entry_id" text,
	"ledger_amount" numeric(30, 12),
	"external_amount" numeric(30, 12),
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_reconciliation_discrepancies_kind_check" CHECK ("billing_reconciliation_discrepancies"."kind" in ('missing_in_ledger', 'missing_in_external', 'amount_mismatch', 'account_unresolved')),
	CONSTRAINT "billing_reconciliation_discrepancies_currency_check" CHECK ("billing_reconciliation_discrepancies"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "billing_reconciliation_discrepancies_ledger_amount_check" CHECK ("billing_reconciliation_discrepancies"."ledger_amount" is null or "billing_reconciliation_discrepancies"."ledger_amount" >= 0),
	CONSTRAINT "billing_reconciliation_discrepancies_external_amount_check" CHECK ("billing_reconciliation_discrepancies"."external_amount" is null or "billing_reconciliation_discrepancies"."external_amount" >= 0),
	CONSTRAINT "billing_reconciliation_discrepancies_evidence_check" CHECK (("billing_reconciliation_discrepancies"."kind" <> 'missing_in_ledger'
             or ("billing_reconciliation_discrepancies"."external_ref" is not null and "billing_reconciliation_discrepancies"."external_amount" is not null))
        and ("billing_reconciliation_discrepancies"."kind" <> 'missing_in_external'
             or ("billing_reconciliation_discrepancies"."ledger_entry_id" is not null and "billing_reconciliation_discrepancies"."ledger_amount" is not null))
        and ("billing_reconciliation_discrepancies"."kind" <> 'amount_mismatch'
             or ("billing_reconciliation_discrepancies"."external_ref" is not null
                 and "billing_reconciliation_discrepancies"."ledger_amount" is not null
                 and "billing_reconciliation_discrepancies"."external_amount" is not null))
        and ("billing_reconciliation_discrepancies"."kind" <> 'account_unresolved' or "billing_reconciliation_discrepancies"."external_ref" is not null))
);
--> statement-breakpoint
CREATE TABLE "billing_reconciliation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"account_id" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"ledger_total" numeric(30, 12) DEFAULT '0' NOT NULL,
	"external_total" numeric(30, 12) DEFAULT '0' NOT NULL,
	"discrepancy_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_reconciliation_runs_provider_check" CHECK ("billing_reconciliation_runs"."provider" in ('stripe')),
	CONSTRAINT "billing_reconciliation_runs_status_check" CHECK ("billing_reconciliation_runs"."status" in ('running', 'completed', 'failed')),
	CONSTRAINT "billing_reconciliation_runs_currency_check" CHECK ("billing_reconciliation_runs"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "billing_reconciliation_runs_period_check" CHECK ("billing_reconciliation_runs"."period_end" > "billing_reconciliation_runs"."period_start"),
	CONSTRAINT "billing_reconciliation_runs_ledger_total_check" CHECK ("billing_reconciliation_runs"."ledger_total" >= 0),
	CONSTRAINT "billing_reconciliation_runs_external_total_check" CHECK ("billing_reconciliation_runs"."external_total" >= 0),
	CONSTRAINT "billing_reconciliation_runs_discrepancy_count_check" CHECK ("billing_reconciliation_runs"."discrepancy_count" >= 0),
	CONSTRAINT "billing_reconciliation_runs_completed_at_check" CHECK (("billing_reconciliation_runs"."status" = 'running') = ("billing_reconciliation_runs"."completed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "internal_cost_centers" (
	"account_id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "internal_cost_centers_slug_key" UNIQUE("slug"),
	CONSTRAINT "internal_cost_centers_status_check" CHECK ("internal_cost_centers"."status" in ('active', 'retired')),
	CONSTRAINT "internal_cost_centers_slug_check" CHECK ("internal_cost_centers"."slug" ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
	CONSTRAINT "internal_cost_centers_label_check" CHECK (length("internal_cost_centers"."label") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "billing_auto_recharge_attempts" ADD CONSTRAINT "billing_auto_recharge_attempts_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_external_payments" ADD CONSTRAINT "billing_external_payments_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_external_payments" ADD CONSTRAINT "billing_external_payments_ledger_entry_id_billing_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."billing_ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_reconciliation_discrepancies" ADD CONSTRAINT "billing_reconciliation_discrepancies_run_id_billing_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."billing_reconciliation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_reconciliation_discrepancies" ADD CONSTRAINT "billing_reconciliation_discrepancies_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_reconciliation_discrepancies" ADD CONSTRAINT "billing_reconciliation_discrepancies_ledger_entry_id_billing_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."billing_ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_reconciliation_runs" ADD CONSTRAINT "billing_reconciliation_runs_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_cost_centers" ADD CONSTRAINT "internal_cost_centers_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_auto_recharge_attempts_account_created_at_idx" ON "billing_auto_recharge_attempts" USING btree ("account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "billing_auto_recharge_attempts_status_idx" ON "billing_auto_recharge_attempts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "billing_external_payments_account_occurred_at_idx" ON "billing_external_payments" USING btree ("account_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "billing_external_payments_ledger_entry_id_idx" ON "billing_external_payments" USING btree ("ledger_entry_id");--> statement-breakpoint
CREATE INDEX "billing_reconciliation_discrepancies_run_id_idx" ON "billing_reconciliation_discrepancies" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_reconciliation_discrepancies_run_ref_key" ON "billing_reconciliation_discrepancies" USING btree ("run_id","kind","external_ref") WHERE "billing_reconciliation_discrepancies"."external_ref" is not null;--> statement-breakpoint
CREATE INDEX "billing_reconciliation_runs_started_at_idx" ON "billing_reconciliation_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "billing_reconciliation_runs_account_started_at_idx" ON "billing_reconciliation_runs" USING btree ("account_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "billing_reconciliation_runs_status_idx" ON "billing_reconciliation_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "internal_cost_centers_status_idx" ON "internal_cost_centers" USING btree ("status");