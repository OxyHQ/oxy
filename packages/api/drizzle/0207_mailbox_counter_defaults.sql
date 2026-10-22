-- oxy:deploy-phase=pre
--
-- New folders start their counters at 0. Exact, because a folder is empty when
-- it is created and 0206's trigger counts every message written after that.
-- SET DEFAULT changes no existing row: folders that predate this stay NULL
-- until src/scripts/backfill-mailbox-counters.ts counts them.
--
-- After 0206, never before it: a folder created between a 0 default and the
-- trigger would start at 0 and silently miss the messages written into it in
-- that window, and the backfill skips folders that are already counted.
--
-- WHY `pre`: additive; the image still serving inserts folders without naming
-- these columns, so it gets the default too. Metadata-only, alone in its file
-- because mailboxes is hot.
ALTER TABLE "mailboxes" ALTER COLUMN "total_messages" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "mailboxes" ALTER COLUMN "unseen_messages" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "mailboxes" ALTER COLUMN "size_bytes" SET DEFAULT 0;