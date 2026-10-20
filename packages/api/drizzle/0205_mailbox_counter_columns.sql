-- oxy:deploy-phase=pre
--
-- The three folder counters, back on `mailboxes` (see `src/db/schema/mailboxes.ts`
-- for the measurement and `MIGRATION-CONTRACT.md` for the approval).
--
-- Nullable with NO default, on purpose: NULL means "not counted yet". Every
-- existing mailbox reads NULL until `src/scripts/backfill-mailbox-counters.ts`
-- counts it, and a reader falls back to the aggregate until then. A default
-- here would stamp 0 on every existing folder and be wrong for all of them.
-- The default for NEW folders comes in 0194, after 0193 installs the trigger,
-- so no folder can start at 0 while writes go uncounted.
--
-- WHY `pre`: additive, and the image still serving names its columns
-- explicitly, so it never reads or writes these. Metadata-only (no default,
-- no rewrite); alone in its file because `mailboxes` is a hot table.
ALTER TABLE "mailboxes" ADD COLUMN "total_messages" integer;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "unseen_messages" integer;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "size_bytes" bigint;