-- oxy:deploy-phase=pre
--
-- The exact inference ledger and its telemetry (#972 workstreams 7 and 8):
-- sixteen NEW tables and nothing else. Verified rather than asserted — every
-- `ALTER TABLE` in this file names a table this file also creates, there is no
-- DROP and no narrowed constraint, and the snapshot went from 112 tables to 128
-- with a delta of exactly 16 (which is also the check that the generator LOADED
-- the schema: a total load failure exits 0 and leaves the directory
-- byte-identical, so "no diff" and "read nothing" look the same from outside).
--
-- WHY `pre`.
--
-- The repo's rule is not "does it narrow" but "does it break a write the
-- PREVIOUS image performs". Nothing here can: none of these tables exists yet,
-- so the outgoing image has no statement that could touch one. That makes it
-- correct against both the image serving and the one arriving, which is the
-- definition of `pre`.
--
-- `post` would be actively wrong, not merely conservative. A zero-capacity
-- deploy exits before its post-migration step, so a `post` marker strands the
-- whole ledger behind an unapplied entry — and the migrator refuses a pending
-- list where a `pre` sits behind an unapplied `post`, which would then block
-- every subsequent migration until somebody unblocked it by hand.
--
-- Nothing calls the service that writes these tables yet, deliberately: the
-- reserve/settle/refund protocol lands as not-yet-called code so the public API
-- edge (#972 workstream 4) is one rewiring commit rather than a welded change.
-- Applying this migration therefore changes no behaviour of the running system.
--
-- ONE CONSEQUENCE WORTH READING BEFORE MERGING. Every foreign key from a
-- financial table to `users`, `applications` and `application_credentials` is
-- `ON DELETE RESTRICT`, so an account holding ledger rows cannot be
-- hard-deleted. That is not a new class of requirement — `billing_transactions`
-- has been `RESTRICT` since the Postgres port, so an account with billing
-- history already needed an explicit erasure decision — but the erasure path
-- has to grow one before this ledger carries production rows.

CREATE TABLE "account_balances" (
	"account_id" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"purchased_balance" numeric(30, 12) DEFAULT '0' NOT NULL,
	"promotional_balance" numeric(30, 12) DEFAULT '0' NOT NULL,
	"reserved_balance" numeric(30, 12) DEFAULT '0' NOT NULL,
	"invoiced_outstanding" numeric(30, 12) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "account_balances_account_id_currency_pk" PRIMARY KEY("account_id","currency"),
	CONSTRAINT "account_balances_currency_check" CHECK ("account_balances"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "account_balances_purchased_check" CHECK ("account_balances"."purchased_balance" >= 0),
	CONSTRAINT "account_balances_promotional_check" CHECK ("account_balances"."promotional_balance" >= 0),
	CONSTRAINT "account_balances_reserved_check" CHECK ("account_balances"."reserved_balance" >= 0),
	CONSTRAINT "account_balances_invoiced_outstanding_check" CHECK ("account_balances"."invoiced_outstanding" >= 0)
);
--> statement-breakpoint
CREATE TABLE "billing_invoice_receipts" (
	"receipt_id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"subtotal_amount" numeric(30, 12) DEFAULT '0' NOT NULL,
	"total_amount" numeric(30, 12) DEFAULT '0' NOT NULL,
	"minor_unit_exponent" integer DEFAULT 2 NOT NULL,
	"external_invoice_ref" text,
	"issued_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_invoices_account_period_key" UNIQUE("account_id","currency","period_start","period_end"),
	CONSTRAINT "billing_invoices_status_check" CHECK ("billing_invoices"."status" in ('draft', 'open', 'paid', 'void')),
	CONSTRAINT "billing_invoices_currency_check" CHECK ("billing_invoices"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "billing_invoices_period_check" CHECK ("billing_invoices"."period_end" > "billing_invoices"."period_start"),
	CONSTRAINT "billing_invoices_subtotal_check" CHECK ("billing_invoices"."subtotal_amount" >= 0),
	CONSTRAINT "billing_invoices_total_check" CHECK ("billing_invoices"."total_amount" >= 0),
	CONSTRAINT "billing_invoices_minor_unit_exponent_check" CHECK ("billing_invoices"."minor_unit_exponent" >= 0 and "billing_invoices"."minor_unit_exponent" <= 4),
	CONSTRAINT "billing_invoices_rounding_bound_check" CHECK (abs("billing_invoices"."total_amount" - "billing_invoices"."subtotal_amount") < power(10::numeric, -"billing_invoices"."minor_unit_exponent")),
	CONSTRAINT "billing_invoices_issued_at_check" CHECK ("billing_invoices"."status" in ('draft', 'void') or "billing_invoices"."issued_at" is not null),
	CONSTRAINT "billing_invoices_paid_at_check" CHECK (("billing_invoices"."status" = 'paid') = ("billing_invoices"."paid_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "billing_ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"account_id" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"kind" text NOT NULL,
	"reservation_id" text,
	"receipt_id" text,
	"refund_id" text,
	"invoice_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_ledger_entries_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "billing_ledger_entries_kind_check" CHECK ("billing_ledger_entries"."kind" in ('top_up', 'promotional_grant', 'reservation_hold', 'reservation_release', 'reservation_expiry', 'settlement', 'settlement_reversal', 'invoice_rounding', 'invoice_payment')),
	CONSTRAINT "billing_ledger_entries_currency_check" CHECK ("billing_ledger_entries"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "billing_ledger_entries_subject_check" CHECK (("billing_ledger_entries"."kind" not in ('reservation_hold', 'reservation_release', 'reservation_expiry')
             or "billing_ledger_entries"."reservation_id" is not null)
        and ("billing_ledger_entries"."kind" not in ('settlement', 'settlement_reversal') or "billing_ledger_entries"."receipt_id" is not null)
        and ("billing_ledger_entries"."kind" not in ('invoice_rounding', 'invoice_payment') or "billing_ledger_entries"."invoice_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "billing_ledger_postings" (
	"entry_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"source_account" text NOT NULL,
	"destination_account" text NOT NULL,
	"amount" numeric(30, 12) NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_ledger_postings_entry_id_sequence_pk" PRIMARY KEY("entry_id","sequence"),
	CONSTRAINT "billing_ledger_postings_source_account_check" CHECK ("billing_ledger_postings"."source_account" in ('purchased_funds', 'promotional_funds', 'reserved_funds', 'invoice_receivable', 'external_settlement', 'promotional_issuance', 'platform_revenue')),
	CONSTRAINT "billing_ledger_postings_destination_account_check" CHECK ("billing_ledger_postings"."destination_account" in ('purchased_funds', 'promotional_funds', 'reserved_funds', 'invoice_receivable', 'external_settlement', 'promotional_issuance', 'platform_revenue')),
	CONSTRAINT "billing_ledger_postings_distinct_accounts_check" CHECK ("billing_ledger_postings"."source_account" <> "billing_ledger_postings"."destination_account"),
	CONSTRAINT "billing_ledger_postings_amount_check" CHECK ("billing_ledger_postings"."amount" > 0),
	CONSTRAINT "billing_ledger_postings_sequence_check" CHECK ("billing_ledger_postings"."sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "billing_profiles" (
	"account_id" text PRIMARY KEY NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"billing_mode" text DEFAULT 'prepaid' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"credit_limit" numeric(30, 12) DEFAULT '0' NOT NULL,
	"auto_recharge_enabled" boolean DEFAULT false NOT NULL,
	"auto_recharge_threshold" numeric(30, 12),
	"auto_recharge_amount" numeric(30, 12),
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_profiles_billing_mode_check" CHECK ("billing_profiles"."billing_mode" in ('prepaid', 'invoiced')),
	CONSTRAINT "billing_profiles_status_check" CHECK ("billing_profiles"."status" in ('active', 'suspended', 'closed')),
	CONSTRAINT "billing_profiles_currency_check" CHECK ("billing_profiles"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "billing_profiles_credit_limit_check" CHECK ("billing_profiles"."credit_limit" >= 0),
	CONSTRAINT "billing_profiles_auto_recharge_check" CHECK (not "billing_profiles"."auto_recharge_enabled"
        or ("billing_profiles"."auto_recharge_threshold" is not null and "billing_profiles"."auto_recharge_amount" is not null)),
	CONSTRAINT "billing_profiles_auto_recharge_amounts_check" CHECK (("billing_profiles"."auto_recharge_threshold" is null or "billing_profiles"."auto_recharge_threshold" >= 0)
        and ("billing_profiles"."auto_recharge_amount" is null or "billing_profiles"."auto_recharge_amount" > 0))
);
--> statement-breakpoint
CREATE TABLE "inference_usage_daily_rollups" (
	"day" date NOT NULL,
	"account_id" text NOT NULL,
	"application_id" text NOT NULL,
	"application_credential_id" text NOT NULL,
	"environment" text NOT NULL,
	"requested_model_reference" text NOT NULL,
	"serving_provider" text NOT NULL,
	"outcome" text NOT NULL,
	"request_count" bigint DEFAULT 0 NOT NULL,
	"error_count" bigint DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"images" bigint DEFAULT 0 NOT NULL,
	"audio_input_milliseconds" bigint DEFAULT 0 NOT NULL,
	"audio_output_milliseconds" bigint DEFAULT 0 NOT NULL,
	"video_milliseconds" bigint DEFAULT 0 NOT NULL,
	"characters" bigint DEFAULT 0 NOT NULL,
	"embeddings" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_usage_daily_rollups_day_account_id_application_id_application_credential_id_environment_requested_model_reference_serving_provider_outcome_pk" PRIMARY KEY("day","account_id","application_id","application_credential_id","environment","requested_model_reference","serving_provider","outcome"),
	CONSTRAINT "inference_usage_daily_rollups_environment_check" CHECK ("inference_usage_daily_rollups"."environment" in ('development', 'staging', 'production')),
	CONSTRAINT "inference_usage_daily_rollups_outcome_check" CHECK ("inference_usage_daily_rollups"."outcome" in ('completed', 'partial', 'cancelled', 'failed')),
	CONSTRAINT "inference_usage_daily_rollups_counts_check" CHECK ("inference_usage_daily_rollups"."request_count" >= 0 and "inference_usage_daily_rollups"."error_count" >= 0 and "inference_usage_daily_rollups"."error_count" <= "inference_usage_daily_rollups"."request_count"),
	CONSTRAINT "inference_usage_daily_rollups_units_check" CHECK ("inference_usage_daily_rollups"."input_tokens" >= 0 and "inference_usage_daily_rollups"."cached_input_tokens" >= 0 and "inference_usage_daily_rollups"."output_tokens" >= 0 and "inference_usage_daily_rollups"."reasoning_tokens" >= 0 and "inference_usage_daily_rollups"."requests" >= 0 and "inference_usage_daily_rollups"."images" >= 0 and "inference_usage_daily_rollups"."audio_input_milliseconds" >= 0 and "inference_usage_daily_rollups"."audio_output_milliseconds" >= 0 and "inference_usage_daily_rollups"."video_milliseconds" >= 0 and "inference_usage_daily_rollups"."characters" >= 0 and "inference_usage_daily_rollups"."embeddings" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inference_usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"application_id" text NOT NULL,
	"application_credential_id" text NOT NULL,
	"delegated_user_id" text,
	"request_id" text NOT NULL,
	"generation_id" text,
	"environment" text NOT NULL,
	"endpoint" text NOT NULL,
	"status_code" integer NOT NULL,
	"outcome" text NOT NULL,
	"requested_model_reference" text NOT NULL,
	"resolved_model_reference" text,
	"serving_provider" text,
	"deployment_id" text,
	"route_switches" integer DEFAULT 0 NOT NULL,
	"usage_source" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"images" bigint DEFAULT 0 NOT NULL,
	"audio_input_milliseconds" bigint DEFAULT 0 NOT NULL,
	"audio_output_milliseconds" bigint DEFAULT 0 NOT NULL,
	"video_milliseconds" bigint DEFAULT 0 NOT NULL,
	"characters" bigint DEFAULT 0 NOT NULL,
	"embeddings" bigint DEFAULT 0 NOT NULL,
	"latency_ms" bigint,
	"time_to_first_token_ms" bigint,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_usage_events_environment_check" CHECK ("inference_usage_events"."environment" in ('development', 'staging', 'production')),
	CONSTRAINT "inference_usage_events_outcome_check" CHECK ("inference_usage_events"."outcome" in ('completed', 'partial', 'cancelled', 'failed')),
	CONSTRAINT "inference_usage_events_usage_source_check" CHECK ("inference_usage_events"."usage_source" in ('provider_reported', 'oxy_measured', 'estimated')),
	CONSTRAINT "inference_usage_events_status_code_check" CHECK ("inference_usage_events"."status_code" >= 100 and "inference_usage_events"."status_code" < 600),
	CONSTRAINT "inference_usage_events_request_id_check" CHECK (length("inference_usage_events"."request_id") > 0),
	CONSTRAINT "inference_usage_events_endpoint_check" CHECK (length("inference_usage_events"."endpoint") > 0),
	CONSTRAINT "inference_usage_events_requested_model_check" CHECK (length("inference_usage_events"."requested_model_reference") > 0),
	CONSTRAINT "inference_usage_events_latency_check" CHECK (("inference_usage_events"."latency_ms" is null or "inference_usage_events"."latency_ms" >= 0)
        and ("inference_usage_events"."time_to_first_token_ms" is null or "inference_usage_events"."time_to_first_token_ms" >= 0)
        and "inference_usage_events"."route_switches" >= 0),
	CONSTRAINT "inference_usage_events_units_check" CHECK ("inference_usage_events"."input_tokens" >= 0 and "inference_usage_events"."cached_input_tokens" >= 0 and "inference_usage_events"."output_tokens" >= 0 and "inference_usage_events"."reasoning_tokens" >= 0 and "inference_usage_events"."requests" >= 0 and "inference_usage_events"."images" >= 0 and "inference_usage_events"."audio_input_milliseconds" >= 0 and "inference_usage_events"."audio_output_milliseconds" >= 0 and "inference_usage_events"."video_milliseconds" >= 0 and "inference_usage_events"."characters" >= 0 and "inference_usage_events"."embeddings" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_version_unit_prices" (
	"price_version_id" text NOT NULL,
	"unit" text NOT NULL,
	"amount" numeric(30, 12) NOT NULL,
	"per" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "price_version_unit_prices_price_version_id_unit_pk" PRIMARY KEY("price_version_id","unit"),
	CONSTRAINT "price_version_unit_prices_unit_check" CHECK ("price_version_unit_prices"."unit" in ('input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'requests', 'images', 'audio_input_milliseconds', 'audio_output_milliseconds', 'video_milliseconds', 'characters', 'embeddings')),
	CONSTRAINT "price_version_unit_prices_amount_check" CHECK ("price_version_unit_prices"."amount" >= 0),
	CONSTRAINT "price_version_unit_prices_per_check" CHECK ("price_version_unit_prices"."per" > 0)
);
--> statement-breakpoint
CREATE TABLE "price_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"model_reference" text NOT NULL,
	"provider" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone,
	"supersedes_price_version_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "price_versions_status_check" CHECK ("price_versions"."status" in ('draft', 'active', 'superseded')),
	CONSTRAINT "price_versions_currency_check" CHECK ("price_versions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "price_versions_model_reference_check" CHECK (length("price_versions"."model_reference") > 0),
	CONSTRAINT "price_versions_provider_check" CHECK (length("price_versions"."provider") > 0),
	CONSTRAINT "price_versions_effective_window_check" CHECK ("price_versions"."effective_until" is null or "price_versions"."effective_until" > "price_versions"."effective_from"),
	CONSTRAINT "price_versions_superseded_window_check" CHECK ("price_versions"."status" <> 'superseded' or "price_versions"."effective_until" is not null),
	CONSTRAINT "price_versions_supersedes_self_check" CHECK ("price_versions"."supersedes_price_version_id" is null or "price_versions"."supersedes_price_version_id" <> "price_versions"."id")
);
--> statement-breakpoint
CREATE TABLE "spending_limit_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"spending_limit_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"threshold_bps" integer NOT NULL,
	"spend_amount" numeric(30, 12) NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "spending_limit_notifications_threshold_key" UNIQUE("spending_limit_id","period_start","threshold_bps"),
	CONSTRAINT "spending_limit_notifications_threshold_bps_check" CHECK ("spending_limit_notifications"."threshold_bps" in (2500, 5000, 7500, 9000, 10000)),
	CONSTRAINT "spending_limit_notifications_spend_amount_check" CHECK ("spending_limit_notifications"."spend_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "spending_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"scope" text NOT NULL,
	"scope_account_id" text,
	"scope_application_id" text,
	"scope_application_credential_id" text,
	"period" text NOT NULL,
	"limit_amount" numeric(30, 12) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"enforcement" text DEFAULT 'hard_stop' NOT NULL,
	"alert_threshold_bps" smallint[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "spending_limits_scope_check" CHECK ("spending_limits"."scope" in ('account', 'application', 'credential')),
	CONSTRAINT "spending_limits_period_check" CHECK ("spending_limits"."period" in ('daily', 'weekly', 'monthly', 'total')),
	CONSTRAINT "spending_limits_enforcement_check" CHECK ("spending_limits"."enforcement" in ('hard_stop', 'soft_stop')),
	CONSTRAINT "spending_limits_status_check" CHECK ("spending_limits"."status" in ('active', 'disabled')),
	CONSTRAINT "spending_limits_currency_check" CHECK ("spending_limits"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "spending_limits_limit_amount_check" CHECK ("spending_limits"."limit_amount" > 0),
	CONSTRAINT "spending_limits_scope_target_check" CHECK (("spending_limits"."scope" = 'account'
             and "spending_limits"."scope_account_id" is not null
             and "spending_limits"."scope_application_id" is null
             and "spending_limits"."scope_application_credential_id" is null)
        or ("spending_limits"."scope" = 'application'
             and "spending_limits"."scope_application_id" is not null
             and "spending_limits"."scope_account_id" is null
             and "spending_limits"."scope_application_credential_id" is null)
        or ("spending_limits"."scope" = 'credential'
             and "spending_limits"."scope_application_credential_id" is not null
             and "spending_limits"."scope_account_id" is null
             and "spending_limits"."scope_application_id" is null)),
	CONSTRAINT "spending_limits_alert_thresholds_check" CHECK ("spending_limits"."alert_threshold_bps" <@ array[2500, 5000, 7500, 9000, 10000]::smallint[]
        and cardinality("spending_limits"."alert_threshold_bps") <= 5)
);
--> statement-breakpoint
CREATE TABLE "usage_receipt_unit_prices" (
	"receipt_id" text NOT NULL,
	"unit" text NOT NULL,
	"amount" numeric(30, 12) NOT NULL,
	"per" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "usage_receipt_unit_prices_receipt_id_unit_pk" PRIMARY KEY("receipt_id","unit"),
	CONSTRAINT "usage_receipt_unit_prices_unit_check" CHECK ("usage_receipt_unit_prices"."unit" in ('input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'requests', 'images', 'audio_input_milliseconds', 'audio_output_milliseconds', 'video_milliseconds', 'characters', 'embeddings')),
	CONSTRAINT "usage_receipt_unit_prices_amount_check" CHECK ("usage_receipt_unit_prices"."amount" >= 0),
	CONSTRAINT "usage_receipt_unit_prices_per_check" CHECK ("usage_receipt_unit_prices"."per" > 0)
);
--> statement-breakpoint
CREATE TABLE "usage_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"reservation_id" text,
	"corrects_receipt_id" text,
	"account_id" text NOT NULL,
	"application_id" text NOT NULL,
	"application_credential_id" text NOT NULL,
	"delegated_user_id" text,
	"request_id" text NOT NULL,
	"generation_id" text,
	"environment" text NOT NULL,
	"outcome" text NOT NULL,
	"usage_source" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"images" bigint DEFAULT 0 NOT NULL,
	"audio_input_milliseconds" bigint DEFAULT 0 NOT NULL,
	"audio_output_milliseconds" bigint DEFAULT 0 NOT NULL,
	"video_milliseconds" bigint DEFAULT 0 NOT NULL,
	"characters" bigint DEFAULT 0 NOT NULL,
	"embeddings" bigint DEFAULT 0 NOT NULL,
	"resolved_model_reference" text NOT NULL,
	"serving_provider" text NOT NULL,
	"price_version_id" text NOT NULL,
	"billed_amount" numeric(30, 12) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"platform_fee_only" boolean DEFAULT false NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "usage_receipts_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "usage_receipts_reservation_id_key" UNIQUE("reservation_id"),
	CONSTRAINT "usage_receipts_outcome_check" CHECK ("usage_receipts"."outcome" in ('completed', 'partial', 'cancelled', 'failed')),
	CONSTRAINT "usage_receipts_usage_source_check" CHECK ("usage_receipts"."usage_source" in ('provider_reported', 'oxy_measured', 'estimated')),
	CONSTRAINT "usage_receipts_environment_check" CHECK ("usage_receipts"."environment" in ('development', 'staging', 'production')),
	CONSTRAINT "usage_receipts_currency_check" CHECK ("usage_receipts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "usage_receipts_billed_amount_check" CHECK ("usage_receipts"."billed_amount" >= 0),
	CONSTRAINT "usage_receipts_units_check" CHECK ("usage_receipts"."input_tokens" >= 0 and "usage_receipts"."cached_input_tokens" >= 0 and "usage_receipts"."output_tokens" >= 0 and "usage_receipts"."reasoning_tokens" >= 0 and "usage_receipts"."requests" >= 0 and "usage_receipts"."images" >= 0 and "usage_receipts"."audio_input_milliseconds" >= 0 and "usage_receipts"."audio_output_milliseconds" >= 0 and "usage_receipts"."video_milliseconds" >= 0 and "usage_receipts"."characters" >= 0 and "usage_receipts"."embeddings" >= 0),
	CONSTRAINT "usage_receipts_billed_units_check" CHECK ("usage_receipts"."billed_amount" = 0 or ("usage_receipts"."input_tokens" + "usage_receipts"."cached_input_tokens" + "usage_receipts"."output_tokens" + "usage_receipts"."reasoning_tokens" + "usage_receipts"."requests" + "usage_receipts"."images" + "usage_receipts"."audio_input_milliseconds" + "usage_receipts"."audio_output_milliseconds" + "usage_receipts"."video_milliseconds" + "usage_receipts"."characters" + "usage_receipts"."embeddings") > 0),
	CONSTRAINT "usage_receipts_request_id_check" CHECK (length("usage_receipts"."request_id") > 0),
	CONSTRAINT "usage_receipts_resolved_model_reference_check" CHECK (length("usage_receipts"."resolved_model_reference") > 0),
	CONSTRAINT "usage_receipts_serving_provider_check" CHECK (length("usage_receipts"."serving_provider") > 0),
	CONSTRAINT "usage_receipts_corrects_self_check" CHECK ("usage_receipts"."corrects_receipt_id" is null or "usage_receipts"."corrects_receipt_id" <> "usage_receipts"."id")
);
--> statement-breakpoint
CREATE TABLE "usage_refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"account_id" text NOT NULL,
	"request_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"reservation_id" text,
	"receipt_id" text,
	"reason" text NOT NULL,
	"amount" numeric(30, 12) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "usage_refunds_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "usage_refunds_subject_kind_check" CHECK ("usage_refunds"."subject_kind" in ('reservation', 'receipt')),
	CONSTRAINT "usage_refunds_reason_check" CHECK ("usage_refunds"."reason" in ('unused_reservation', 'client_cancelled', 'upstream_failure', 'partial_stream', 'usage_unavailable', 'billing_correction', 'duplicate_charge')),
	CONSTRAINT "usage_refunds_currency_check" CHECK ("usage_refunds"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "usage_refunds_amount_check" CHECK ("usage_refunds"."amount" > 0),
	CONSTRAINT "usage_refunds_request_id_check" CHECK (length("usage_refunds"."request_id") > 0),
	CONSTRAINT "usage_refunds_subject_check" CHECK (("usage_refunds"."subject_kind" = 'reservation'
            and "usage_refunds"."reservation_id" is not null and "usage_refunds"."receipt_id" is null)
        or ("usage_refunds"."subject_kind" = 'receipt'
            and "usage_refunds"."receipt_id" is not null and "usage_refunds"."reservation_id" is null)),
	CONSTRAINT "usage_refunds_unused_reservation_check" CHECK ("usage_refunds"."reason" <> 'unused_reservation' or "usage_refunds"."subject_kind" = 'reservation'),
	CONSTRAINT "usage_refunds_receipt_only_reason_check" CHECK ("usage_refunds"."reason" not in ('billing_correction', 'duplicate_charge')
        or "usage_refunds"."subject_kind" = 'receipt')
);
--> statement-breakpoint
CREATE TABLE "usage_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"account_id" text NOT NULL,
	"application_id" text NOT NULL,
	"application_credential_id" text NOT NULL,
	"delegated_user_id" text,
	"request_id" text NOT NULL,
	"environment" text NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"reserved_amount" numeric(30, 12) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"ceiling_price_version_id" text NOT NULL,
	"max_output_tokens" bigint,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"images" bigint DEFAULT 0 NOT NULL,
	"audio_input_milliseconds" bigint DEFAULT 0 NOT NULL,
	"audio_output_milliseconds" bigint DEFAULT 0 NOT NULL,
	"video_milliseconds" bigint DEFAULT 0 NOT NULL,
	"characters" bigint DEFAULT 0 NOT NULL,
	"embeddings" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "usage_reservations_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "usage_reservations_status_check" CHECK ("usage_reservations"."status" in ('held', 'settled', 'released', 'expired')),
	CONSTRAINT "usage_reservations_environment_check" CHECK ("usage_reservations"."environment" in ('development', 'staging', 'production')),
	CONSTRAINT "usage_reservations_currency_check" CHECK ("usage_reservations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "usage_reservations_reserved_amount_check" CHECK ("usage_reservations"."reserved_amount" > 0),
	CONSTRAINT "usage_reservations_max_output_tokens_check" CHECK ("usage_reservations"."max_output_tokens" is null or "usage_reservations"."max_output_tokens" > 0),
	CONSTRAINT "usage_reservations_request_id_check" CHECK (length("usage_reservations"."request_id") > 0),
	CONSTRAINT "usage_reservations_units_check" CHECK ("usage_reservations"."input_tokens" >= 0 and "usage_reservations"."cached_input_tokens" >= 0 and "usage_reservations"."output_tokens" >= 0 and "usage_reservations"."reasoning_tokens" >= 0 and "usage_reservations"."requests" >= 0 and "usage_reservations"."images" >= 0 and "usage_reservations"."audio_input_milliseconds" >= 0 and "usage_reservations"."audio_output_milliseconds" >= 0 and "usage_reservations"."video_milliseconds" >= 0 and "usage_reservations"."characters" >= 0 and "usage_reservations"."embeddings" >= 0)
);
--> statement-breakpoint
ALTER TABLE "account_balances" ADD CONSTRAINT "account_balances_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoice_receipts" ADD CONSTRAINT "billing_invoice_receipts_receipt_id_usage_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."usage_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoice_receipts" ADD CONSTRAINT "billing_invoice_receipts_invoice_id_billing_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_reservation_id_usage_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."usage_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_receipt_id_usage_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."usage_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_refund_id_usage_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."usage_refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_invoice_id_billing_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_ledger_postings" ADD CONSTRAINT "billing_ledger_postings_entry_id_billing_ledger_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."billing_ledger_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_usage_daily_rollups" ADD CONSTRAINT "inference_usage_daily_rollups_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_usage_daily_rollups" ADD CONSTRAINT "inference_usage_daily_rollups_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_usage_daily_rollups" ADD CONSTRAINT "inference_usage_daily_rollups_application_credential_id_application_credentials_id_fk" FOREIGN KEY ("application_credential_id") REFERENCES "public"."application_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_usage_events" ADD CONSTRAINT "inference_usage_events_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_usage_events" ADD CONSTRAINT "inference_usage_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_usage_events" ADD CONSTRAINT "inference_usage_events_application_credential_id_application_credentials_id_fk" FOREIGN KEY ("application_credential_id") REFERENCES "public"."application_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_version_unit_prices" ADD CONSTRAINT "price_version_unit_prices_price_version_id_price_versions_id_fk" FOREIGN KEY ("price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_supersedes_price_version_id_price_versions_id_fk" FOREIGN KEY ("supersedes_price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_limit_notifications" ADD CONSTRAINT "spending_limit_notifications_spending_limit_id_spending_limits_id_fk" FOREIGN KEY ("spending_limit_id") REFERENCES "public"."spending_limits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_limits" ADD CONSTRAINT "spending_limits_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_limits" ADD CONSTRAINT "spending_limits_scope_account_id_users_id_fk" FOREIGN KEY ("scope_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_limits" ADD CONSTRAINT "spending_limits_scope_application_id_applications_id_fk" FOREIGN KEY ("scope_application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_limits" ADD CONSTRAINT "spending_limits_scope_application_credential_id_application_credentials_id_fk" FOREIGN KEY ("scope_application_credential_id") REFERENCES "public"."application_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_receipt_unit_prices" ADD CONSTRAINT "usage_receipt_unit_prices_receipt_id_usage_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."usage_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_receipts" ADD CONSTRAINT "usage_receipts_reservation_id_usage_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."usage_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_receipts" ADD CONSTRAINT "usage_receipts_corrects_receipt_id_usage_receipts_id_fk" FOREIGN KEY ("corrects_receipt_id") REFERENCES "public"."usage_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_receipts" ADD CONSTRAINT "usage_receipts_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_receipts" ADD CONSTRAINT "usage_receipts_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_receipts" ADD CONSTRAINT "usage_receipts_application_credential_id_application_credentials_id_fk" FOREIGN KEY ("application_credential_id") REFERENCES "public"."application_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_receipts" ADD CONSTRAINT "usage_receipts_price_version_id_price_versions_id_fk" FOREIGN KEY ("price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_refunds" ADD CONSTRAINT "usage_refunds_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_refunds" ADD CONSTRAINT "usage_refunds_reservation_id_usage_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."usage_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_refunds" ADD CONSTRAINT "usage_refunds_receipt_id_usage_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."usage_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_application_credential_id_application_credentials_id_fk" FOREIGN KEY ("application_credential_id") REFERENCES "public"."application_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_ceiling_price_version_id_price_versions_id_fk" FOREIGN KEY ("ceiling_price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_balances_purchased_balance_idx" ON "account_balances" USING btree ("purchased_balance");--> statement-breakpoint
CREATE INDEX "billing_invoice_receipts_invoice_id_idx" ON "billing_invoice_receipts" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "billing_invoices_account_id_period_start_idx" ON "billing_invoices" USING btree ("account_id","period_start" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "billing_invoices_status_idx" ON "billing_invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "billing_ledger_entries_account_id_created_at_idx" ON "billing_ledger_entries" USING btree ("account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "billing_ledger_entries_reservation_id_idx" ON "billing_ledger_entries" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "billing_ledger_entries_receipt_id_idx" ON "billing_ledger_entries" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "billing_ledger_entries_invoice_id_idx" ON "billing_ledger_entries" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "billing_ledger_postings_source_account_idx" ON "billing_ledger_postings" USING btree ("source_account");--> statement-breakpoint
CREATE INDEX "billing_ledger_postings_destination_account_idx" ON "billing_ledger_postings" USING btree ("destination_account");--> statement-breakpoint
CREATE INDEX "billing_profiles_billing_mode_status_idx" ON "billing_profiles" USING btree ("billing_mode","status");--> statement-breakpoint
CREATE INDEX "inference_usage_daily_rollups_account_id_day_idx" ON "inference_usage_daily_rollups" USING btree ("account_id","day" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inference_usage_daily_rollups_application_id_day_idx" ON "inference_usage_daily_rollups" USING btree ("application_id","day" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "inference_usage_events_request_generation_key" ON "inference_usage_events" USING btree ("request_id","generation_id") WHERE "inference_usage_events"."generation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_usage_events_request_key" ON "inference_usage_events" USING btree ("request_id") WHERE "inference_usage_events"."generation_id" is null;--> statement-breakpoint
CREATE INDEX "inference_usage_events_account_id_created_at_idx" ON "inference_usage_events" USING btree ("account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inference_usage_events_application_id_created_at_idx" ON "inference_usage_events" USING btree ("application_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inference_usage_events_application_credential_id_created_at_idx" ON "inference_usage_events" USING btree ("application_credential_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inference_usage_events_created_at_idx" ON "inference_usage_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "price_versions_active_route_key" ON "price_versions" USING btree ("model_reference","provider") WHERE "price_versions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "price_versions_route_effective_from_idx" ON "price_versions" USING btree ("model_reference","provider","effective_from" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "spending_limits_account_id_status_idx" ON "spending_limits" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "spending_limits_account_scope_key" ON "spending_limits" USING btree ("scope_account_id","period") WHERE "spending_limits"."scope_account_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "spending_limits_application_scope_key" ON "spending_limits" USING btree ("scope_application_id","period") WHERE "spending_limits"."scope_application_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "spending_limits_credential_scope_key" ON "spending_limits" USING btree ("scope_application_credential_id","period") WHERE "spending_limits"."scope_application_credential_id" is not null;--> statement-breakpoint
CREATE INDEX "usage_receipts_account_id_settled_at_idx" ON "usage_receipts" USING btree ("account_id","settled_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "usage_receipts_application_id_settled_at_idx" ON "usage_receipts" USING btree ("application_id","settled_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "usage_receipts_application_credential_id_settled_at_idx" ON "usage_receipts" USING btree ("application_credential_id","settled_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "usage_receipts_request_id_idx" ON "usage_receipts" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "usage_receipts_generation_id_idx" ON "usage_receipts" USING btree ("generation_id");--> statement-breakpoint
CREATE INDEX "usage_receipts_estimated_idx" ON "usage_receipts" USING btree ("settled_at") WHERE "usage_receipts"."usage_source" = 'estimated';--> statement-breakpoint
CREATE INDEX "usage_refunds_account_id_created_at_idx" ON "usage_refunds" USING btree ("account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "usage_refunds_reservation_id_idx" ON "usage_refunds" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "usage_refunds_receipt_id_idx" ON "usage_refunds" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "usage_refunds_request_id_idx" ON "usage_refunds" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "usage_reservations_status_expires_at_idx" ON "usage_reservations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "usage_reservations_account_id_created_at_idx" ON "usage_reservations" USING btree ("account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "usage_reservations_request_id_idx" ON "usage_reservations" USING btree ("request_id");