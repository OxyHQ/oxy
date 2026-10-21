-- oxy:deploy-phase=pre
--
-- People search covers `name_display`: a non-personal account's title lives
-- there alone (native organizations always; federated ones since accounts are
-- named by kind), so without it no title is found by name.
--
--  * users_people_search_trgm_idx_next: the trigram GIN over the concatenation
--    with `name_display` added. Built BESIDE the current index, not in its
--    place: the image still serving filters on the old expression and needs the
--    old index until it is gone. 0197 (post) drops the old one and renames this
--    one in.
--  * users_lower_name_display_prefix_idx: the text_pattern_ops b-tree the
--    short-term (under three characters) prefix branch needs for its new arm.
--
-- PRE: purely additive. Both images answer the same queries; the old one keeps
-- its index, the new one gets the index its expression names.
--
-- ## LOCKS
--
-- `users` is hot and large. A CREATE INDEX here holds SHARE on it for the whole
-- build — every write blocks — and a GIN trigram build over it does not fit the
-- migrator's 120 s statement_timeout. Build both OUT OF BAND first, outside any
-- transaction (ShareUpdateExclusive: reads and writes continue) —
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS users_people_search_trgm_idx_next ON users USING gin ((coalesce(username, '') || ' ' || coalesce(name_first, '') || ' ' || coalesce(name_last, '') || ' ' || coalesce(name_display, '') || ' ' || coalesce(description, '')) gin_trgm_ops);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS users_lower_name_display_prefix_idx ON users USING btree (lower(name_display) text_pattern_ops);
--
-- This migration then only finds them and no-ops. Where they do not exist (a
-- fresh or development database) it builds them in place — never on a large
-- table. A failed CREATE INDEX CONCURRENTLY leaves an INVALID index; the guard
-- refuses one under either name: DROP INDEX CONCURRENTLY it and build it again.
DO $$
DECLARE
  invalid text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO invalid
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relname IN ('users_people_search_trgm_idx_next', 'users_lower_name_display_prefix_idx')
    AND NOT i.indisvalid;
  IF invalid IS NOT NULL THEN
    RAISE EXCEPTION 'people search index not valid: %. A CREATE INDEX CONCURRENTLY failed part-way; DROP INDEX CONCURRENTLY it and build it again before migrating.', invalid;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_people_search_trgm_idx_next" ON "users" USING gin ((coalesce(username, '') || ' ' || coalesce(name_first, '') || ' ' || coalesce(name_last, '') || ' ' || coalesce(name_display, '') || ' ' || coalesce(description, '')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_lower_name_display_prefix_idx" ON "users" USING btree (lower("name_display") text_pattern_ops);
