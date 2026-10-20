-- oxy:deploy-phase=pre
--
-- Four `messages` indexes that lead with `user_id`, so a mail read costs what
-- ONE mailbox holds rather than what the platform holds.
--
--  * messages_user_id_mailbox_id_pinned_date_id_idx — the folder list, with its
--    tie-breaker. Pages are ordered `pinned, date, id` and the cursor compares
--    all three; `messages_user_id_mailbox_id_pinned_date_idx` stops at `date`,
--    so every row sharing the boundary date is fetched and sorted.
--  * messages_user_id_date_id_idx — queryless search (`searchMessages` with
--    filters and no text): one user's mail newest first, ordered `date, id`,
--    across every folder. No index led with `user_id, date` before.
--  * messages_user_id_search_vector_idx, messages_user_id_labels_idx — GIN over
--    `(user_id, search_vector)` and `(user_id, labels)`. The unscoped
--    `messages_search_vector_idx` / `messages_labels_idx` match a common word
--    or label in every mailbox and drop the other owners' rows afterwards.
--    A scalar `text` key in a GIN index needs `btree_gin`, which
--    `REQUIRED_EXTENSIONS` (`src/db/extensions.ts`) installs before the
--    migrations run.
--
-- The four superseded indexes are left in place: dropping them is a `post`
-- step that waits for `pg_stat_user_indexes` to show nothing still reads them.
--
-- PRE, and purely additive: no row, column or contract changes, and both the
-- image still serving and the one arriving issue the same queries. The old
-- image just gets a cheaper plan.
--
-- ## LOCKS
--
-- `messages` holds every stored email and is written by every inbound
-- delivery, send, draft save and flag change. A plain CREATE INDEX holds SHARE
-- on it for the whole build: reads continue, every write BLOCKS. The migrator
-- runs each migration in a transaction, where CONCURRENTLY is impossible, so on
-- a non-trivial `messages` build all four OUT OF BAND first, from a one-shot
-- task, outside any transaction (runbook:
-- docs/engineering/per-owner-asset-rows.md, "Rollout order"), and let this
-- migration find the work done —
--
--   CREATE EXTENSION IF NOT EXISTS btree_gin;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_user_id_mailbox_id_pinned_date_id_idx ON messages USING btree (user_id, mailbox_id, pinned DESC NULLS LAST, date DESC NULLS LAST, id DESC NULLS LAST);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_user_id_date_id_idx ON messages USING btree (user_id, date DESC NULLS LAST, id DESC NULLS LAST);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_user_id_search_vector_idx ON messages USING gin (user_id, search_vector);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_user_id_labels_idx ON messages USING gin (user_id, labels);
--   SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname IN ('messages_user_id_mailbox_id_pinned_date_id_idx', 'messages_user_id_date_id_idx',
--                        'messages_user_id_search_vector_idx', 'messages_user_id_labels_idx');  -- four rows, all t
--
-- `IF NOT EXISTS` on every index below is load-bearing for that route;
-- afterwards this migration is four catalogue lookups and the guard.
--
-- A failed CREATE INDEX CONCURRENTLY leaves an INVALID index under the same
-- name, which `IF NOT EXISTS` would silently accept; the guard refuses it.
-- `DROP INDEX CONCURRENTLY` it and build it again before migrating.
CREATE INDEX IF NOT EXISTS "messages_user_id_mailbox_id_pinned_date_id_idx" ON "messages" USING btree ("user_id","mailbox_id","pinned" DESC NULLS LAST,"date" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_user_id_date_id_idx" ON "messages" USING btree ("user_id","date" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_user_id_search_vector_idx" ON "messages" USING gin ("user_id","search_vector");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_user_id_labels_idx" ON "messages" USING gin ("user_id","labels");--> statement-breakpoint
DO $$
DECLARE
  invalid text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO invalid
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relname IN (
      'messages_user_id_mailbox_id_pinned_date_id_idx',
      'messages_user_id_date_id_idx',
      'messages_user_id_search_vector_idx',
      'messages_user_id_labels_idx'
    )
    AND NOT i.indisvalid;
  IF invalid IS NOT NULL THEN
    RAISE EXCEPTION 'messages user-scoped index not valid: %. A CREATE INDEX CONCURRENTLY failed part-way; DROP INDEX CONCURRENTLY it and build it again before migrating.', invalid;
  END IF;
END $$;
