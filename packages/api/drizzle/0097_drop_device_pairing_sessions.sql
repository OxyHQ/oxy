-- oxy:deploy-phase=post
-- #1302 clean cut: the older raw-key device transfer is removed. Post-rollout, so
-- the image that still swept and served this table is gone before it is. The
-- table never held a row in production (read-only count, 2026-09-17), and every
-- row it could hold was a 3-minute pairing session.
DROP TABLE IF EXISTS "device_pairing_sessions";