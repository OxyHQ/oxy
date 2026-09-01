-- oxy:deploy-phase=pre
--
-- Two additive schema changes for #972 section 12 (privacy, security and
-- controls), landing together because they ship in one image:
--
--   1. `users.staff_capabilities` — graded platform-staff capabilities, so
--      `is_staff` stops being one global boolean that opens every staff surface.
--   2. `inference_spend_anomalies` — the record of a spend spike that was
--      NOTICED. It blocks nothing.
--
-- The authoritative reasoning for each lives beside its schema:
-- `src/db/schema/users.ts` (`STAFF_CAPABILITIES`) and
-- `src/db/schema/inferenceSpendAnomalies.ts`. What follows is what a reader of
-- THIS file needs to decide whether it is safe to apply.
--
-- WHY `pre`, AND WHY NEITHER CHANGE COULD BE `post`
--
-- The image this ships with READS both: `middleware/requireStaff.ts` selects
-- `staff_capabilities` by name on every graded write, and
-- `services/spendAnomaly.service.ts` plus `GET /inference/admin/spend-anomalies`
-- read and write the new table. A `post` migration applies only AFTER the rollout,
-- so every graded route and every sweep would answer `42703` /
-- `relation does not exist` for the whole window — which is
-- `0013_users_account_categories`' outage, reproduced deliberately.
--
-- `pre` is also safe in the other direction, which is the question that decides
-- the phase: does the image still SERVING write a value this migration forbids?
--   * `users.staff_capabilities` is `NOT NULL DEFAULT '{}'`, and the old image does
--     not write the column at all, so every insert it performs continues to satisfy
--     both the NOT NULL and the CHECK.
--   * `inference_spend_anomalies` is a NEW table with no writer in the old image.
-- Nothing is altered, nothing is dropped, and nothing is back-filled.
--
-- WHY NO BACK-FILL OF `staff_capabilities`, AND WHY THAT IS THE POINT
--
-- Every existing staff member gets `'{}'` — no capabilities. Granting every
-- capability to everyone who already holds `is_staff` would reproduce exactly the
-- state this column exists to end, while reporting that a least-privilege model
-- had been adopted. So the graded surfaces begin by refusing every staff member,
-- and each grant is a deliberate administrative act with a row to point at.
--
-- The operational consequence is stated rather than discovered: after this
-- deploys, `POST /inference/admin/deployments/:id/legal-review`,
-- `POST /inference/admin/deployments/:id/:action`,
-- `POST /billing/accounts/:id/grants`, `POST /billing/accounts/:id/invoices`,
-- `POST /billing/cost-centers` and `DELETE /billing/cost-centers/:slug` answer
-- 403 for everybody until an administrator runs an UPDATE granting the
-- capability. The read surfaces beside them are unaffected.
--
-- THE TWO CHECKS THAT ARE NOT DEFENSIVE PADDING
--
--   * `users_staff_capabilities_check` — `<@` containment against the closed set,
--     the same shape `applications_scopes_check` has. Without it a mistyped grant
--     (`billing:adjustment`) would store happily and gate nothing, and from the
--     database a typo'd capability is indistinguishable from a granted one. `'{}'`
--     satisfies containment trivially, so the default needs no exception.
--   * `inference_spend_anomalies_baseline_median_amount_check` — a ZERO baseline is
--     refused. Every multiple of zero is exceeded, so an account that spent nothing
--     for a fortnight and then spent one cent would be the platform's most
--     anomalous account. The detector filters it; the CHECK is what stops another
--     writer reintroducing it. `threshold_multiple > 1` likewise refuses the
--     configuration that would flag an account for spending a normal amount.
--
-- WHY `inference_spend_anomalies` REFERENCES `users` WITH `CASCADE`
--
-- Every ledger reference into `users` is `RESTRICT`, and this one deliberately is
-- not: an alert about a charge is not the charge. `RESTRICT` here would quietly add
-- this table to the set that makes an account undeletable — that set is DERIVED
-- from `pg_constraint` by `services/accountFinancialHolds.service.ts`, so it would
-- be picked up with nobody deciding — and it would then be reported to a departing
-- customer among the records the law requires Oxy to keep.
--
-- WHY `users.staff_capabilities` HAS NO INDEX
--
-- `applications.capabilities` carries a GIN index because the push-delivery sweep
-- really does scan by element. Every read of THIS column asks "does this one
-- account hold X", answered from the account's own row by primary key, so an index
-- here would be maintained on every user write and read by nothing.
CREATE TABLE "inference_spend_anomalies" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"detected_for_hour" timestamp with time zone NOT NULL,
	"hour_amount" numeric(30, 12) NOT NULL,
	"baseline_median_amount" numeric(30, 12) NOT NULL,
	"threshold_multiple" double precision NOT NULL,
	"observed_days" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_spend_anomalies_account_currency_hour_key" UNIQUE("account_id","currency","detected_for_hour"),
	CONSTRAINT "inference_spend_anomalies_currency_check" CHECK ("inference_spend_anomalies"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "inference_spend_anomalies_hour_amount_check" CHECK ("inference_spend_anomalies"."hour_amount" >= 0),
	CONSTRAINT "inference_spend_anomalies_baseline_median_amount_check" CHECK ("inference_spend_anomalies"."baseline_median_amount" > 0),
	CONSTRAINT "inference_spend_anomalies_threshold_multiple_check" CHECK ("inference_spend_anomalies"."threshold_multiple" > 1),
	CONSTRAINT "inference_spend_anomalies_observed_days_check" CHECK ("inference_spend_anomalies"."observed_days" > 0)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "staff_capabilities" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_spend_anomalies" ADD CONSTRAINT "inference_spend_anomalies_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inference_spend_anomalies_account_id_detected_for_hour_idx" ON "inference_spend_anomalies" USING btree ("account_id","detected_for_hour" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inference_spend_anomalies_detected_for_hour_idx" ON "inference_spend_anomalies" USING btree ("detected_for_hour" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_staff_capabilities_check" CHECK ("users"."staff_capabilities" <@ array['inference:catalogue:publish', 'billing:adjust', 'billing:cost_centers']::text[]);