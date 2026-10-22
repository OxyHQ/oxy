-- oxy:deploy-phase=pre
--
-- messages_user_id_thread_id_idx: one conversation's members by its stored
-- key (0202). Every thread assignment the arriving image makes reads it — the
-- size of each thread a new message joins, and the members a delete or a key
-- change has to re-split — and so will the reads that move off the
-- `WITH RECURSIVE` walk once the backfill has run.
--
-- PRE, and purely additive: the image still serving never reads the column.
--
-- ## LOCKS
--
-- `messages` is written by every inbound delivery, send, draft save and flag
-- change, and a plain CREATE INDEX holds SHARE on it for the whole build:
-- reads continue, every write BLOCKS. Build it OUT OF BAND first, from a
-- one-shot task, outside any transaction (runbook:
-- docs/engineering/per-owner-asset-rows.md, "Rollout order"), after 0202 has
-- added the column —
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_user_id_thread_id_idx ON messages USING btree (user_id, thread_id);
--   SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname = 'messages_user_id_thread_id_idx';  -- one row, t
--
-- `IF NOT EXISTS` below is load-bearing for that route; afterwards this
-- migration is a catalogue lookup and the guard. Built while every thread_id is
-- still NULL, the index is small; it grows as the image arriving and the
-- backfill assign threads.
--
-- A failed CREATE INDEX CONCURRENTLY leaves an INVALID index under the same
-- name, which `IF NOT EXISTS` would silently accept; the guard refuses it.
-- `DROP INDEX CONCURRENTLY` it and build it again before migrating.
CREATE INDEX IF NOT EXISTS "messages_user_id_thread_id_idx" ON "messages" USING btree ("user_id","thread_id");--> statement-breakpoint
DO $$
DECLARE
  invalid text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO invalid
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relname = 'messages_user_id_thread_id_idx'
    AND NOT i.indisvalid;
  IF invalid IS NOT NULL THEN
    RAISE EXCEPTION 'messages thread index not valid: %. A CREATE INDEX CONCURRENTLY failed part-way; DROP INDEX CONCURRENTLY it and build it again before migrating.', invalid;
  END IF;
END $$;
