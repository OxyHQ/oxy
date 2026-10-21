-- oxy:deploy-phase=pre
--
-- `file_rendition_requests`: the durable backlog of rendition work, so the
-- asset-variant queue in Redis holds only a bounded window of it
-- (queue/assetVariants.queue.ts, services/renditionRequests.ts).
--
-- On 2026-10-20 a bulk import left 398,416 jobs (~380 MB) in the 384 MB
-- noeviction queue node: every Redis write failed, workers could not complete
-- a job, and their loop logged ~1,600 errors a second.
--
-- PRE: a new table. The image still serving never reads it; the arriving one
-- records requests in it and its scheduler drains the Redis backlog into it.
--
-- ## LOCKS
--
-- The foreign key onto `files` takes SHARE ROW EXCLUSIVE on `files` for the
-- instant it validates an EMPTY table; readers are not blocked and no row is
-- scanned. No statement here touches an existing row.
CREATE TABLE "file_rendition_requests" (
	"file_id" text PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"enqueued_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "file_rendition_requests" ADD CONSTRAINT "file_rendition_requests_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_rendition_requests_requested_at_idx" ON "file_rendition_requests" USING btree ("requested_at","file_id");