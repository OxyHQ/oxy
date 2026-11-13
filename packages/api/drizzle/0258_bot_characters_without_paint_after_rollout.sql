-- oxy:deploy-phase=post
--
-- 0257 again, once the previous image has drained: it still picked a paint for a bot created
-- without a character (`avatarCharacterFor` before contracts 7), and such a bot created during the
-- rollout would otherwise keep one its new readers do not accept.
UPDATE "users" SET "character" = "character" - 'color' - 'bodyColor' WHERE "character" ?| array['color', 'bodyColor'];
