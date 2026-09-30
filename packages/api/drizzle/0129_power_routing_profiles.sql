-- oxy:deploy-phase=pre
--
-- Power levels (contract set 3.4.0): a reviewed per-model power class, the
-- seven power-level routing profiles, a per-policy allowed-profile list, and
-- route-switch records authorized by a routing profile (or, for a same-model
-- deployment switch, by the platform default).
--
-- PRE: one new table, nullable columns, an array column with a permanent '{}'
-- default (the image still serving writes policy versions without it, and '{}'
-- is the unrestricted meaning those versions had), a relaxed NOT NULL, and
-- CHECKs that hold on every existing row. The previous image never selects the
-- new columns; the seven new profiles have no candidate rows, so its profile
-- list omits them and a request naming one is refused there as before.
CREATE TABLE "inference_model_power_classes" (
	"model_id" text PRIMARY KEY NOT NULL,
	"power_class" text NOT NULL,
	"evidence_source" text NOT NULL,
	"evidence_url" text NOT NULL,
	"evidence_summary" text NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"reviewed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_model_power_classes_model_id_format" CHECK ("inference_model_power_classes"."model_id" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'),
	CONSTRAINT "inference_model_power_classes_class_check" CHECK ("inference_model_power_classes"."power_class" in ('instant', 'medium', 'high', 'pro', 'ultra')),
	CONSTRAINT "inference_model_power_classes_evidence_check" CHECK (length(btrim("inference_model_power_classes"."evidence_source")) > 0
        and "inference_model_power_classes"."evidence_url" ~ '^https://'
        and length(btrim("inference_model_power_classes"."evidence_summary")) > 0
        and length(btrim("inference_model_power_classes"."reviewed_by")) > 0)
);
--> statement-breakpoint
ALTER TABLE "inference_route_switch_events" DROP CONSTRAINT "inference_route_switch_events_model_shape";--> statement-breakpoint
ALTER TABLE "inference_route_switch_events" ALTER COLUMN "routing_policy_version_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_route_switch_events" ADD COLUMN "routing_profile_id" text;--> statement-breakpoint
ALTER TABLE "inference_routing_policy_versions" ADD COLUMN "allowed_routing_profile_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_routing_profiles" ADD COLUMN "power_level" text;--> statement-breakpoint
ALTER TABLE "inference_routing_profiles" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "inference_route_switch_events" ADD CONSTRAINT "inference_route_switch_events_routing_profile_id_inference_routing_profiles_id_fk" FOREIGN KEY ("routing_profile_id") REFERENCES "public"."inference_routing_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_routing_profiles_power_level_key" ON "inference_routing_profiles" USING btree ("power_level") WHERE "inference_routing_profiles"."power_level" is not null;--> statement-breakpoint
ALTER TABLE "inference_route_switch_events" ADD CONSTRAINT "inference_route_switch_events_authority" CHECK ("inference_route_switch_events"."routing_policy_version_id" is not null
        or "inference_route_switch_events"."routing_profile_id" is not null
        or "inference_route_switch_events"."scope" = 'deployment');--> statement-breakpoint
ALTER TABLE "inference_route_switch_events" ADD CONSTRAINT "inference_route_switch_events_model_shape" CHECK ("inference_route_switch_events"."scope" <> 'model' or (
        "inference_route_switch_events"."requested_model_id" is not null
        and ("inference_route_switch_events"."authorization_id" is not null or "inference_route_switch_events"."routing_profile_id" is not null)
        and "inference_route_switch_events"."from_model_reference" <> "inference_route_switch_events"."to_model_reference"
      ));--> statement-breakpoint
ALTER TABLE "inference_routing_profiles" ADD CONSTRAINT "inference_routing_profiles_power_level_check" CHECK ("inference_routing_profiles"."power_level" is null or ("inference_routing_profiles"."power_level" in ('auto', 'instant', 'medium', 'high', 'xhigh', 'pro', 'ultra') and "inference_routing_profiles"."is_product_preset"));--> statement-breakpoint
ALTER TABLE "inference_routing_profiles" ADD CONSTRAINT "inference_routing_profiles_reasoning_effort_check" CHECK ("inference_routing_profiles"."reasoning_effort" is null or ("inference_routing_profiles"."reasoning_effort" in ('low', 'medium', 'high') and "inference_routing_profiles"."power_level" is not null));
--> statement-breakpoint
-- The seven power levels (contract set 3.4.0) as product-preset routing
-- profiles with FIXED ids, so an application's routing policy can name one as
-- its defaultTarget / allowedRoutingProfileIds identically in every
-- environment. Their candidates are not rows: the edge resolves them per
-- request from the currently servable models of the level's reviewed class.
INSERT INTO "inference_routing_profiles" ("id", "slug", "display_name", "description", "optimise_for", "is_product_preset", "power_level", "reasoning_effort")
VALUES
	('power-auto', 'auto', 'Auto', 'Oxy picks the cheapest power level that suffices for each request (tools, context size, attachments, requested reasoning, structured output) and climbs to the next level only when that level has no servable model. Never climbs past xhigh.', 'price', true, 'auto', NULL),
	('power-instant', 'instant', 'Instant', 'Very cheap, fast small models. No reasoning effort is requested.', 'price', true, 'instant', NULL),
	('power-medium', 'medium', 'Medium', 'Mid-size models at low reasoning effort.', 'price', true, 'medium', 'low'),
	('power-high', 'high', 'High', 'Strong models at medium reasoning effort.', 'price', true, 'high', 'medium'),
	('power-xhigh', 'xhigh', 'Extra high', 'The high-class models at high reasoning effort.', 'price', true, 'xhigh', 'high'),
	('power-pro', 'pro', 'Pro', 'Frontier models at high reasoning effort.', 'price', true, 'pro', 'high'),
	('power-ultra', 'ultra', 'Ultra', 'The heaviest frontier models at the maximum reasoning effort.', 'price', true, 'ultra', 'high')
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- A pre-existing profile already owning one of these slugs would make the
-- insert above skip nothing and fail on the slug key instead; this states the
-- invariant the edge relies on and refuses the migration if it does not hold.
DO $$
BEGIN
  IF (SELECT count(*) FROM "inference_routing_profiles" WHERE "power_level" IS NOT NULL AND "id" = 'power-' || "power_level" AND "slug" = "power_level") <> 7 THEN
    RAISE EXCEPTION 'power-level routing profiles are not the seven expected rows';
  END IF;
END $$;--> statement-breakpoint
-- Reviewed power classes. Source: Artificial Analysis Intelligence Index
-- v4.3.2 (https://artificialanalysis.ai/leaderboards/models), cross-checked
-- against the LMArena text leaderboard, read 2026-09-30. Bands on that index:
-- ultra >= 50, pro 40-49, high 28-39, medium 13-27, instant <= 12, except a
-- publisher's cheapest SKU (nano / flash-lite tier), which is instant on its
-- published price tier. Only models present in Kaana's reference inventory and
-- with a fetched source page are classed; every other model is callable by name
-- and chosen by no power level. docs/inference/power-levels.md has the table.
INSERT INTO "inference_model_power_classes" ("model_id", "power_class", "evidence_source", "evidence_url", "evidence_summary", "reviewed_at", "reviewed_by")
VALUES
	('anthropic/claude-opus-5', 'ultra', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/claude-opus-5', 'AA Intelligence Index 51, rank 15/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('anthropic/claude-fable-5', 'ultra', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/claude-fable-5', 'AA Intelligence Index 50, rank 18/222 (publisher-deprecated; replaced by Fable 5.1) (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('openai/gpt-5.6-sol', 'pro', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gpt-5-6-sol', 'AA Intelligence Index 47 (max effort), rank 25/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('qwen/qwen3.8-max', 'pro', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/qwen3-8-max', 'AA Intelligence Index 45, rank 31/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('z-ai/glm-5.3', 'pro', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/glm-5-3', 'AA Intelligence Index 45 (max effort); #2 of 117 open-weight (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('x-ai/grok-4.6', 'pro', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/grok-4-6', 'AA Intelligence Index 44 (high effort), rank 35/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('moonshotai/kimi-k3', 'pro', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/kimi-k3', 'AA Intelligence Index 44 (max effort); #3 of 117 open-weight (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('anthropic/claude-opus-4.8', 'pro', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/claude-opus-4-8', 'AA Intelligence Index 42 (max effort), rank 47/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('openai/gpt-5.6-terra', 'pro', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gpt-5-6-terra', 'AA Intelligence Index 42 (max effort), rank 46/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('anthropic/claude-opus-4.7', 'pro', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/claude-opus-4-7', 'AA Intelligence Index 41 (max effort), rank 50/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('openai/gpt-5.4', 'high', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gpt-5-4', 'AA Intelligence Index 39 (xhigh effort), rank 60/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('google/gemini-3.7-flash', 'high', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gemini-3-7-flash', 'AA Intelligence Index 39 (high effort), rank 59/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('x-ai/grok-4.5', 'high', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/grok-4-5', 'AA Intelligence Index 39 (high effort), rank 61/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('openai/gpt-5.5', 'high', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gpt-5-5', 'AA Intelligence Index 38 (xhigh effort), rank 62/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('anthropic/claude-sonnet-5', 'high', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/claude-sonnet-5', 'AA Intelligence Index 38 (max effort), rank 63/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('openai/gpt-5.6-luna', 'high', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gpt-5-6-luna', 'AA Intelligence Index 37 (max effort); #6 of 174 in its price tier (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('deepseek/deepseek-v4-pro-0813', 'high', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/deepseek-v4-pro', 'AA Intelligence Index 36 (max effort); #9 of 117 open-weight (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('google/gemini-3.6-flash', 'high', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gemini-3-6-flash', 'AA Intelligence Index 34 (high effort), rank 72/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('deepseek/deepseek-v4-flash-0731', 'high', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/deepseek-v4-flash', 'AA Intelligence Index 34 (max effort); #10 of 117 open-weight (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('z-ai/glm-5.2', 'high', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/glm-5-2', 'AA Intelligence Index 34 (max effort); #12 of 117 open-weight (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('qwen/qwen3.8-27b', 'high', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/qwen3-8-27b', 'AA Intelligence Index 34 (xhigh effort); #1 of 142 in its size class (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('google/gemini-3.5-flash', 'high', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gemini-3-5-flash', 'AA Intelligence Index 33 (high effort), rank 81/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('google/gemini-3.1-pro-preview', 'high', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gemini-3-1-pro-preview', 'AA Intelligence Index 30, rank 91/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('openai/gpt-5.2', 'high', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gpt-5-2', 'AA Intelligence Index 30 (xhigh effort), rank 87/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('minimax/minimax-m3', 'high', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/minimax-m3', 'AA Intelligence Index 29; #18 of 117 open-weight (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('qwen/qwen3.7-max', 'high', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/qwen3-7-max', 'AA Intelligence Index 29, rank 92/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('moonshotai/kimi-k2.6', 'medium', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/kimi-k2-6', 'AA Intelligence Index 27; #21 of 117 open-weight (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('z-ai/glm-5.1', 'medium', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/glm-5-1', 'AA Intelligence Index 26; #22 of 117 open-weight (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('qwen/qwen3.7-plus', 'medium', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/qwen3-7-plus', 'AA Intelligence Index 25 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('x-ai/grok-4.3', 'medium', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/grok-4-3', 'AA Intelligence Index 25 (high effort), rank 118/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('openai/gpt-5.4-mini', 'medium', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gpt-5-4-mini', 'AA Intelligence Index 24 (xhigh effort), rank 125/222 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('minimax/minimax-m2.7', 'medium', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/minimax-m2-7', 'AA Intelligence Index 23 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('anthropic/claude-haiku-4.5', 'medium', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/claude-4-5-haiku', 'AA Intelligence Index 15 non-reasoning, 17 reasoning (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('qwen/qwen3.5-397b-a17b', 'medium', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/qwen3-5-397b-a17b', 'AA Intelligence Index 18 (reasoning) (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('qwen/qwen3.6-35b-a3b', 'medium', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/qwen3-6-35b-a3b', 'AA Intelligence Index 18 (reasoning); #13 of 142 in its size class (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('openai/gpt-5-mini', 'medium', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gpt-5-mini', 'AA Intelligence Index 17 (high effort) (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('google/gemma-4-26b-a4b-it', 'medium', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gemma-4-26b-a4b', 'AA Intelligence Index 17 (reasoning) (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('deepseek/deepseek-v3.2', 'medium', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/deepseek-v3-2', 'AA Intelligence Index 16 non-reasoning (AA estimate) (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('google/gemma-4-31b-it', 'medium', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gemma-4-31b', 'AA Intelligence Index 15 (reasoning) (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('z-ai/glm-4.7-flash', 'medium', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/glm-4-7-flash', 'AA Intelligence Index 15 (reasoning); #18 of 142 in its size class (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('mistralai/mistral-medium-3-5', 'medium', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/mistral-medium-3-5', 'AA Intelligence Index 14 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('nvidia/nemotron-3-super-120b-a12b', 'medium', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/nvidia-nemotron-3-super-120b-a12b', 'AA Intelligence Index 13 (reasoning) (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('google/gemini-3.5-flash-lite', 'instant', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gemini-3-5-flash-lite', 'Publisher''s lowest-cost Flash-Lite tier; AA Intelligence Index 22, #33 of 174 in its price tier (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('openai/gpt-5.4-nano', 'instant', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gpt-5-4-nano', 'Publisher''s smallest nano tier; AA Intelligence Index 21 (xhigh), #41 of 174 in its price tier (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('openai/gpt-5-nano', 'instant', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gpt-5-nano', 'Publisher''s smallest nano tier; AA Intelligence Index 13 (high effort) (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('openai/gpt-oss-120b', 'instant', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gpt-oss-120b', 'AA Intelligence Index 12 (high effort) (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('mistralai/mistral-small-2603', 'instant', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/mistral-small-4', 'AA Intelligence Index 11 (Mistral Small 4, released 2026-03-16) (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('openai/gpt-4.1-mini', 'instant', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gpt-4-1-mini', 'AA Intelligence Index 10 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('google/gemini-2.5-flash', 'instant', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gemini-2-5-flash', 'AA Intelligence Index 10 non-reasoning (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('openai/gpt-oss-20b', 'instant', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gpt-oss-20b', 'AA Intelligence Index 9 (high effort) (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('amazon/nova-2-lite-v1', 'instant', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/nova-2-0-lite', 'AA Intelligence Index 9 non-reasoning (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('openai/gpt-4.1-nano', 'instant', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gpt-4-1-nano', 'AA Intelligence Index 8 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('meta-llama/llama-4-scout', 'instant', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/llama-4-scout', 'AA Intelligence Index 8 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('openai/gpt-4o-mini', 'instant', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/gpt-4o-mini', 'AA Intelligence Index 7 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('meta-llama/llama-3.1-8b-instruct', 'instant', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/llama-3-1-instruct-8b', 'AA Intelligence Index 7 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('nvidia/nemotron-3-nano-30b-a3b', 'instant', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/nvidia-nemotron-3-nano-30b-a3b', 'AA Intelligence Index 7 non-reasoning (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('microsoft/phi-4', 'instant', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/phi-4', 'AA Intelligence Index 6 (AA estimate) (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('amazon/nova-micro-v1', 'instant', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/nova-micro', 'AA Intelligence Index 6 (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR'),
	('mistralai/ministral-8b-2512', 'instant', 'artificial-analysis-intelligence-index/v4.3.2', 'https://artificialanalysis.ai/models/ministral-3-8b', 'AA Intelligence Index 5 (Ministral 3 8B) (read 2026-09-30).', '2026-09-30T00:00:00Z', 'claude-code draft 2026-09-30; owner review in the introducing PR')
ON CONFLICT ("model_id") DO NOTHING;
