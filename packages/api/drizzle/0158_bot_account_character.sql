-- oxy:deploy-phase=pre
-- Additive: a nullable jsonb column (the 3D avatar character of a `bot`) and a
-- CHECK every existing row satisfies (the column is NULL everywhere). The
-- "every bot has one" constraint waits for the backfill of bots minted before
-- this column existed.
ALTER TABLE "users" ADD COLUMN "character" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_character_kind_check" CHECK ("users"."character" is null or "users"."kind" = 'bot');