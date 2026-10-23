-- oxy:deploy-phase=post
--
-- Step 3 of 3: messages.thread_id NOT NULL, and the transitional CHECK goes.
--
-- POST: it narrows what the table accepts; correct once no serving image can
-- write a NULL (every image since 0202 assigns thread_id on insert).
--
-- ## LOCKS
--
-- Both statements take ACCESS EXCLUSIVE on `messages` for an instant, and
-- nothing else shares this file. The ORDER is load-bearing: SET NOT NULL
-- skips its full-table scan only because 0213 left a VALID CHECK proving
-- `thread_id is not null`. Dropping the CHECK first (drizzle's order) would
-- make SET NOT NULL scan every row under the exclusive lock.
ALTER TABLE "messages" ALTER COLUMN "thread_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_thread_id_not_null";
