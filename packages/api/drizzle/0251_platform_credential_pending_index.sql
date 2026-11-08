-- oxy:deploy-phase=pre
-- The partial indexes behind R8's pending credentials (0250): the expiry
-- sweep's scan of `pending_until`, and the self foreign key
-- `replaces_credential_id`, so deleting a credential does not scan the table.
--
-- ## LOCKS
--
-- `device_credentials` is hot (every mint reads it), and a plain CREATE INDEX
-- holds SHARE on it for the build: reads continue, holder issuance waits. The
-- table holds a few rows per device (the per-device cap is 32), both columns
-- are NULL on every row and the indexes are partial on NOT NULL, so each build
-- takes milliseconds. `IF NOT EXISTS` keeps the out-of-band route open all the
-- same: should one ever need to be built first, run
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS device_credentials_pending_until_idx ON device_credentials USING btree (pending_until) WHERE pending_until is not null;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS device_credentials_replaces_credential_id_idx ON device_credentials USING btree (replaces_credential_id) WHERE replaces_credential_id is not null;
--
-- after 0250, and this migration is then a catalogue lookup.
CREATE INDEX IF NOT EXISTS "device_credentials_pending_until_idx" ON "device_credentials" USING btree ("pending_until") WHERE "device_credentials"."pending_until" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_credentials_replaces_credential_id_idx" ON "device_credentials" USING btree ("replaces_credential_id") WHERE "device_credentials"."replaces_credential_id" is not null;
