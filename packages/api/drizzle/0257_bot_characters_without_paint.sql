-- oxy:deploy-phase=pre
--
-- A bot's colour is its account's `color` and nothing else (`@oxy.so/contracts` 7): its
-- `character` keeps its shape and features and loses its paint (`color`, a named paint, and
-- `bodyColor`, a free hex). Pre phase, so the image this rollout ships, whose schema refuses a
-- paint and reads a painted character as none, never sees one; 0258 repeats it after the rollout
-- for a bot the draining image created with a picked paint. Production held 12 bot characters,
-- all 12 painted, when this was written.
UPDATE "users" SET "character" = "character" - 'color' - 'bodyColor' WHERE "character" ?| array['color', 'bodyColor'];
