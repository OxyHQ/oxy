-- oxy:deploy-phase=pre
--
-- ADR 0043 stage 4c: a play session's rendition allow-list. One nullable
-- column on file_play_sessions — NULL is the whole ladder, as every existing
-- session has — and its CHECK (a non-empty subset of the ladder's rungs). The
-- previous image never reads or writes the column, so it is unaffected.
--
-- PRE: additive only.
ALTER TABLE "file_play_sessions" ADD COLUMN "renditions" text[];--> statement-breakpoint
ALTER TABLE "file_play_sessions" ADD CONSTRAINT "file_play_sessions_renditions_check" CHECK ("file_play_sessions"."renditions" is null or (cardinality("file_play_sessions"."renditions") >= 1 and "file_play_sessions"."renditions" <@ array['hls_a64', 'hls_a128', 'hls_a256', 'hls_360p', 'hls_720p', 'hls_1080p']::text[]));