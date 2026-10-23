-- oxy:deploy-phase=post
--
-- Step 1 of 3 making messages.thread_id NOT NULL: a CHECK, added NOT VALID.
--
-- Shipped only after the thread_id backfill had run in production and reported
-- remaining: 0, unrepaired: 0 (2,375 of 2,375 rows), AND the thread-read image
-- (stored thread_id, walk fallback) was live. Every image
-- since 0202 assigns thread_id on every insert, so from then on a NULL can only
-- be a row the backfill has not reached.
--
-- POST: it narrows what the table accepts, so it is only correct once no
-- serving image can write a NULL.
--
-- ## LOCKS
--
-- ADD CONSTRAINT … NOT VALID takes ACCESS EXCLUSIVE on `messages` for an
-- instant and scans nothing: the CHECK is enforced on every write from here
-- on, and proven for the existing rows by 0213's VALIDATE, under a lock that
-- lets reads and writes continue. The only statement in this file.
--
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so the add is skipped when
-- the constraint is already there: that is what lets it — and 0213's VALIDATE,
-- the slow part — be run OUT OF BAND before this migration ships:
--
--   ALTER TABLE messages ADD CONSTRAINT messages_thread_id_not_null CHECK (thread_id is not null) NOT VALID;
--   ALTER TABLE messages VALIDATE CONSTRAINT messages_thread_id_not_null;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'messages'::regclass AND conname = 'messages_thread_id_not_null'
  ) THEN
    ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_not_null" CHECK ("messages"."thread_id" is not null) NOT VALID;
  END IF;
END $$;
