-- oxy:deploy-phase=pre
--
-- One live `files` row per OWNER per content hash, instead of one per hash.
--
-- WHY. `files_sha256_live_key` let exactly one live row hold a content hash
-- across the whole table, so the upload paths' dedup handed that one row — its
-- id, its links and its delete authority — to any OTHER account uploading the
-- same bytes (`initUpload`, `uploadFileDirect`, the streamed service uploads).
-- Owners ended up holding and linking each other's files, and one owner's
-- delete removed another owner's media (the security review of #1441).
--
-- Now each owner has its own row; the rows for one hash share the same
-- content-addressed storage, and the bytes are purged only when the last live
-- row using them goes (the storage-deletion worker's shared-content guard,
-- under the per-hash advisory lock). Owner is an account (`owner_user_id`) or a
-- system namespace (`system_owner`); `files_owner_exclusive_check` makes
-- exactly one of the two non-null, so one partial unique per column covers the
-- table with no expression index.
--
-- `storage_object_deletions` gains the reason `file.relocated`: a visibility
-- change copies an asset's objects to the other key spelling (`public/` or
-- not), and the spelling it left is owed a delete unless another owner's row
-- still uses it.
--
-- PRE. Every statement is correct against BOTH images:
--   - the new uniques are implied by the old one (one live row per hash is at
--     most one per owner per hash), so they build on existing data without
--     conflict, and the old image's inserts satisfy them;
--   - dropping the global unique lets the OLD image, for the rollout window,
--     create a second live row for a hash only when two different owners race
--     the same bytes — which is the new model, and which the old image's purge
--     (#1441: "keep the bytes while any live row has this hash") already
--     handles. Its same-owner race still hits a unique violation and re-reads,
--     exactly as before;
--   - the CHECK only WIDENS; the old image never writes `file.relocated`.
-- It must be applied BEFORE the new image serves: the new image inserts a
-- second owner's row for an existing hash, which the global unique would
-- refuse.
--
-- ## LOCKS, AND THE PREFERRED PRODUCTION ROUTE
--
-- Drizzle runs every pending migration in ONE transaction (`PgDialect.migrate`),
-- so `CONCURRENTLY` is unavailable here (see 0100). Run as written:
--   - each `CREATE UNIQUE INDEX` holds SHARE on `files` for its build — reads
--     continue, every upload/delete/visibility write BLOCKS, for a time
--     proportional to the table;
--   - `DROP INDEX` takes ACCESS EXCLUSIVE on `files`, held to COMMIT, which
--     also queues every READ behind any long-running query on `files`.
--
-- So on a large `files` the route is: build and drop OUT OF BAND first, with no
-- transaction and no write lock, and let this migration find the work done —
--
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS files_sha256_owner_user_live_key ON files USING btree (sha256, owner_user_id) WHERE status in ('active', 'trash') and owner_user_id is not null;
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS files_sha256_system_owner_live_key ON files USING btree (sha256, system_owner) WHERE status in ('active', 'trash') and system_owner is not null;
--   -- verify both are valid (the guard below refuses an invalid one), THEN:
--   DROP INDEX CONCURRENTLY IF EXISTS files_sha256_live_key;
--
-- in that order (the new uniques must exist before the old one goes, or two
-- racing uploads by ONE owner could both insert). `IF NOT EXISTS`/`IF EXISTS`
-- below are therefore load-bearing: after the out-of-band route this migration
-- is catalogue lookups plus the small `storage_object_deletions` CHECK swap.
-- The full procedure and the measured lock profile are in
-- `docs/engineering/per-owner-asset-rows.md`.
--
-- A failed `CREATE INDEX CONCURRENTLY` leaves an INVALID index behind under the
-- same name, and `IF NOT EXISTS` would silently accept it — a unique that
-- enforces nothing. The guard refuses that state instead of recording this
-- migration as applied over it.
CREATE UNIQUE INDEX IF NOT EXISTS "files_sha256_owner_user_live_key" ON "files" USING btree ("sha256","owner_user_id") WHERE "files"."status" in ('active', 'trash') and "files"."owner_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "files_sha256_system_owner_live_key" ON "files" USING btree ("sha256","system_owner") WHERE "files"."status" in ('active', 'trash') and "files"."system_owner" is not null;--> statement-breakpoint
DO $$
DECLARE
  invalid text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO invalid
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relname IN ('files_sha256_owner_user_live_key', 'files_sha256_system_owner_live_key')
    AND NOT (i.indisvalid AND i.indisunique);
  IF invalid IS NOT NULL THEN
    RAISE EXCEPTION 'files per-owner unique index not valid: %. A CREATE INDEX CONCURRENTLY failed part-way; DROP INDEX CONCURRENTLY it and build it again before migrating.', invalid;
  END IF;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "files_sha256_live_key";--> statement-breakpoint
ALTER TABLE "storage_object_deletions" DROP CONSTRAINT "storage_object_deletions_reason_check";--> statement-breakpoint
ALTER TABLE "storage_object_deletions" ADD CONSTRAINT "storage_object_deletions_reason_check" CHECK ("storage_object_deletions"."reason" in ('account.deleted', 'file.deleted', 'file.relocated'));
