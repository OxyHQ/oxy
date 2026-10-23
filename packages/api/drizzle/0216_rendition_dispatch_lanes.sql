-- oxy:deploy-phase=pre
-- Existing requests and rolling old writers default to bulk; new writers select fresh or repair.
ALTER TABLE "file_rendition_requests" ADD COLUMN "lane" text DEFAULT 'bulk' NOT NULL;--> statement-breakpoint
CREATE INDEX "file_rendition_requests_lane_requested_at_idx" ON "file_rendition_requests" USING btree ("lane","requested_at","file_id");--> statement-breakpoint
ALTER TABLE "file_rendition_requests" ADD CONSTRAINT "file_rendition_requests_lane_check" CHECK ("file_rendition_requests"."lane" in ('fresh', 'repair', 'bulk'));