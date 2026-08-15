-- oxy:deploy-phase=pre
--
-- The canonical model catalogue (issue #972, workstreams 5 and 11): publishers,
-- models, immutable model revisions, inference providers, deployments/endpoints
-- and routing profiles as six distinct objects, per docs/adr/0008.
--
-- WHY `pre`.
--
-- Purely additive: eight new tables, no column added to an existing one, no
-- constraint narrowed, no row rewritten. The question the repo's gate rule asks
-- is not "does it add" but "does it break a write the PREVIOUS image performs",
-- and nothing in the running image knows these tables exist -- the catalogue it
-- serves today is a hardcoded array in `routes/models-stats.ts`. So the
-- outgoing image is unaffected while this is applied, which is what `pre` means.
--
-- It must NOT be `post`. A zero-capacity deploy exits before the post-migration
-- step, so a `post` marker would strand this indefinitely and queue every
-- subsequent `pre` behind it -- and the arriving image's catalogue routes read
-- these tables on their first request.
--
-- DEFAULT DENY IS IN THE DDL, not in a service. `inference_deployments`
-- defaults `permission_state` to 'pending_review' and `status` to 'disabled',
-- and the read path requires 'approved' -- so a route inserted by any path at
-- all, including a future import or a `psql` session, is unselectable until
-- somebody deliberately approves it.
--
-- `inference_deployments.price_version_id` references the LEDGER's
-- `price_versions` (0033), `ON DELETE RESTRICT`. It will not fire in ordinary
-- operation -- price versions are append-only, so retirement is
-- `status = 'superseded'` plus `effective_until`, never a DELETE -- but a price
-- version that priced a live route must not be removable, or the route quotes a
-- price nothing can reproduce.
--
-- The immutability of a model revision is NOT here: a CHECK sees only the new
-- row, never the old, so it needs a trigger, which drizzle-kit cannot emit.
-- That is 0036, and its authoritative text lives in
-- `src/db/schema/inferenceModelRevisions.ts` so a regeneration of this file has
-- something to restore it from.

CREATE TABLE "inference_deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"model_revision_id" text NOT NULL,
	"provider_slug" text NOT NULL,
	"regions" text[] NOT NULL,
	"retains_payloads" boolean NOT NULL,
	"retention_days" integer NOT NULL,
	"trains_on_customer_data" boolean NOT NULL,
	"zero_data_retention_available" boolean NOT NULL,
	"subprocessors" text[],
	"policy_url" text,
	"availability_scope" text NOT NULL,
	"commercial_permission" text NOT NULL,
	"permission_state" text DEFAULT 'pending_review' NOT NULL,
	"permission_state_changed_at" timestamp with time zone,
	"permission_state_changed_by_user_id" text,
	"permission_state_note" text,
	"legal_review_status" text DEFAULT 'not_started' NOT NULL,
	"legal_review_evidence_ref" text,
	"legal_reviewed_at" timestamp with time zone,
	"legal_reviewed_by_user_id" text,
	"status" text DEFAULT 'disabled' NOT NULL,
	"dedicated_capacity" boolean DEFAULT false NOT NULL,
	"price_version_id" text,
	"internal_route_id" text,
	"upstream_wholesale_cost_amount" numeric(30, 12),
	"upstream_wholesale_cost_currency" text,
	"upstream_wholesale_cost_unit" text,
	"upstream_wholesale_cost_per" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_deployments_revision_provider_scope_key" UNIQUE("model_revision_id","provider_slug","availability_scope"),
	CONSTRAINT "inference_deployments_regions_check" CHECK (cardinality("inference_deployments"."regions") >= 1),
	CONSTRAINT "inference_deployments_availability_scope_check" CHECK ("inference_deployments"."availability_scope" in ('internal_alia', 'public_payg', 'enterprise', 'byok_only', 'oxy_hosted')),
	CONSTRAINT "inference_deployments_commercial_permission_check" CHECK ("inference_deployments"."commercial_permission" in ('standard_application_use', 'public_resale_approved', 'wholesale_contract', 'customer_byok', 'open_weight_hosting')),
	CONSTRAINT "inference_deployments_permission_state_check" CHECK ("inference_deployments"."permission_state" in ('pending_review', 'approved', 'restricted', 'suspended', 'retired')),
	CONSTRAINT "inference_deployments_legal_review_status_check" CHECK ("inference_deployments"."legal_review_status" in ('not_started', 'in_review', 'approved', 'rejected')),
	CONSTRAINT "inference_deployments_status_check" CHECK ("inference_deployments"."status" in ('active', 'degraded', 'disabled', 'retired')),
	CONSTRAINT "inference_deployments_retention_coherent" CHECK ("inference_deployments"."retention_days" >= 0 and "inference_deployments"."retention_days" <= 3650 and ("inference_deployments"."retains_payloads" or "inference_deployments"."retention_days" = 0)),
	CONSTRAINT "inference_deployments_training_requires_retention" CHECK ("inference_deployments"."retains_payloads" or not "inference_deployments"."trains_on_customer_data"),
	CONSTRAINT "inference_deployments_public_requires_resale_permission" CHECK ("inference_deployments"."availability_scope" <> 'public_payg' or "inference_deployments"."commercial_permission" in ('public_resale_approved', 'wholesale_contract', 'open_weight_hosting')),
	CONSTRAINT "inference_deployments_byok_permission" CHECK ("inference_deployments"."availability_scope" <> 'byok_only' or "inference_deployments"."commercial_permission" = 'customer_byok'),
	CONSTRAINT "inference_deployments_byok_has_no_price_version" CHECK ("inference_deployments"."availability_scope" <> 'byok_only' or "inference_deployments"."price_version_id" is null),
	CONSTRAINT "inference_deployments_approval_requires_legal_review" CHECK ("inference_deployments"."permission_state" <> 'approved' or "inference_deployments"."legal_review_status" = 'approved'),
	CONSTRAINT "inference_deployments_legal_approval_has_evidence" CHECK ("inference_deployments"."legal_review_status" <> 'approved' or ("inference_deployments"."legal_reviewed_at" is not null and length(btrim(coalesce("inference_deployments"."legal_review_evidence_ref", ''))) > 0)),
	CONSTRAINT "inference_deployments_wholesale_cost_is_whole" CHECK (num_nonnulls("inference_deployments"."upstream_wholesale_cost_amount", "inference_deployments"."upstream_wholesale_cost_currency", "inference_deployments"."upstream_wholesale_cost_unit", "inference_deployments"."upstream_wholesale_cost_per") in (0, 4)),
	CONSTRAINT "inference_deployments_wholesale_cost_shape" CHECK (("inference_deployments"."upstream_wholesale_cost_amount" is null or "inference_deployments"."upstream_wholesale_cost_amount" >= 0)
        and ("inference_deployments"."upstream_wholesale_cost_per" is null or "inference_deployments"."upstream_wholesale_cost_per" > 0)
        and ("inference_deployments"."upstream_wholesale_cost_currency" is null or "inference_deployments"."upstream_wholesale_cost_currency" ~ '^[A-Z]{3}$')
        and ("inference_deployments"."upstream_wholesale_cost_unit" is null or "inference_deployments"."upstream_wholesale_cost_unit" = any(array['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'requests', 'images', 'audio_input_milliseconds', 'audio_output_milliseconds', 'video_milliseconds', 'characters', 'embeddings']::text[])))
);
--> statement-breakpoint
CREATE TABLE "inference_model_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"model_revision_id" text NOT NULL,
	"suite" text NOT NULL,
	"metric" text NOT NULL,
	"score" text NOT NULL,
	"evaluated_at" timestamp with time zone,
	"report_url" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_model_evaluations_revision_suite_metric_key" UNIQUE("model_revision_id","suite","metric")
);
--> statement-breakpoint
CREATE TABLE "inference_model_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"revision" text NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"released_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	"artifact_digest" text,
	"model_card_url" text,
	"content_filtering_default" text,
	"provenance_marking" text,
	"safety_card_url" text,
	"known_limitations" text[],
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_model_revisions_model_id_revision_key" UNIQUE("model_id","revision"),
	CONSTRAINT "inference_model_revisions_revision_format" CHECK ("inference_model_revisions"."revision" ~ '^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$'),
	CONSTRAINT "inference_model_revisions_artifact_digest_format" CHECK ("inference_model_revisions"."artifact_digest" is null or "inference_model_revisions"."artifact_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "inference_model_revisions_safety_is_whole" CHECK (("inference_model_revisions"."content_filtering_default" is null) = ("inference_model_revisions"."provenance_marking" is null)),
	CONSTRAINT "inference_model_revisions_content_filtering_check" CHECK ("inference_model_revisions"."content_filtering_default" is null or "inference_model_revisions"."content_filtering_default" in ('none', 'provider_default', 'strict')),
	CONSTRAINT "inference_model_revisions_provenance_marking_check" CHECK ("inference_model_revisions"."provenance_marking" is null or "inference_model_revisions"."provenance_marking" in ('none', 'visible_watermark', 'invisible_watermark', 'c2pa')),
	CONSTRAINT "inference_model_revisions_retired_after_released" CHECK ("inference_model_revisions"."retired_at" is null or "inference_model_revisions"."retired_at" > "inference_model_revisions"."released_at")
);
--> statement-breakpoint
CREATE TABLE "inference_models" (
	"id" text PRIMARY KEY NOT NULL,
	"publisher_slug" text NOT NULL,
	"slug" text NOT NULL,
	"model_id" text GENERATED ALWAYS AS (publisher_slug || '/' || slug) STORED,
	"display_name" text NOT NULL,
	"description" text,
	"input_modalities" text[] NOT NULL,
	"output_modalities" text[] NOT NULL,
	"supports_tools" boolean NOT NULL,
	"supports_parallel_tool_calls" boolean NOT NULL,
	"supports_structured_output" boolean NOT NULL,
	"supports_json_mode" boolean NOT NULL,
	"supports_reasoning" boolean NOT NULL,
	"supports_streaming" boolean NOT NULL,
	"supports_prompt_caching" boolean NOT NULL,
	"max_context_tokens" integer NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"license_id" text NOT NULL,
	"license_display_name" text NOT NULL,
	"license_url" text,
	"commercial_use_allowed" boolean NOT NULL,
	"requires_attribution" boolean NOT NULL,
	"acceptable_use_policy_url" text,
	"base_model_attribution_required" boolean DEFAULT false NOT NULL,
	"release_kind" text NOT NULL,
	"base_model_reference" text,
	"training_organization" text,
	"knowledge_cutoff" date,
	"released_on" date,
	"deprecation_status" text DEFAULT 'active' NOT NULL,
	"replacement_model_reference" text,
	"deprecation_announced_at" timestamp with time zone,
	"deprecation_sunset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_models_publisher_slug_key" UNIQUE("publisher_slug","slug"),
	CONSTRAINT "inference_models_slug_format" CHECK ("inference_models"."slug" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'),
	CONSTRAINT "inference_models_input_modalities_check" CHECK (cardinality("inference_models"."input_modalities") >= 1 and "inference_models"."input_modalities" <@ array['text', 'image', 'audio', 'video', 'embedding']::text[]),
	CONSTRAINT "inference_models_output_modalities_check" CHECK (cardinality("inference_models"."output_modalities") >= 1 and "inference_models"."output_modalities" <@ array['text', 'image', 'audio', 'video', 'embedding']::text[]),
	CONSTRAINT "inference_models_token_limits_check" CHECK ("inference_models"."max_context_tokens" > 0 and "inference_models"."max_output_tokens" > 0),
	CONSTRAINT "inference_models_release_kind_check" CHECK ("inference_models"."release_kind" in ('first_party_original', 'first_party_derived', 'open_weight', 'third_party_hosted')),
	CONSTRAINT "inference_models_deprecation_status_check" CHECK ("inference_models"."deprecation_status" in ('active', 'deprecated', 'retired')),
	CONSTRAINT "inference_models_base_model_reference_format" CHECK ("inference_models"."base_model_reference" is null or "inference_models"."base_model_reference" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:@[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?)?$'),
	CONSTRAINT "inference_models_replacement_reference_format" CHECK ("inference_models"."replacement_model_reference" is null or "inference_models"."replacement_model_reference" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:@[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?)?$'),
	CONSTRAINT "inference_models_active_has_no_sunset" CHECK (not ("inference_models"."deprecation_status" = 'active' and "inference_models"."deprecation_sunset_at" is not null)),
	CONSTRAINT "inference_models_reserved_namespace_is_first_party" CHECK (not ("inference_models"."publisher_slug" = 'alia' and "inference_models"."release_kind" not in ('first_party_original', 'first_party_derived')))
);
--> statement-breakpoint
CREATE TABLE "inference_providers" (
	"slug" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"kind" text NOT NULL,
	"website_url" text,
	"status_page_url" text,
	"regions" text[],
	"retains_payloads" boolean NOT NULL,
	"retention_days" integer NOT NULL,
	"trains_on_customer_data" boolean NOT NULL,
	"zero_data_retention_available" boolean NOT NULL,
	"subprocessors" text[],
	"policy_url" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_providers_slug_format" CHECK ("inference_providers"."slug" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'),
	CONSTRAINT "inference_providers_kind_check" CHECK ("inference_providers"."kind" in ('third_party', 'oxy_hosted', 'customer_byok')),
	CONSTRAINT "inference_providers_retention_coherent" CHECK ("inference_providers"."retention_days" >= 0 and "inference_providers"."retention_days" <= 3650 and ("inference_providers"."retains_payloads" or "inference_providers"."retention_days" = 0)),
	CONSTRAINT "inference_providers_training_requires_retention" CHECK ("inference_providers"."retains_payloads" or not "inference_providers"."trains_on_customer_data")
);
--> statement-breakpoint
CREATE TABLE "inference_publishers" (
	"slug" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"website_url" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_publishers_slug_format" CHECK ("inference_publishers"."slug" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$')
);
--> statement-breakpoint
CREATE TABLE "inference_routing_profile_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"routing_profile_id" text NOT NULL,
	"model_id" text,
	"model_revision_id" text,
	"priority" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_routing_profile_candidates_names_exactly_one" CHECK (("inference_routing_profile_candidates"."model_id" is null) <> ("inference_routing_profile_candidates"."model_revision_id" is null)),
	CONSTRAINT "inference_routing_profile_candidates_priority_range" CHECK ("inference_routing_profile_candidates"."priority" between 0 and 1000)
);
--> statement-breakpoint
CREATE TABLE "inference_routing_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"optimise_for" text NOT NULL,
	"is_product_preset" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_routing_profiles_slug_unique" UNIQUE("slug"),
	CONSTRAINT "inference_routing_profiles_slug_format" CHECK ("inference_routing_profiles"."slug" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'),
	CONSTRAINT "inference_routing_profiles_optimise_for_check" CHECK ("inference_routing_profiles"."optimise_for" in ('price', 'latency', 'throughput', 'quality', 'balanced'))
);
--> statement-breakpoint
ALTER TABLE "inference_deployments" ADD CONSTRAINT "inference_deployments_model_revision_id_inference_model_revisions_id_fk" FOREIGN KEY ("model_revision_id") REFERENCES "public"."inference_model_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_deployments" ADD CONSTRAINT "inference_deployments_provider_slug_inference_providers_slug_fk" FOREIGN KEY ("provider_slug") REFERENCES "public"."inference_providers"("slug") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_deployments" ADD CONSTRAINT "inference_deployments_permission_state_changed_by_user_id_users_id_fk" FOREIGN KEY ("permission_state_changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_deployments" ADD CONSTRAINT "inference_deployments_legal_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("legal_reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_deployments" ADD CONSTRAINT "inference_deployments_price_version_id_price_versions_id_fk" FOREIGN KEY ("price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_model_evaluations" ADD CONSTRAINT "inference_model_evaluations_model_revision_id_inference_model_revisions_id_fk" FOREIGN KEY ("model_revision_id") REFERENCES "public"."inference_model_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_model_revisions" ADD CONSTRAINT "inference_model_revisions_model_id_inference_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."inference_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_models" ADD CONSTRAINT "inference_models_publisher_slug_inference_publishers_slug_fk" FOREIGN KEY ("publisher_slug") REFERENCES "public"."inference_publishers"("slug") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_routing_profile_candidates" ADD CONSTRAINT "inference_routing_profile_candidates_routing_profile_id_inference_routing_profiles_id_fk" FOREIGN KEY ("routing_profile_id") REFERENCES "public"."inference_routing_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_routing_profile_candidates" ADD CONSTRAINT "inference_routing_profile_candidates_model_id_inference_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."inference_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_routing_profile_candidates" ADD CONSTRAINT "inference_routing_profile_candidates_model_revision_id_inference_model_revisions_id_fk" FOREIGN KEY ("model_revision_id") REFERENCES "public"."inference_model_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inference_deployments_scope_permission_status_idx" ON "inference_deployments" USING btree ("availability_scope","permission_state","status");--> statement-breakpoint
CREATE INDEX "inference_deployments_model_revision_id_idx" ON "inference_deployments" USING btree ("model_revision_id");--> statement-breakpoint
CREATE INDEX "inference_deployments_provider_slug_idx" ON "inference_deployments" USING btree ("provider_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "inference_model_revisions_one_current_per_model" ON "inference_model_revisions" USING btree ("model_id") WHERE "inference_model_revisions"."is_current";--> statement-breakpoint
CREATE INDEX "inference_model_revisions_model_id_released_at_idx" ON "inference_model_revisions" USING btree ("model_id","released_at");--> statement-breakpoint
CREATE INDEX "inference_models_publisher_slug_idx" ON "inference_models" USING btree ("publisher_slug");--> statement-breakpoint
CREATE INDEX "inference_models_model_id_idx" ON "inference_models" USING btree ("model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inference_routing_profile_candidates_profile_model_key" ON "inference_routing_profile_candidates" USING btree ("routing_profile_id","model_id") WHERE "inference_routing_profile_candidates"."model_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_routing_profile_candidates_profile_revision_key" ON "inference_routing_profile_candidates" USING btree ("routing_profile_id","model_revision_id") WHERE "inference_routing_profile_candidates"."model_revision_id" is not null;--> statement-breakpoint
CREATE INDEX "inference_routing_profile_candidates_profile_priority_idx" ON "inference_routing_profile_candidates" USING btree ("routing_profile_id","priority");