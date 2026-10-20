-- oxy:deploy-phase=pre
--
-- The storage observation (applicationStorageObservation.ts, ADR 0043 D2)
-- becomes index-only.
--
-- On 2026-10-20 one observation ran for over two hours: for each of the 2.19M
-- live application-owned files it read the `files` heap at random and ran a
-- correlated `sum(size)` over `file_variants` (7.5M rows), on the shared RDS
-- whose load is mostly IO:DataFileRead. Runs piled up (three at once) and every
-- Oxy app slowed down. With these indexes the same measures read only indexes:
-- "stored" measured 13 s and ~90 MB, "added" 4 ms for an hour's window (61 s
-- while every application file is less than a week old).
--
--  * files_application_live_bytes_idx (new): (owner_application_id, id, size)
--    over the live application-owned rows — the "stored" measure and
--    applicationStoredBytes.
--  * file_variants_file_id_type_idx gains `size`: a file's rendition bytes are
--    an index-only probe. Same leading key, so every lookup it served it serves.
--  * files_owner_application_id_created_at_idx gains `size`: "added in a
--    window" is an index-only range per application. Same leading key, so
--    `GET /assets/service/app`'s cursor and the RESTRICT probe are unchanged.
--
-- PRE: additive for both images — the image still serving runs the same
-- queries over indexes that cover more.
--
-- ## LOCKS
--
-- `files` is hot and both tables are large: build all three OUT OF BAND first,
-- outside any transaction (ShareUpdateExclusive: reads and writes continue) —
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS files_application_live_bytes_idx ON files USING btree (owner_application_id, id, size) WHERE owner_application_id IS NOT NULL AND status IN ('active', 'trash', 'blocked');
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS file_variants_file_id_type_idx_next ON file_variants USING btree (file_id, type, size);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS files_owner_application_id_created_at_idx_next ON files USING btree (owner_application_id, created_at DESC NULLS LAST, id DESC NULLS LAST, size) WHERE owner_application_id IS NOT NULL;
--
-- Production had all three built (2026-10-20). This migration then only swaps
-- each `_next` in: DROP INDEX + RENAME, a catalogue change holding ACCESS
-- EXCLUSIVE for an instant under the migrator's lock_timeout. Where no `_next`
-- exists (a fresh or development database) it rebuilds the index in place,
-- which blocks writes on that table for the build — never do that on a large
-- one. A failed CREATE INDEX CONCURRENTLY leaves an INVALID index; the guard
-- refuses one under any of these names before anything is swapped.
DO $$
DECLARE
  invalid text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO invalid
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relname IN ('files_application_live_bytes_idx', 'file_variants_file_id_type_idx_next', 'files_owner_application_id_created_at_idx_next')
    AND NOT i.indisvalid;
  IF invalid IS NOT NULL THEN
    RAISE EXCEPTION 'storage observation index not valid: %. A CREATE INDEX CONCURRENTLY failed part-way; DROP INDEX CONCURRENTLY it and build it again before migrating.', invalid;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_application_live_bytes_idx" ON "files" USING btree ("owner_application_id","id","size") WHERE "files"."owner_application_id" is not null and "files"."status" in ('active', 'trash', 'blocked');--> statement-breakpoint
-- Swap each widened index in: its `_next` when built out of band, else a
-- rebuild. Skipped once the index already carries `size`.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE n.nspname = current_schema() AND c.relname = 'file_variants_file_id_type_idx' AND a.attname = 'size'
  ) THEN
    DROP INDEX IF EXISTS file_variants_file_id_type_idx;
    IF to_regclass('file_variants_file_id_type_idx_next') IS NOT NULL THEN
      ALTER INDEX file_variants_file_id_type_idx_next RENAME TO file_variants_file_id_type_idx;
    ELSE
      CREATE INDEX file_variants_file_id_type_idx ON file_variants USING btree (file_id, type, size);
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE n.nspname = current_schema() AND c.relname = 'files_owner_application_id_created_at_idx' AND a.attname = 'size'
  ) THEN
    DROP INDEX IF EXISTS files_owner_application_id_created_at_idx;
    IF to_regclass('files_owner_application_id_created_at_idx_next') IS NOT NULL THEN
      ALTER INDEX files_owner_application_id_created_at_idx_next RENAME TO files_owner_application_id_created_at_idx;
    ELSE
      CREATE INDEX files_owner_application_id_created_at_idx ON files USING btree (owner_application_id, created_at DESC NULLS LAST, id DESC NULLS LAST, size) WHERE owner_application_id IS NOT NULL;
    END IF;
  END IF;
END $$;
