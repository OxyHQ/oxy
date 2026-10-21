-- oxy:deploy-phase=post
--
-- Swaps 0196's people-search index in once the image filtering on the new
-- expression is the only one serving: the old index (no `name_display`) is
-- dropped and `users_people_search_trgm_idx_next` takes its name, which is the
-- one the schema declares.
--
-- ## LOCKS
--
-- A catalogue change: DROP INDEX and RENAME each hold ACCESS EXCLUSIVE on
-- `users` for an instant, under the migrator's lock_timeout. To avoid even that,
-- run `DROP INDEX CONCURRENTLY IF EXISTS users_people_search_trgm_idx;` out of
-- band AFTER the new image is live (never before: the old image's searches
-- need it); the DROP below then no-ops and only the rename remains.
DROP INDEX IF EXISTS "users_people_search_trgm_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "users_people_search_trgm_idx_next" RENAME TO "users_people_search_trgm_idx";
