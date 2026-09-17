-- oxy:deploy-phase=post
-- #1302 clean cut: the transfer protocol has one version, so the column that
-- distinguished them goes. Post-rollout: the previous image still selects it.
ALTER TABLE "identity_moves" DROP COLUMN "protocol_version";