-- oxy:deploy-phase=pre
-- Additive: a nullable jsonb column (the 3D avatar character of a `bot`) and a
-- CHECK every existing row satisfies (the column is NULL everywhere). The CHECK
-- is added NOT VALID and then validated, the repo's pattern for a constraint on
-- `users` (0125, 0127): the table scan runs under a lock that does not block
-- writes. The "every bot has one" constraint follows the backfill of bots minted
-- before this column existed.
ALTER TABLE "users" ADD COLUMN "character" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_character_kind_check" CHECK ("users"."character" is null or "users"."kind" = 'bot') NOT VALID;--> statement-breakpoint
ALTER TABLE "users" VALIDATE CONSTRAINT "users_character_kind_check";
