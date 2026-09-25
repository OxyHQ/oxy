-- oxy:deploy-phase=pre
-- Every statement is additive or a widening, so this file is correct against the
-- image still serving AND the one arriving — and `pre` is the only phase that
-- works, because the image that arrives writes `workload` rows on its first
-- attested mint and would fail every one of them for the length of a rollout if
-- the column and the CHECKs landed afterwards.
--
-- Statement by statement:
--
--   * `public_key DROP NOT NULL` widens. The old image never writes NULL there,
--     and no lookup it performs can RETURN a NULL row: every resolver finds a
--     credential with `public_key = $1`, which no NULL satisfies. The one path
--     that could hand it one is the Console credential list, which selects by
--     `application_id` — the new image excludes workload rows from it
--     (`excludeWorkloadRows`), so the exposure is bounded to an old instance
--     serving that one endpoint, for one of the thirteen applications that has a
--     binding, during the rollout itself, and the effect is a row the Console
--     renders oddly rather than anything it can act on.
--   * `workload_identity_id` is a nullable added column with a foreign key. The
--     old image's drizzle model does not name it, and drizzle enumerates columns
--     explicitly (there is no `select *` in this package), so it neither reads nor
--     writes it.
--   * the type CHECK is dropped and re-added one value wider, in ONE transaction
--     (`src/db/migrate.ts` runs a migration file atomically), so there is no
--     instant at which the column is unconstrained. Widening it cannot invalidate
--     a row the old image writes.
--   * the four `workload` CHECKs constrain only rows the old image cannot create.
--     They validate against existing data by construction: every current row has
--     a `public_key`, an id that is a uuid v7 or a 24-character ObjectId hex (so
--     `starts_with(id, 'wl_')` is false), and a NULL `workload_identity_id`.
--
-- NO BACKFILL, deliberately. The thirteen bindings already live in production get
-- their row from their next attested mint — `exchangeWorkloadAttestation` is the
-- single point at which a `wl_…` `credentialId` enters circulation and it
-- materialises the row before minting, so "a token naming a handle has a row the
-- ledger can reference" is a precondition of issuing the token rather than
-- something a migration has to have guessed correctly.

ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_type_check";--> statement-breakpoint
ALTER TABLE "application_credentials" ALTER COLUMN "public_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "application_credentials" ADD COLUMN "workload_identity_id" text;--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_workload_identity_id_application_workload_identities_id_fk" FOREIGN KEY ("workload_identity_id") REFERENCES "public"."application_workload_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_workload_identity_id_key" UNIQUE("workload_identity_id");--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_workload_public_key_check" CHECK (("application_credentials"."type" = 'workload') = ("application_credentials"."public_key" is null));--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_workload_handle_id_check" CHECK (("application_credentials"."type" = 'workload') = starts_with("application_credentials"."id", 'wl_'));--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_workload_inert_check" CHECK ("application_credentials"."type" <> 'workload' or ("application_credentials"."secret_hash" is null and cardinality("application_credentials"."scopes") = 0));--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_workload_identity_only_check" CHECK ("application_credentials"."type" = 'workload' or "application_credentials"."workload_identity_id" is null);--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_type_check" CHECK ("application_credentials"."type" in ('public', 'confidential', 'service', 'machine', 'workload'));