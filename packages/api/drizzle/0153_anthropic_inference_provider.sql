-- oxy:deploy-phase=pre
-- Anthropic as a first-class inference provider (docs/inference/catalogue.md,
-- "Where the facts come from", step 3). Kaana serves Anthropic directly through
-- its Messages adapter (OxyHQ/Kaana#166, provider slug `anthropic`), and the
-- catalogue sync skips every route on a provider Oxy holds no data-policy row
-- for (`unknown_provider`). This row is that data policy, provisioned by the
-- migrator every deploy runs rather than by a one-off script.
--
-- The facts describe the route Kaana actually calls: the Claude API under
-- Oxy's ordinary commercial organization, with no zero-data-retention
-- arrangement asserted. Sources, read 2026-10-11:
--
--   * retention: "we automatically delete inputs and outputs on our backend
--     within 30 days of receipt or generation" (Anthropic Privacy Center, "How
--     long do you store my organization's data?", updated 2026-07-01). Content
--     flagged by trust and safety may be kept up to 2 years; the recorded value
--     is the documented default, as for every other provider row.
--   * training: "By default, we will not use your inputs or outputs from our
--     commercial products" to train models (Privacy Center, "Is my data used
--     for model training?", updated 2026-08-18).
--   * zero data retention: offered per organization by arrangement with
--     Anthropic ("To request ZDR for your organization, contact the Anthropic
--     sales team"; platform.claude.com/docs/en/manage-claude/api-and-data-retention),
--     and unavailable for Claude Fable 5/5.1 and Mythos 5/5.1. The capability is
--     recorded; the route itself retains for 30 days, so a routing policy with
--     `requireZeroDataRetention` excludes it (it needs `retains_payloads = false`
--     and `retention_days = 0`, not merely the capability).
--
-- Insert-only: a row already present is never rewritten here. The block below
-- refuses the migration when the row that ends up present is not this data
-- policy (for example a `customer_byok` row under the same slug, which the sync
-- would never use for a platform route), instead of leaving the sync silently
-- skipping every Anthropic route.
INSERT INTO "inference_providers" (
	"slug",
	"display_name",
	"kind",
	"website_url",
	"regions",
	"retains_payloads",
	"retention_days",
	"trains_on_customer_data",
	"zero_data_retention_available",
	"subprocessors",
	"policy_url"
)
VALUES (
	'anthropic',
	'Anthropic',
	'third_party',
	'https://www.anthropic.com/',
	NULL,
	true,
	30,
	false,
	true,
	NULL,
	'https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data'
)
ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM "inference_providers"
     WHERE "slug" = 'anthropic'
       AND "kind" = 'third_party'
       AND "retains_payloads" = true
       AND "retention_days" = 30
       AND "trains_on_customer_data" = false
       AND "zero_data_retention_available" = true
  ) THEN
    RAISE EXCEPTION 'inference_providers.anthropic is not the reviewed third-party data policy';
  END IF;
END $$;
