-- oxy:deploy-phase=pre
--
-- The routing policy control plane (issue #972, workstream 6): a customer's own
-- routing configuration, versioned so a request can name the exact revision it
-- executed under, plus the persisted route-switch notice.
--
-- WHY `pre`.
--
-- Additive: five new tables, and on an existing table exactly one NULLABLE
-- column with no default (`usage_receipts.routing_policy_version_id`). No
-- constraint is narrowed, no row is rewritten, no column is dropped.
--
-- The question the repo's gate rule asks is not "does it add" but "does it break
-- a write the PREVIOUS image performs". It does not. Nothing in the running
-- image knows these tables exist, and the one existing table touched gains a
-- column the outgoing image never names -- `settle()` builds its insert from an
-- explicit column list, so a column it does not mention is simply DEFAULT NULL,
-- which is exactly what the new column allows. An `ADD COLUMN` with no default
-- and no NOT NULL is also a catalogue-only change in PostgreSQL: it rewrites no
-- heap pages and takes an ACCESS EXCLUSIVE lock only for the moment it updates
-- `pg_attribute`.
--
-- It must NOT be `post`. A zero-capacity deploy exits before the post-migration
-- step, so a `post` marker would strand this indefinitely and queue every
-- subsequent `pre` behind it -- and the arriving image's routing-policy routes
-- read these tables on their first request.
--
-- WHY `usage_receipts` GAINS THE COLUMN NULLABLE, on a table that is append-only
-- and can therefore never be backfilled: the writer that will always have a
-- policy version to supply is the public inference edge (workstream 4), which
-- does not exist yet. Making the column NOT NULL now would force today's ledger
-- and shadow-metering callers to invent a value, and an invented policy
-- reference on a financial record is worse than an absent one. Tightening it
-- belongs with the edge, and is safe to do then because this table holds no
-- production rows.
--
-- THE COMPOSITE FOREIGN KEYS ARE LOAD-BEARING, not stylistic. Three of them
-- state an equality a CHECK cannot reach across tables:
--
--   price_caps (version_id, currency)   -> versions (id, price_ceiling_currency)
--     every price ceiling on one policy is in the SAME currency, and a ceiling
--     cannot exist on a version that declares none (NULL matches no key).
--
--   fallbacks (version_id, fallback_disabled) -> versions (id, fallback_disabled)
--     a cross-model destination cannot attach to a version whose fallback is
--     disabled. Paired with the child's own `not fallback_disabled` CHECK, that
--     makes "fallback disabled, and here is what to fall back to" unwritable.
--
--   route_switch_events (authorization_id, routing_policy_version_id)
--     -> fallbacks (id, version_id)
--     a recorded model substitution names the customer authorisation that
--     permitted it AND the version that authorisation belongs to, so it cannot
--     cite one policy's permission while claiming to have run under another.
--
-- Each target is a real `UNIQUE` CONSTRAINT, never a `CREATE UNIQUE INDEX`:
-- drizzle-kit emits every foreign key before every unique index, so an index
-- target does not exist yet when the constraint is added and the migration fails
-- at apply time with `42830`.
--
-- The immutability of a policy version is NOT here: a CHECK sees only the new
-- row, never the old, so it needs a trigger, which drizzle-kit cannot emit. That
-- is 0040, and its authoritative text lives in
-- `src/db/schema/inferenceRoutingImmutability.ts` so a regeneration of this file
-- has something to restore it from.

CREATE TABLE "inference_route_switch_events" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"account_id" text NOT NULL,
	"application_id" text NOT NULL,
	"environment" text NOT NULL,
	"routing_policy_version_id" text NOT NULL,
	"scope" text NOT NULL,
	"reason" text NOT NULL,
	"from_model_reference" text NOT NULL,
	"to_model_reference" text NOT NULL,
	"to_provider" text NOT NULL,
	"to_deployment_id" text,
	"requested_model_id" text,
	"authorization_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_route_switch_events_sequence_key" UNIQUE("request_id","sequence"),
	CONSTRAINT "inference_route_switch_events_scope_check" CHECK ("inference_route_switch_events"."scope" in ('deployment', 'model')),
	CONSTRAINT "inference_route_switch_events_reason_check" CHECK ("inference_route_switch_events"."reason" in ('deployment_unavailable', 'provider_error', 'provider_timeout', 'provider_overloaded', 'rate_limited', 'capacity', 'policy_preference')),
	CONSTRAINT "inference_route_switch_events_environment_check" CHECK ("inference_route_switch_events"."environment" in ('development', 'staging', 'production')),
	CONSTRAINT "inference_route_switch_events_sequence_range" CHECK ("inference_route_switch_events"."sequence" >= 0),
	CONSTRAINT "inference_route_switch_events_from_format" CHECK ("inference_route_switch_events"."from_model_reference" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:@[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?)?$'),
	CONSTRAINT "inference_route_switch_events_to_format" CHECK ("inference_route_switch_events"."to_model_reference" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:@[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?)?$'),
	CONSTRAINT "inference_route_switch_events_requested_format" CHECK ("inference_route_switch_events"."requested_model_id" is null or "inference_route_switch_events"."requested_model_id" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'),
	CONSTRAINT "inference_route_switch_events_request_id_check" CHECK (length("inference_route_switch_events"."request_id") > 0),
	CONSTRAINT "inference_route_switch_events_provider_check" CHECK (length("inference_route_switch_events"."to_provider") > 0),
	CONSTRAINT "inference_route_switch_events_deployment_shape" CHECK ("inference_route_switch_events"."scope" <> 'deployment' or (
        "inference_route_switch_events"."from_model_reference" = "inference_route_switch_events"."to_model_reference"
        and "inference_route_switch_events"."requested_model_id" is null
        and "inference_route_switch_events"."authorization_id" is null
      )),
	CONSTRAINT "inference_route_switch_events_model_shape" CHECK ("inference_route_switch_events"."scope" <> 'model' or (
        "inference_route_switch_events"."requested_model_id" is not null
        and "inference_route_switch_events"."authorization_id" is not null
        and "inference_route_switch_events"."from_model_reference" <> "inference_route_switch_events"."to_model_reference"
      ))
);
--> statement-breakpoint
CREATE TABLE "inference_routing_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_kind" text NOT NULL,
	"account_id" text NOT NULL,
	"application_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_routing_policies_scope_kind_check" CHECK ("inference_routing_policies"."scope_kind" in ('account', 'application')),
	CONSTRAINT "inference_routing_policies_status_check" CHECK ("inference_routing_policies"."status" in ('active', 'archived')),
	CONSTRAINT "inference_routing_policies_scope_target_check" CHECK (("inference_routing_policies"."scope_kind" = 'application') = ("inference_routing_policies"."application_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "inference_routing_policy_fallbacks" (
	"id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"fallback_disabled" boolean DEFAULT false NOT NULL,
	"model_id" text,
	"model_revision_id" text,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_routing_policy_fallbacks_id_version_key" UNIQUE("id","version_id"),
	CONSTRAINT "inference_routing_policy_fallbacks_position_key" UNIQUE("version_id","position"),
	CONSTRAINT "inference_routing_policy_fallbacks_not_disabled" CHECK (not "inference_routing_policy_fallbacks"."fallback_disabled"),
	CONSTRAINT "inference_routing_policy_fallbacks_names_one" CHECK (("inference_routing_policy_fallbacks"."model_id" is null) <> ("inference_routing_policy_fallbacks"."model_revision_id" is null)),
	CONSTRAINT "inference_routing_policy_fallbacks_position_range" CHECK ("inference_routing_policy_fallbacks"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inference_routing_policy_price_caps" (
	"version_id" text NOT NULL,
	"unit" text NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(30, 12) NOT NULL,
	"per" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_routing_policy_price_caps_version_id_unit_pk" PRIMARY KEY("version_id","unit"),
	CONSTRAINT "inference_routing_policy_price_caps_unit_check" CHECK ("inference_routing_policy_price_caps"."unit" in ('input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'requests', 'images', 'audio_input_milliseconds', 'audio_output_milliseconds', 'video_milliseconds', 'characters', 'embeddings')),
	CONSTRAINT "inference_routing_policy_price_caps_currency_format" CHECK ("inference_routing_policy_price_caps"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "inference_routing_policy_price_caps_amount_check" CHECK ("inference_routing_policy_price_caps"."amount" >= 0),
	CONSTRAINT "inference_routing_policy_price_caps_per_check" CHECK ("inference_routing_policy_price_caps"."per" > 0)
);
--> statement-breakpoint
CREATE TABLE "inference_routing_policy_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"routing_policy_id" text NOT NULL,
	"version" integer NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"default_target_kind" text,
	"default_model_id" text,
	"default_model_revision_id" text,
	"default_routing_profile_id" text,
	"provider_allowlist" text[] NOT NULL,
	"provider_denylist" text[] NOT NULL,
	"allowed_regions" text[] NOT NULL,
	"denied_regions" text[] NOT NULL,
	"require_zero_data_retention" boolean NOT NULL,
	"prohibit_training_on_customer_data" boolean NOT NULL,
	"price_ceiling_currency" text,
	"max_price_per_request_amount" numeric(30, 12),
	"optimise_for" text NOT NULL,
	"oxy_hosted_only" boolean NOT NULL,
	"allowed_license_ids" text[] NOT NULL,
	"require_commercial_use_rights" boolean NOT NULL,
	"fallback_disabled" boolean NOT NULL,
	"same_model_deployment_fallback" boolean NOT NULL,
	"byok_preference" text NOT NULL,
	"dedicated_capacity" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_routing_policy_versions_version_key" UNIQUE("routing_policy_id","version"),
	CONSTRAINT "inference_routing_policy_versions_currency_key" UNIQUE("id","price_ceiling_currency"),
	CONSTRAINT "inference_routing_policy_versions_fallback_key" UNIQUE("id","fallback_disabled"),
	CONSTRAINT "inference_routing_policy_versions_version_range" CHECK ("inference_routing_policy_versions"."version" >= 1),
	CONSTRAINT "inference_routing_policy_versions_optimise_for_check" CHECK ("inference_routing_policy_versions"."optimise_for" in ('price', 'latency', 'throughput', 'balanced')),
	CONSTRAINT "inference_routing_policy_versions_byok_check" CHECK ("inference_routing_policy_versions"."byok_preference" in ('disabled', 'prefer', 'require')),
	CONSTRAINT "inference_routing_policy_versions_capacity_check" CHECK ("inference_routing_policy_versions"."dedicated_capacity" in ('disabled', 'prefer', 'require')),
	CONSTRAINT "inference_routing_policy_versions_target_kind_check" CHECK ("inference_routing_policy_versions"."default_target_kind" is null or "inference_routing_policy_versions"."default_target_kind" in ('model', 'routing_profile')),
	CONSTRAINT "inference_routing_policy_versions_target_check" CHECK ((
        "inference_routing_policy_versions"."default_target_kind" is null
        and "inference_routing_policy_versions"."default_model_id" is null
        and "inference_routing_policy_versions"."default_model_revision_id" is null
        and "inference_routing_policy_versions"."default_routing_profile_id" is null
      ) or (
        "inference_routing_policy_versions"."default_target_kind" is not distinct from 'routing_profile'
        and "inference_routing_policy_versions"."default_routing_profile_id" is not null
        and "inference_routing_policy_versions"."default_model_id" is null
        and "inference_routing_policy_versions"."default_model_revision_id" is null
      ) or (
        "inference_routing_policy_versions"."default_target_kind" is not distinct from 'model'
        and "inference_routing_policy_versions"."default_routing_profile_id" is null
        and (("inference_routing_policy_versions"."default_model_id" is null) <> ("inference_routing_policy_versions"."default_model_revision_id" is null))
      )),
	CONSTRAINT "inference_routing_policy_versions_provider_conflict" CHECK (not ("inference_routing_policy_versions"."provider_allowlist" && "inference_routing_policy_versions"."provider_denylist")),
	CONSTRAINT "inference_routing_policy_versions_region_conflict" CHECK (not ("inference_routing_policy_versions"."allowed_regions" && "inference_routing_policy_versions"."denied_regions")),
	CONSTRAINT "inference_routing_policy_versions_fallback_conflict" CHECK (not ("inference_routing_policy_versions"."fallback_disabled" and "inference_routing_policy_versions"."same_model_deployment_fallback")),
	CONSTRAINT "inference_routing_policy_versions_hosting_conflict" CHECK (not ("inference_routing_policy_versions"."oxy_hosted_only" and "inference_routing_policy_versions"."byok_preference" = 'require')),
	CONSTRAINT "inference_routing_policy_versions_currency_format" CHECK ("inference_routing_policy_versions"."price_ceiling_currency" is null or "inference_routing_policy_versions"."price_ceiling_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "inference_routing_policy_versions_request_cap_check" CHECK ("inference_routing_policy_versions"."max_price_per_request_amount" is null
        or ("inference_routing_policy_versions"."max_price_per_request_amount" >= 0 and "inference_routing_policy_versions"."price_ceiling_currency" is not null))
);
--> statement-breakpoint
ALTER TABLE "usage_receipts" ADD COLUMN "routing_policy_version_id" text;--> statement-breakpoint
ALTER TABLE "inference_route_switch_events" ADD CONSTRAINT "inference_route_switch_events_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_route_switch_events" ADD CONSTRAINT "inference_route_switch_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_route_switch_events" ADD CONSTRAINT "inference_route_switch_events_routing_policy_version_id_inference_routing_policy_versions_id_fk" FOREIGN KEY ("routing_policy_version_id") REFERENCES "public"."inference_routing_policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_route_switch_events" ADD CONSTRAINT "inference_route_switch_events_authorization_fk" FOREIGN KEY ("authorization_id","routing_policy_version_id") REFERENCES "public"."inference_routing_policy_fallbacks"("id","version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_routing_policies" ADD CONSTRAINT "inference_routing_policies_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_routing_policies" ADD CONSTRAINT "inference_routing_policies_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_routing_policies" ADD CONSTRAINT "inference_routing_policies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_routing_policy_fallbacks" ADD CONSTRAINT "inference_routing_policy_fallbacks_model_id_inference_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."inference_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_routing_policy_fallbacks" ADD CONSTRAINT "inference_routing_policy_fallbacks_model_revision_id_inference_model_revisions_id_fk" FOREIGN KEY ("model_revision_id") REFERENCES "public"."inference_model_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_routing_policy_fallbacks" ADD CONSTRAINT "inference_routing_policy_fallbacks_version_fk" FOREIGN KEY ("version_id","fallback_disabled") REFERENCES "public"."inference_routing_policy_versions"("id","fallback_disabled") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_routing_policy_price_caps" ADD CONSTRAINT "inference_routing_policy_price_caps_version_fk" FOREIGN KEY ("version_id","currency") REFERENCES "public"."inference_routing_policy_versions"("id","price_ceiling_currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_routing_policy_versions" ADD CONSTRAINT "inference_routing_policy_versions_routing_policy_id_inference_routing_policies_id_fk" FOREIGN KEY ("routing_policy_id") REFERENCES "public"."inference_routing_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_routing_policy_versions" ADD CONSTRAINT "inference_routing_policy_versions_default_model_id_inference_models_id_fk" FOREIGN KEY ("default_model_id") REFERENCES "public"."inference_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_routing_policy_versions" ADD CONSTRAINT "inference_routing_policy_versions_default_model_revision_id_inference_model_revisions_id_fk" FOREIGN KEY ("default_model_revision_id") REFERENCES "public"."inference_model_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_routing_policy_versions" ADD CONSTRAINT "inference_routing_policy_versions_default_routing_profile_id_inference_routing_profiles_id_fk" FOREIGN KEY ("default_routing_profile_id") REFERENCES "public"."inference_routing_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_routing_policy_versions" ADD CONSTRAINT "inference_routing_policy_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inference_route_switch_events_account_id_occurred_at_idx" ON "inference_route_switch_events" USING btree ("account_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inference_route_switch_events_application_id_occurred_at_idx" ON "inference_route_switch_events" USING btree ("application_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inference_route_switch_events_request_id_idx" ON "inference_route_switch_events" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inference_routing_policies_account_scope_key" ON "inference_routing_policies" USING btree ("account_id") WHERE "inference_routing_policies"."scope_kind" = 'account' and "inference_routing_policies"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "inference_routing_policies_application_scope_key" ON "inference_routing_policies" USING btree ("application_id") WHERE "inference_routing_policies"."application_id" is not null and "inference_routing_policies"."status" = 'active';--> statement-breakpoint
CREATE INDEX "inference_routing_policies_account_id_idx" ON "inference_routing_policies" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inference_routing_policy_fallbacks_model_key" ON "inference_routing_policy_fallbacks" USING btree ("version_id","model_id") WHERE "inference_routing_policy_fallbacks"."model_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_routing_policy_fallbacks_revision_key" ON "inference_routing_policy_fallbacks" USING btree ("version_id","model_revision_id") WHERE "inference_routing_policy_fallbacks"."model_revision_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_routing_policy_versions_current_key" ON "inference_routing_policy_versions" USING btree ("routing_policy_id") WHERE "inference_routing_policy_versions"."is_current";--> statement-breakpoint
CREATE INDEX "inference_routing_policy_versions_policy_id_idx" ON "inference_routing_policy_versions" USING btree ("routing_policy_id","version");--> statement-breakpoint
ALTER TABLE "usage_receipts" ADD CONSTRAINT "usage_receipts_routing_policy_version_id_inference_routing_policy_versions_id_fk" FOREIGN KEY ("routing_policy_version_id") REFERENCES "public"."inference_routing_policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_receipts_routing_policy_version_id_idx" ON "usage_receipts" USING btree ("routing_policy_version_id") WHERE "usage_receipts"."routing_policy_version_id" is not null;
