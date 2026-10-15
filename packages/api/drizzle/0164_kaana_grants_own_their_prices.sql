-- oxy:deploy-phase=pre
--
-- Kaana ADR 0002, amendment 2026-10-15: the model catalogue, prices included,
-- is Kaana's. A grant for kaana.ai/v1 is rated at the list price Kaana
-- declared, copied onto the grant when it is signed.
--
--  * kaana_grant_line_unit_prices (new): the unit prices of an admitted line,
--    the evidence the grant's settlement is rated against.
--  * kaana_grant_admitted_lines.currency (new): the currency of that list.
--    NOT NULL without a default is safe here: no grant has shipped (the table
--    arrived in 0159 with no caller until Kaana serves kaana.ai/v1).
--  * four price_version_id columns lose their foreign key to price_versions
--    (usage_receipts, usage_reservations, inference_metered_usage,
--    kaana_grant_admitted_lines): they now also carry Kaana's own
--    priceVersionId, which no Oxy table resolves. A receipt does not need the
--    key: the entries it was charged at are copied into usage_receipt_unit_prices.
--    Dropping a constraint only widens what the columns accept, so the image
--    still serving is unaffected.
CREATE TABLE "kaana_grant_line_unit_prices" (
	"grant_id" text NOT NULL,
	"step_index" smallint NOT NULL,
	"model_line" text NOT NULL,
	"unit" text NOT NULL,
	"amount" numeric(30, 12) NOT NULL,
	"per" bigint NOT NULL,
	CONSTRAINT "kaana_grant_line_unit_prices_grant_id_step_index_model_line_unit_pk" PRIMARY KEY("grant_id","step_index","model_line","unit"),
	CONSTRAINT "kaana_grant_line_unit_prices_amount_check" CHECK ("kaana_grant_line_unit_prices"."amount" >= 0),
	CONSTRAINT "kaana_grant_line_unit_prices_per_check" CHECK ("kaana_grant_line_unit_prices"."per" > 0)
);
--> statement-breakpoint
ALTER TABLE "inference_metered_usage" DROP CONSTRAINT "inference_metered_usage_settled_price_version_id_price_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "kaana_grant_admitted_lines" DROP CONSTRAINT "kaana_grant_admitted_lines_price_version_id_price_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "usage_receipts" DROP CONSTRAINT "usage_receipts_price_version_id_price_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "usage_reservations" DROP CONSTRAINT "usage_reservations_ceiling_price_version_id_price_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "kaana_grant_admitted_lines" ADD COLUMN "currency" text NOT NULL;--> statement-breakpoint
ALTER TABLE "kaana_grant_line_unit_prices" ADD CONSTRAINT "kaana_grant_line_unit_prices_line_fk" FOREIGN KEY ("grant_id","step_index","model_line") REFERENCES "public"."kaana_grant_admitted_lines"("grant_id","step_index","model_line") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kaana_grant_admitted_lines" ADD CONSTRAINT "kaana_grant_admitted_lines_currency_check" CHECK ("kaana_grant_admitted_lines"."currency" ~ '^[A-Z]{3}$');