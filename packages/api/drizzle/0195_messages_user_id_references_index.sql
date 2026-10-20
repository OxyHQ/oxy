-- oxy:deploy-phase=pre
--
-- messages_user_id_references_idx: GIN over (user_id, "references"), the
-- owner-scoped form of messages_references_idx, as 0192 did for the search
-- vector and the labels.
--
-- The thread writes (services/emailThreading.ts) walk a conversation one key
-- at a time, and the `References` arm of that probe is
-- `user_id = $1 AND "references" @> array[$key]`. With only the unscoped GIN,
-- the planner ANDs it with a bitmap of every row the user owns: measured on a
-- 200k-message mailbox, a 500-message reply chain took 2.4 s and a
-- 5000-message one 93 s. With this index each probe is one GIN scan (70 ms
-- for the 500-message chain). `btree_gin` (0192's REQUIRED_EXTENSIONS entry)
-- provides the `text` operator class. messages_references_idx stays until a
-- `post` migration drops it after pg_stat_user_indexes shows it idle.
--
-- `fastupdate = off`: with GIN's default pending list, every probe also scans
-- the list linearly until vacuum merges it, and a thread write probes once
-- per key — measured 2.4 ms per probe instead of 0.02 ms while the backfill
-- was writing. Each insert pays for its own few entries instead.
--
-- PRE, and purely additive: no row or contract changes; the image still
-- serving just gets another plan for the walk its reads already run.
--
-- ## LOCKS
--
-- A plain CREATE INDEX holds SHARE on `messages` for the whole build: reads
-- continue, every write BLOCKS. Build it OUT OF BAND first, from a one-shot
-- task, outside any transaction (runbook:
-- docs/engineering/per-owner-asset-rows.md, "Rollout order") —
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_user_id_references_idx ON messages USING gin (user_id, "references") WITH (fastupdate = off);
--   SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname = 'messages_user_id_references_idx';  -- one row, t
--
-- `IF NOT EXISTS` below is load-bearing for that route; afterwards this
-- migration is a catalogue lookup and the guard.
--
-- A failed CREATE INDEX CONCURRENTLY leaves an INVALID index under the same
-- name, which `IF NOT EXISTS` would silently accept; the guard refuses it.
-- `DROP INDEX CONCURRENTLY` it and build it again before migrating.
CREATE INDEX IF NOT EXISTS "messages_user_id_references_idx" ON "messages" USING gin ("user_id","references") WITH (fastupdate=false);--> statement-breakpoint
DO $$
DECLARE
  invalid text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO invalid
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relname = 'messages_user_id_references_idx'
    AND NOT i.indisvalid;
  IF invalid IS NOT NULL THEN
    RAISE EXCEPTION 'messages references index not valid: %. A CREATE INDEX CONCURRENTLY failed part-way; DROP INDEX CONCURRENTLY it and build it again before migrating.', invalid;
  END IF;
END $$;
