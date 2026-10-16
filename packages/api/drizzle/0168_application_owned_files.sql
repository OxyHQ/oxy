-- oxy:deploy-phase=pre
--
-- Application-owned files (ADR 0043): an Oxy APPLICATION becomes the third
-- principal that can own a `files` row, beside an account and a system
-- namespace, so platform artwork no person owns (Mercaria's category tiles)
-- is not hung off an arbitrary user account.
--
--  * files.owner_application_id (new, nullable): FK applications(id)
--    ON DELETE RESTRICT. Never CASCADE: a cascade would drop the rows and the
--    only record of their storage keys with them, so the bytes would never be
--    purged. Whoever removes an application tombstones its files first.
--  * files_owner_exclusive_check: exactly one of owner_user_id, system_owner,
--    owner_application_id (was: one of the first two).
--  * files_owner_application_id_sha256_live_key: one live row per application
--    per content hash, mirroring the two per-owner uniques of 0124.
--  * files_owner_application_id_created_at_idx: the application's cursor list
--    and the RESTRICT probe on an application delete.
--  * the three scopes CHECKs (applications, application_credentials,
--    application_workload_identities) widen to `files:app:write` and
--    `files:app:delete`.
--
-- PRE. Every statement is correct against BOTH images: the column is new and
-- NULL on every row, and the image still serving never writes it; the owner
-- CHECK is equivalent to the old one on every row whose new column is NULL,
-- which is every row that image can write; the scope CHECKs only widen.
--
-- ## LOCKS
--
-- `files` holds every stored asset. Drizzle runs every pending migration in ONE
-- transaction, so CONCURRENTLY and a separate VALIDATE are unavailable here
-- (see 0100, 0123, 0124).
--
--  * ADD COLUMN (nullable, no default) is a catalogue change, no rewrite.
--  * The FOREIGN KEY and the owner CHECK are added NOT VALID, as 0123 did:
--    enforced on every write from here on, without the full-table scan a
--    validating ADD would run under its lock. Skipping it is safe because no
--    existing row has an owner_application_id, so both hold on every one by
--    construction. `ALTER TABLE files VALIDATE CONSTRAINT …` can be run later,
--    out of band, under SHARE UPDATE EXCLUSIVE (writes continue).
--  * Each CREATE INDEX holds SHARE on `files` for its build: reads continue,
--    every upload/delete/visibility write BLOCKS for a time proportional to
--    the table (0124 measured ~1 s per million rows locally). On a large
--    `files`, build both OUT OF BAND first, with no transaction and no write
--    lock, and let this migration find the work done —
--
--   ALTER TABLE files ADD COLUMN IF NOT EXISTS owner_application_id text;
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS files_owner_application_id_sha256_live_key ON files USING btree (owner_application_id, sha256) WHERE status in ('active', 'trash') and owner_application_id is not null;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS files_owner_application_id_created_at_idx ON files USING btree (owner_application_id, created_at DESC NULLS LAST, id DESC NULLS LAST) WHERE owner_application_id is not null;
--
--   (the column is safe to add early: nullable, unread by the serving image).
--   `IF NOT EXISTS` on the column and both indexes below is load-bearing for
--   that route; afterwards this migration is catalogue work only.
--
-- A failed CREATE INDEX CONCURRENTLY leaves an INVALID index under the same
-- name that `IF NOT EXISTS` would silently accept; the guard refuses it.
ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "application_workload_identities" DROP CONSTRAINT "application_workload_identities_scopes_check";--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_scopes_check";--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_owner_exclusive_check";--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "owner_application_id" text;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_owner_application_id_applications_id_fk" FOREIGN KEY ("owner_application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "files_owner_application_id_sha256_live_key" ON "files" USING btree ("owner_application_id","sha256") WHERE "files"."status" in ('active', 'trash') and "files"."owner_application_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_owner_application_id_created_at_idx" ON "files" USING btree ("owner_application_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "files"."owner_application_id" is not null;--> statement-breakpoint
DO $$
DECLARE
  invalid text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO invalid
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relname IN ('files_owner_application_id_sha256_live_key', 'files_owner_application_id_created_at_idx')
    AND NOT i.indisvalid;
  IF invalid IS NOT NULL THEN
    RAISE EXCEPTION 'files application-owner index not valid: %. A CREATE INDEX CONCURRENTLY failed part-way; DROP INDEX CONCURRENTLY it and build it again before migrating.', invalid;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_scopes_check" CHECK ("application_credentials"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'alia:chat', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'organizations:import', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'accounts:membership:read', 'podcasts:write', 'linked-accounts:read', 'files:user-media:write', 'federation:identities:resolve', 'federation:instance-fetch', 'files:app:write', 'files:app:delete']::text[]);--> statement-breakpoint
ALTER TABLE "application_workload_identities" ADD CONSTRAINT "application_workload_identities_scopes_check" CHECK ("application_workload_identities"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'alia:chat', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'organizations:import', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'accounts:membership:read', 'podcasts:write', 'linked-accounts:read', 'files:user-media:write', 'federation:identities:resolve', 'federation:instance-fetch', 'files:app:write', 'files:app:delete']::text[]);--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_scopes_check" CHECK ("applications"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'alia:chat', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'organizations:import', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'accounts:membership:read', 'podcasts:write', 'linked-accounts:read', 'files:user-media:write', 'federation:identities:resolve', 'federation:instance-fetch', 'files:app:write', 'files:app:delete']::text[]);--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_owner_exclusive_check" CHECK (num_nonnulls("files"."owner_user_id", "files"."system_owner", "files"."owner_application_id") = 1) NOT VALID;