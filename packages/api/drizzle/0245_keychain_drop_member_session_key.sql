-- oxy:deploy-phase=post
-- ADR 0063 D4: one live keychain member per account presence on a device
-- (keychain_members_live_device_context_key, 0243), no longer per device
-- session. The old index would keep an orphaned member holding its device's
-- slot, so the same device could never join again after the account signed
-- back in. Dropped after the rollout: the previous image's error mapping names
-- it.
DROP INDEX IF EXISTS "keychain_members_live_device_session_key";
