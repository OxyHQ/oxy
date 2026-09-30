-- oxy:deploy-phase=pre
--
-- Audio-token usage units (@oxy.so/contracts 4.4.0, inference contract set
-- 3.2.0): `audio_input_tokens`, `cached_audio_input_tokens` and
-- `audio_output_tokens`, metered by audio chat and realtime models and priced
-- apart from text tokens. Each ledger table built from `usageUnitColumns()` gains
-- the three columns, and every CHECK that enumerates the unit vocabulary is
-- re-created with it.
--
-- PRE: the arriving image writes every `USAGE_UNIT_COLUMN_KEYS` column, so the
-- columns must exist before it serves; the image still serving never names them.
--
-- LOCKING: `ADD COLUMN … DEFAULT 0 NOT NULL` is metadata-only (a constant
-- default needs no rewrite). The re-created CHECKs are `NOT VALID`, as 0123's
-- were: each is strictly WIDER than the one it replaces — the new columns are 0
-- on every existing row and the unit lists only gain members — so no existing
-- row can violate them, and skipping the scan keeps `inference_usage_events`
-- (the highest-volume table in the schema) from being held ACCESS EXCLUSIVE for
-- a full-table scan inside the migrator's single transaction.
ALTER TABLE "inference_deployments" DROP CONSTRAINT "inference_deployments_wholesale_cost_shape";--> statement-breakpoint
ALTER TABLE "inference_routing_policy_price_caps" DROP CONSTRAINT "inference_routing_policy_price_caps_unit_check";--> statement-breakpoint
ALTER TABLE "inference_usage_daily_rollups" DROP CONSTRAINT "inference_usage_daily_rollups_units_check";--> statement-breakpoint
ALTER TABLE "inference_usage_events" DROP CONSTRAINT "inference_usage_events_units_check";--> statement-breakpoint
ALTER TABLE "price_version_unit_prices" DROP CONSTRAINT "price_version_unit_prices_unit_check";--> statement-breakpoint
ALTER TABLE "usage_receipt_unit_prices" DROP CONSTRAINT "usage_receipt_unit_prices_unit_check";--> statement-breakpoint
ALTER TABLE "usage_receipts" DROP CONSTRAINT "usage_receipts_units_check";--> statement-breakpoint
ALTER TABLE "usage_receipts" DROP CONSTRAINT "usage_receipts_billed_units_check";--> statement-breakpoint
ALTER TABLE "usage_reservations" DROP CONSTRAINT "usage_reservations_units_check";--> statement-breakpoint
ALTER TABLE "inference_usage_daily_rollups" ADD COLUMN "audio_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_usage_daily_rollups" ADD COLUMN "cached_audio_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_usage_daily_rollups" ADD COLUMN "audio_output_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_usage_events" ADD COLUMN "audio_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_usage_events" ADD COLUMN "cached_audio_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_usage_events" ADD COLUMN "audio_output_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_receipts" ADD COLUMN "audio_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_receipts" ADD COLUMN "cached_audio_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_receipts" ADD COLUMN "audio_output_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD COLUMN "audio_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD COLUMN "cached_audio_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD COLUMN "audio_output_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_deployments" ADD CONSTRAINT "inference_deployments_wholesale_cost_shape" CHECK (("inference_deployments"."upstream_wholesale_cost_amount" is null or "inference_deployments"."upstream_wholesale_cost_amount" >= 0)
        and ("inference_deployments"."upstream_wholesale_cost_per" is null or "inference_deployments"."upstream_wholesale_cost_per" > 0)
        and ("inference_deployments"."upstream_wholesale_cost_currency" is null or "inference_deployments"."upstream_wholesale_cost_currency" ~ '^[A-Z]{3}$')
        and ("inference_deployments"."upstream_wholesale_cost_unit" is null or "inference_deployments"."upstream_wholesale_cost_unit" = any(array['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'requests', 'images', 'audio_input_milliseconds', 'audio_output_milliseconds', 'video_milliseconds', 'characters', 'embeddings', 'audio_input_tokens', 'cached_audio_input_tokens', 'audio_output_tokens']::text[]))) NOT VALID;--> statement-breakpoint
ALTER TABLE "inference_routing_policy_price_caps" ADD CONSTRAINT "inference_routing_policy_price_caps_unit_check" CHECK ("inference_routing_policy_price_caps"."unit" in ('input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'requests', 'images', 'audio_input_milliseconds', 'audio_output_milliseconds', 'video_milliseconds', 'characters', 'embeddings', 'audio_input_tokens', 'cached_audio_input_tokens', 'audio_output_tokens')) NOT VALID;--> statement-breakpoint
ALTER TABLE "inference_usage_daily_rollups" ADD CONSTRAINT "inference_usage_daily_rollups_units_check" CHECK ("inference_usage_daily_rollups"."input_tokens" >= 0 and "inference_usage_daily_rollups"."cached_input_tokens" >= 0 and "inference_usage_daily_rollups"."output_tokens" >= 0 and "inference_usage_daily_rollups"."reasoning_tokens" >= 0 and "inference_usage_daily_rollups"."requests" >= 0 and "inference_usage_daily_rollups"."images" >= 0 and "inference_usage_daily_rollups"."audio_input_milliseconds" >= 0 and "inference_usage_daily_rollups"."audio_output_milliseconds" >= 0 and "inference_usage_daily_rollups"."video_milliseconds" >= 0 and "inference_usage_daily_rollups"."characters" >= 0 and "inference_usage_daily_rollups"."embeddings" >= 0 and "inference_usage_daily_rollups"."audio_input_tokens" >= 0 and "inference_usage_daily_rollups"."cached_audio_input_tokens" >= 0 and "inference_usage_daily_rollups"."audio_output_tokens" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "inference_usage_events" ADD CONSTRAINT "inference_usage_events_units_check" CHECK ("inference_usage_events"."input_tokens" >= 0 and "inference_usage_events"."cached_input_tokens" >= 0 and "inference_usage_events"."output_tokens" >= 0 and "inference_usage_events"."reasoning_tokens" >= 0 and "inference_usage_events"."requests" >= 0 and "inference_usage_events"."images" >= 0 and "inference_usage_events"."audio_input_milliseconds" >= 0 and "inference_usage_events"."audio_output_milliseconds" >= 0 and "inference_usage_events"."video_milliseconds" >= 0 and "inference_usage_events"."characters" >= 0 and "inference_usage_events"."embeddings" >= 0 and "inference_usage_events"."audio_input_tokens" >= 0 and "inference_usage_events"."cached_audio_input_tokens" >= 0 and "inference_usage_events"."audio_output_tokens" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "price_version_unit_prices" ADD CONSTRAINT "price_version_unit_prices_unit_check" CHECK ("price_version_unit_prices"."unit" in ('input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'requests', 'images', 'audio_input_milliseconds', 'audio_output_milliseconds', 'video_milliseconds', 'characters', 'embeddings', 'audio_input_tokens', 'cached_audio_input_tokens', 'audio_output_tokens')) NOT VALID;--> statement-breakpoint
ALTER TABLE "usage_receipt_unit_prices" ADD CONSTRAINT "usage_receipt_unit_prices_unit_check" CHECK ("usage_receipt_unit_prices"."unit" in ('input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'requests', 'images', 'audio_input_milliseconds', 'audio_output_milliseconds', 'video_milliseconds', 'characters', 'embeddings', 'audio_input_tokens', 'cached_audio_input_tokens', 'audio_output_tokens')) NOT VALID;--> statement-breakpoint
ALTER TABLE "usage_receipts" ADD CONSTRAINT "usage_receipts_units_check" CHECK ("usage_receipts"."input_tokens" >= 0 and "usage_receipts"."cached_input_tokens" >= 0 and "usage_receipts"."output_tokens" >= 0 and "usage_receipts"."reasoning_tokens" >= 0 and "usage_receipts"."requests" >= 0 and "usage_receipts"."images" >= 0 and "usage_receipts"."audio_input_milliseconds" >= 0 and "usage_receipts"."audio_output_milliseconds" >= 0 and "usage_receipts"."video_milliseconds" >= 0 and "usage_receipts"."characters" >= 0 and "usage_receipts"."embeddings" >= 0 and "usage_receipts"."audio_input_tokens" >= 0 and "usage_receipts"."cached_audio_input_tokens" >= 0 and "usage_receipts"."audio_output_tokens" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "usage_receipts" ADD CONSTRAINT "usage_receipts_billed_units_check" CHECK ("usage_receipts"."billed_amount" = 0 or ("usage_receipts"."input_tokens" + "usage_receipts"."cached_input_tokens" + "usage_receipts"."output_tokens" + "usage_receipts"."reasoning_tokens" + "usage_receipts"."requests" + "usage_receipts"."images" + "usage_receipts"."audio_input_milliseconds" + "usage_receipts"."audio_output_milliseconds" + "usage_receipts"."video_milliseconds" + "usage_receipts"."characters" + "usage_receipts"."embeddings" + "usage_receipts"."audio_input_tokens" + "usage_receipts"."cached_audio_input_tokens" + "usage_receipts"."audio_output_tokens") > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_units_check" CHECK ("usage_reservations"."input_tokens" >= 0 and "usage_reservations"."cached_input_tokens" >= 0 and "usage_reservations"."output_tokens" >= 0 and "usage_reservations"."reasoning_tokens" >= 0 and "usage_reservations"."requests" >= 0 and "usage_reservations"."images" >= 0 and "usage_reservations"."audio_input_milliseconds" >= 0 and "usage_reservations"."audio_output_milliseconds" >= 0 and "usage_reservations"."video_milliseconds" >= 0 and "usage_reservations"."characters" >= 0 and "usage_reservations"."embeddings" >= 0 and "usage_reservations"."audio_input_tokens" >= 0 and "usage_reservations"."cached_audio_input_tokens" >= 0 and "usage_reservations"."audio_output_tokens" >= 0) NOT VALID;