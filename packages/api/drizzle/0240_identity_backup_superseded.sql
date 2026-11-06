-- oxy:deploy-phase=pre
-- A backup a key rotation replaced while it carried retired keys is kept and
-- marked (security review R6-8). Nullable, no default: a catalog-only change.
ALTER TABLE "identity_backups" ADD COLUMN "superseded_at" timestamp with time zone;