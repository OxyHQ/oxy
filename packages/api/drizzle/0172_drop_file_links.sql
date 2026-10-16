-- oxy:deploy-phase=post
--
-- ADR 0041 D4, second half: `file_references` (0168) replaced `file_links`, and
-- the image now serving reads and writes only the new table.
--
--  * the rollout-window mirror trigger and its function go first, so nothing
--    fires while the table is dropped;
--  * `file_links` is dropped. Its rows were copied by 0168 and every write the
--    previous image made since was mirrored, so nothing is lost;
--  * the resolver `oxy_file_link_application_id` goes too: its runtime twin is
--    `src/utils/legacyFileLinkApplications.ts`.
--
-- POST: the previous image reads `file_links` on every file load.
DROP TRIGGER IF EXISTS file_links_mirror_to_file_references ON file_links;--> statement-breakpoint
DROP FUNCTION IF EXISTS file_links_mirror_to_file_references();--> statement-breakpoint
DROP TABLE "file_links" CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS oxy_file_link_application_id(text);
