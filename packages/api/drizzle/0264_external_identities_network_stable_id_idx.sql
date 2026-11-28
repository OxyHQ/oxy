-- oxy:deploy-phase=pre
--
-- `external_identities (network, stable_id)`, for the same-subject lookup when
-- an external actor is registered (externalIdentityRegistry.service.ts). That
-- lookup runs inside the registry's GLOBAL advisory lock
-- (`hashtext('external-identity-registry')`), and without this index it was a
-- parallel sequential scan of the whole table: production on 2026-11-28 (RDS,
-- 4 h of pg_stat_statements), 1,533 calls, 40.9 ms mean, 29.7M buffers;
-- EXPLAIN (ANALYZE, BUFFERS) 19,450 buffers and 257 ms cold for one lookup
-- (~991k rows, 152 MB). Every other registration waited behind it on the lock
-- (`pg_advisory_xact_lock` waits: ~700 s in the same 4 h). With the index it is
-- a handful of buffers.
--
-- Partial (`stable_id is not null`): about half the rows have no stable id and
-- the lookup never asks for them.
--
-- PRE, purely additive: both images issue the same query; the old one just
-- gets a cheaper plan.
--
-- ## LOCKS
--
-- `external_identities` is written by every federated actor registration. A
-- plain CREATE INDEX holds SHARE for the build (a few seconds at ~1M rows):
-- reads continue, those writes block. The migrator runs each migration in a
-- transaction, where CONCURRENTLY is impossible, so on production build it OUT
-- OF BAND first, from a one-shot task, outside any transaction (runbook:
-- docs/engineering/per-owner-asset-rows.md, "Rollout order"), and let this
-- migration find the work done —
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS external_identities_network_stable_id_idx ON external_identities USING btree (network, stable_id) WHERE stable_id IS NOT NULL;
--   SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname = 'external_identities_network_stable_id_idx';  -- one row, t
--
-- A failed CREATE INDEX CONCURRENTLY leaves an INVALID index under the same
-- name, which `IF NOT EXISTS` would silently accept; the guard refuses it.
-- `DROP INDEX CONCURRENTLY` it and build it again before migrating.
CREATE INDEX IF NOT EXISTS "external_identities_network_stable_id_idx" ON "external_identities" USING btree ("network","stable_id") WHERE "external_identities"."stable_id" is not null;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = 'external_identities_network_stable_id_idx'
      AND NOT i.indisvalid
  ) THEN
    RAISE EXCEPTION 'external_identities_network_stable_id_idx is not valid. A CREATE INDEX CONCURRENTLY failed part-way; DROP INDEX CONCURRENTLY it and build it again before migrating.';
  END IF;
END $$;
