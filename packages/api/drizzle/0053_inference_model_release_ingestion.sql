-- oxy:deploy-phase=pre
--
-- Ingesting a signed Alia model release manifest, and the EU AI Act / GPAI
-- documentation record that travels with it (#972 workstream 12: "accept model
-- card, license, provenance/base model, evaluation results, safety results and
-- artifact digests", "store/publicize the customer-safe documentation needed by
-- downstream developers", "preserve metadata needed for EU AI Act/GPAI
-- documentation and transparency workflows").
--
-- Four NEW tables and nothing else. No column is dropped, no constraint is added
-- to an existing table, and no existing row is read or rewritten.
--
-- WHY `pre`
--
-- The test is whether a RUNNING IMAGE writes a value this migration forbids, and
-- there is nothing for it to forbid: every constraint here is on a table that
-- does not exist yet, so no image can hold a row that violates one. The four
-- tables are additive, which also means the OLD image keeps working unchanged
-- while they exist and nothing is written to them.
--
-- `pre` is additionally the safer side, for the reason `0050` gives: a
-- zero-capacity deploy exits before the post-deploy migration step entirely, and
-- a skipped `post` never lands later — every subsequent `pre` queues behind it
-- until somebody unblocks it by hand.
--
-- NO BACK-FILL, because there is nothing to back-fill. `inference_models` and
-- `inference_model_revisions` are both empty in production (counted read-only,
-- see `0050`'s header), and every parent row these tables reference would have to
-- exist first.
--
-- THE THREE TRIGGERS AT THE BOTTOM ARE HAND-WRITTEN
--
-- drizzle-kit emits tables, constraints and indexes from a schema file and cannot
-- emit a trigger, so regenerating the table DDL above would silently drop them.
-- The authoritative text lives in the schema, as the exported constants of
-- `src/db/schema/inferenceModelReleaseImmutability.ts`, and
-- `src/db/schema/__tests__/inferenceModelDocumentation.test.ts` fails naming any
-- missing trigger AND compares this file against those constants, so the two
-- cannot drift. Same arrangement as
-- `0043_application_credential_audit_immutability.sql` and
-- `0050_inference_model_provenance_marking.sql`.
--
-- WHAT THEY REFUSE, AND THE ONE COLUMN THEY DO NOT
--
-- `inference_model_releases.manifest_json` is the bytes a release signature
-- covers. Editing it would make a broken signature indistinguishable from a
-- forged one to whoever eventually runs the check, so the five columns the
-- signature covers are refused on UPDATE.
--
-- `ingested_by_user_id` is deliberately NOT among them: it is `ON DELETE SET
-- NULL` on `users`, which performs an UPDATE, and a trigger refusing that would
-- turn deleting a staff account into a constraint failure on a compliance
-- record. The two child tables have no such column, so their trigger refuses
-- every UPDATE outright and one function serves both.
--
-- `inference_model_gpai_documentation` gets NO trigger, deliberately: the
-- Commission may designate a model as carrying systemic risk after it was
-- released (Article 51(1)(b)), and a republished copyright policy or
-- training-content summary moves. That documentation is republished, exactly as
-- `inference_model_revisions.model_card_url` already is.
--
-- `SQLSTATE 23514` (check_violation) rather than a bespoke code, so `@oxyhq/db`'s
-- `isCheckViolation` recognises it like any other constraint failure.

CREATE TABLE "inference_model_gpai_documentation" (
	"id" text PRIMARY KEY NOT NULL,
	"model_revision_id" text NOT NULL,
	"intended_tasks" text,
	"distribution_methods" text[] NOT NULL,
	"architecture" text,
	"parameter_count" bigint,
	"training_data_summary_url" text NOT NULL,
	"copyright_policy_url" text NOT NULL,
	"systemic_risk" text NOT NULL,
	"free_and_open_source_release" boolean NOT NULL,
	"training_compute_flops" text,
	"training_time_hours" double precision,
	"energy_consumption_mwh" double precision,
	"adversarial_testing_report_url" text,
	"recorded_at" timestamp with time zone NOT NULL,
	"recorded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_model_gpai_documentation_model_revision_id_key" UNIQUE("model_revision_id"),
	CONSTRAINT "inference_model_gpai_documentation_distribution_methods_check" CHECK (cardinality("inference_model_gpai_documentation"."distribution_methods") >= 1 and "inference_model_gpai_documentation"."distribution_methods" <@ array['oxy_api', 'downloadable_weights']::text[]),
	CONSTRAINT "inference_model_gpai_documentation_systemic_risk_check" CHECK ("inference_model_gpai_documentation"."systemic_risk" in ('not_designated', 'presumed_by_training_compute', 'designated_by_commission')),
	CONSTRAINT "inference_model_gpai_documentation_training_compute_format" CHECK ("inference_model_gpai_documentation"."training_compute_flops" is null or "inference_model_gpai_documentation"."training_compute_flops" ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?(e\+?(0|[1-9][0-9]?))?$'),
	CONSTRAINT "inference_model_gpai_documentation_annex_xi_or_exempt" CHECK (("inference_model_gpai_documentation"."free_and_open_source_release" and "inference_model_gpai_documentation"."systemic_risk" = 'not_designated') or ("inference_model_gpai_documentation"."intended_tasks" is not null and "inference_model_gpai_documentation"."architecture" is not null and "inference_model_gpai_documentation"."parameter_count" is not null and "inference_model_gpai_documentation"."training_time_hours" is not null and "inference_model_gpai_documentation"."energy_consumption_mwh" is not null)),
	CONSTRAINT "inference_model_gpai_documentation_presumption_has_compute" CHECK ("inference_model_gpai_documentation"."systemic_risk" <> 'presumed_by_training_compute' or "inference_model_gpai_documentation"."training_compute_flops" is not null),
	CONSTRAINT "inference_model_gpai_documentation_compute_matches_risk" CHECK ("inference_model_gpai_documentation"."training_compute_flops" is null or case when "inference_model_gpai_documentation"."training_compute_flops" ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?(e\+?(0|[1-9][0-9]?))?$' then not ("inference_model_gpai_documentation"."training_compute_flops"::double precision >= 1e25 and "inference_model_gpai_documentation"."systemic_risk" = 'not_designated') else false end),
	CONSTRAINT "inference_model_gpai_documentation_systemic_risk_has_report" CHECK ("inference_model_gpai_documentation"."systemic_risk" = 'not_designated' or "inference_model_gpai_documentation"."adversarial_testing_report_url" is not null)
);
--> statement-breakpoint
CREATE TABLE "inference_model_release_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"release_id" text NOT NULL,
	"path" text NOT NULL,
	"digest" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"media_type" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_model_release_artifacts_release_id_path_key" UNIQUE("release_id","path"),
	CONSTRAINT "inference_model_release_artifacts_digest_format" CHECK ("inference_model_release_artifacts"."digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "inference_model_release_artifacts_size_positive" CHECK ("inference_model_release_artifacts"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "inference_model_release_signatures" (
	"id" text PRIMARY KEY NOT NULL,
	"release_id" text NOT NULL,
	"algorithm" text NOT NULL,
	"canonicalization" text NOT NULL,
	"key_id" text NOT NULL,
	"signature" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_model_release_signatures_release_id_key_id_key" UNIQUE("release_id","key_id"),
	CONSTRAINT "inference_model_release_signatures_algorithm_check" CHECK ("inference_model_release_signatures"."algorithm" in ('ed25519')),
	CONSTRAINT "inference_model_release_signatures_canonicalization_check" CHECK ("inference_model_release_signatures"."canonicalization" in ('jcs')),
	CONSTRAINT "inference_model_release_signatures_signature_format" CHECK ("inference_model_release_signatures"."signature" ~ '^[A-Za-z0-9_-]{86}$')
);
--> statement-breakpoint
CREATE TABLE "inference_model_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"release_id" text NOT NULL,
	"model_revision_id" text NOT NULL,
	"manifest_schema_version" integer NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"manifest_json" text NOT NULL,
	"ingested_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_model_releases_release_id_key" UNIQUE("release_id")
);
--> statement-breakpoint
ALTER TABLE "inference_model_gpai_documentation" ADD CONSTRAINT "inference_model_gpai_documentation_model_revision_id_inference_model_revisions_id_fk" FOREIGN KEY ("model_revision_id") REFERENCES "public"."inference_model_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_model_gpai_documentation" ADD CONSTRAINT "inference_model_gpai_documentation_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_model_release_artifacts" ADD CONSTRAINT "inference_model_release_artifacts_release_id_inference_model_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."inference_model_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_model_release_signatures" ADD CONSTRAINT "inference_model_release_signatures_release_id_inference_model_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."inference_model_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_model_releases" ADD CONSTRAINT "inference_model_releases_model_revision_id_inference_model_revisions_id_fk" FOREIGN KEY ("model_revision_id") REFERENCES "public"."inference_model_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_model_releases" ADD CONSTRAINT "inference_model_releases_ingested_by_user_id_users_id_fk" FOREIGN KEY ("ingested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inference_model_release_artifacts_digest_idx" ON "inference_model_release_artifacts" USING btree ("digest");--> statement-breakpoint
CREATE OR REPLACE FUNCTION inference_model_release_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changed text;
BEGIN
  changed := CASE
    WHEN new.release_id IS DISTINCT FROM old.release_id THEN 'release_id'
    WHEN new.model_revision_id IS DISTINCT FROM old.model_revision_id THEN 'model_revision_id'
    WHEN new.manifest_schema_version IS DISTINCT FROM old.manifest_schema_version THEN 'manifest_schema_version'
    WHEN new.issued_at IS DISTINCT FROM old.issued_at THEN 'issued_at'
    WHEN new.manifest_json IS DISTINCT FROM old.manifest_json THEN 'manifest_json'
    ELSE null
  END;
  IF changed IS NOT NULL THEN
    RAISE EXCEPTION 'inference_model_releases.% is immutable: the stored manifest is the bytes a signature covers, and editing it makes a broken signature indistinguishable from a forged one', changed
      USING ERRCODE = '23514';
  END IF;
  RETURN new;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inference_model_releases_immutable
BEFORE UPDATE ON inference_model_releases
FOR EACH ROW EXECUTE FUNCTION inference_model_release_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION inference_model_release_child_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: it records what a release signature covers, so a correction is a new release rather than an %', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inference_model_release_artifacts_immutable
BEFORE UPDATE ON inference_model_release_artifacts
FOR EACH ROW EXECUTE FUNCTION inference_model_release_child_immutable();
--> statement-breakpoint
CREATE TRIGGER inference_model_release_signatures_immutable
BEFORE UPDATE ON inference_model_release_signatures
FOR EACH ROW EXECUTE FUNCTION inference_model_release_child_immutable();
