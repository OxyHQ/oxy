/** Old requester approvals never captured a catalogue pin; preserve history without inferring approval. */
export const REVOKE_UNPINNED_FOREGROUND_APPROVALS_SQL = `
UPDATE "capability_execution_authorizations"
SET "revoked_at" = COALESCE("revoked_at", CURRENT_TIMESTAMP), "updated_at" = CURRENT_TIMESTAMP
WHERE "actor_type" = 'requester'
  AND "requester_catalog_registration_id" IS NULL
  AND "requester_catalog_version" IS NULL
  AND "requester_catalog_digest" IS NULL;
`;
