-- oxy:deploy-phase=pre
--
-- The file lifecycle (ADR 0043 D5) and reference reconciliation (D6).
--
--  * files.unreferenced_since (new, nullable): since when no `file_references`
--    row names the file; NULL while one does. Maintained by the image in the
--    transaction that changes a file's references, under a row lock on the
--    file. An ACCOUNT's file is only marked "not in use" by it; an
--    APPLICATION's file is trashed 24 h after it by `fileLifecycle.worker.ts`.
--  * files.trashed_at (new, nullable): when the file entered `trash`. An
--    application's file is purged (tombstone + `storage_object_deletions`)
--    30 days after it; an account's trash never expires.
--  * three partial indexes, one per sweep step (below).
--  * file_reference_reconciliations / _items: an application's paged
--    inventory of its references for one entity type, diffed on commit; one
--    open session per (application, entity type).
--  * file_lifecycle_sweeps: each sweep run, its lease and its report.
--
-- ## BACKFILL — and why the sweep cannot act on it by itself
--
-- Every live file with no reference gets `unreferenced_since =
-- coalesce(updated_at, created_at)`, and every trashed file `trashed_at =
-- updated_at` (the last write is the best record of when it got there).
-- Taken alone that would make every pre-existing unreferenced application
-- file due for trash on the first sweep. It is not acted on: the sweep's mode
-- defaults to `report` (`FILE_LIFECYCLE_MODE`), which only counts and names
-- what it WOULD do, until an operator has reviewed those reports and switched
-- it to `enforce` (ADR 0043, "Switching the sweep to enforce"). Account files
-- are never trashed or deleted by the sweep in any mode.
--
-- PRE. Every statement is correct against BOTH images: the columns are new
-- and nullable and the image still serving neither reads nor writes them; the
-- tables are new. While that image still serves, a reference it adds or
-- removes does not touch `unreferenced_since` — the sweep re-checks the
-- reference set itself before acting, so a stale value can delay a
-- collection, never cause a wrong one.
--
-- ## LOCKS
--
-- One transaction (the migrator runs every pending migration in one), as 0169
-- explains.
--
--  * ADD COLUMN (nullable, no default) is a catalogue change, no rewrite.
--  * The backfill UPDATE touches every unreferenced live row: ROW EXCLUSIVE on
--    `files`, and a row lock on each row it changes until the migration
--    commits — an upload, delete or visibility change of one of those rows
--    WAITS for it, for as long as the update takes (proportional to the rows
--    it changes). On a large table run it out of band first, in batches,
--    outside a transaction —
--
--   UPDATE files f SET unreferenced_since = coalesce(f.updated_at, f.created_at)
--   WHERE f.id IN (SELECT id FROM files g WHERE g.status <> 'deleted'
--     AND g.unreferenced_since IS NULL
--     AND NOT EXISTS (SELECT 1 FROM file_references r WHERE r.file_id = g.id)
--     LIMIT 10000);   -- repeat until 0 rows
--
--   (with the column added first, as below) and this one finds nothing left.
--  * Each CREATE INDEX holds SHARE on `files` for its build (reads continue,
--    writes block for a time proportional to the table). The same out-of-band
--    route as 0169 applies, and `IF NOT EXISTS` is what lets this migration
--    find the work done —
--
--   ALTER TABLE files ADD COLUMN IF NOT EXISTS unreferenced_since timestamptz;
--   ALTER TABLE files ADD COLUMN IF NOT EXISTS trashed_at timestamptz;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS files_application_unreferenced_since_idx ON files USING btree (unreferenced_since) WHERE owner_application_id is not null and status = 'active' and unreferenced_since is not null;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS files_application_trashed_at_idx ON files USING btree (trashed_at) WHERE owner_application_id is not null and status = 'trash';
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS files_pending_upload_created_at_idx ON files USING btree (created_at) WHERE status = 'active' and owner_user_id is not null and original_name is null and metadata is null;
--
-- A failed CREATE INDEX CONCURRENTLY leaves an INVALID index under the same
-- name that `IF NOT EXISTS` would silently accept; the guard refuses it.
CREATE TABLE "file_lifecycle_sweeps" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"claimed_by" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"samples" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "file_lifecycle_sweeps_mode_check" CHECK ("file_lifecycle_sweeps"."mode" in ('report', 'enforce')),
	CONSTRAINT "file_lifecycle_sweeps_status_check" CHECK ("file_lifecycle_sweeps"."status" in ('running', 'completed', 'failed', 'abandoned'))
);
--> statement-breakpoint
CREATE TABLE "file_reference_reconciliation_items" (
	"session_id" text NOT NULL,
	"file_id" text NOT NULL,
	"entity_id" text NOT NULL,
	CONSTRAINT "file_reference_reconciliation_items_session_id_file_id_entity_id_pk" PRIMARY KEY("session_id","file_id","entity_id")
);
--> statement-breakpoint
CREATE TABLE "file_reference_reconciliations" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "file_reference_reconciliations_status_check" CHECK ("file_reference_reconciliations"."status" in ('open', 'committing', 'committed', 'abandoned')),
	CONSTRAINT "file_reference_reconciliations_item_count_check" CHECK ("file_reference_reconciliations"."item_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "unreferenced_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "trashed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "file_reference_reconciliation_items" ADD CONSTRAINT "file_reference_reconciliation_items_session_id_file_reference_reconciliations_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."file_reference_reconciliations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_reference_reconciliations" ADD CONSTRAINT "file_reference_reconciliations_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_lifecycle_sweeps_started_at_idx" ON "file_lifecycle_sweeps" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "file_lifecycle_sweeps_created_at_idx" ON "file_lifecycle_sweeps" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "file_reference_reconciliations_open_key" ON "file_reference_reconciliations" USING btree ("application_id","entity_type") WHERE "file_reference_reconciliations"."status" in ('open', 'committing');--> statement-breakpoint
CREATE INDEX "file_reference_reconciliations_expires_at_idx" ON "file_reference_reconciliations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_application_unreferenced_since_idx" ON "files" USING btree ("unreferenced_since") WHERE "files"."owner_application_id" is not null and "files"."status" = 'active' and "files"."unreferenced_since" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_application_trashed_at_idx" ON "files" USING btree ("trashed_at") WHERE "files"."owner_application_id" is not null and "files"."status" = 'trash';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_pending_upload_created_at_idx" ON "files" USING btree ("created_at") WHERE "files"."status" = 'active' and "files"."owner_user_id" is not null and "files"."original_name" is null and "files"."metadata" is null;--> statement-breakpoint
DO $$
DECLARE
  invalid text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO invalid
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relname IN ('files_application_unreferenced_since_idx', 'files_application_trashed_at_idx', 'files_pending_upload_created_at_idx')
    AND NOT i.indisvalid;
  IF invalid IS NOT NULL THEN
    RAISE EXCEPTION 'files lifecycle index not valid: %. A CREATE INDEX CONCURRENTLY failed part-way; DROP INDEX CONCURRENTLY it and build it again before migrating.', invalid;
  END IF;
END $$;--> statement-breakpoint
-- The backfill (see the header). Idempotent: rows already set are left alone.
UPDATE "files" f SET "unreferenced_since" = coalesce(f."updated_at", f."created_at")
WHERE f."status" <> 'deleted'
  AND f."unreferenced_since" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "file_references" r WHERE r."file_id" = f."id");--> statement-breakpoint
UPDATE "files" SET "trashed_at" = coalesce("updated_at", "created_at")
WHERE "status" = 'trash' AND "trashed_at" IS NULL;
