-- oxy:deploy-phase=pre
--
-- ADR 0043 stage 4b: large, any-type uploads by an application's service token
-- (`POST /assets/service/app/uploads`, `/service/user-media/uploads`).
--
-- One new table, `file_upload_sessions`: a resumable S3 multipart upload the
-- client PUTs straight to the bucket, verified by the API (it hashes the
-- assembled object) before it becomes a `files` row. Nothing existing changes,
-- so it is `pre`: the image still serving never reads it.
--
-- The owner and uploader columns carry no foreign key on purpose (the row is
-- what aborts an abandoned upload and releases its reservation; an owner's
-- deletion must not take that cleanup away). `file_id` and `reservation_id`
-- are `SET NULL`.
--
CREATE TABLE "file_upload_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"owner_user_id" text,
	"owner_application_id" text,
	"uploader_application_id" text NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"mime" text NOT NULL,
	"ext" text NOT NULL,
	"original_name" text,
	"visibility" text NOT NULL,
	"metadata" jsonb,
	"reference" jsonb,
	"staging_key" text NOT NULL,
	"s3_upload_id" text NOT NULL,
	"part_size" integer NOT NULL,
	"part_count" integer NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"reservation_id" text,
	"file_id" text,
	"deduplicated" boolean DEFAULT false NOT NULL,
	"reference_result" text,
	"error_code" text,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "file_upload_sessions_owner_check" CHECK (("file_upload_sessions"."kind" = 'application' and "file_upload_sessions"."owner_application_id" is not null and "file_upload_sessions"."owner_user_id" is null)
        or ("file_upload_sessions"."kind" = 'account' and "file_upload_sessions"."owner_user_id" is not null and "file_upload_sessions"."owner_application_id" is null)),
	CONSTRAINT "file_upload_sessions_status_check" CHECK ("file_upload_sessions"."status" in ('uploading', 'verifying', 'completed', 'failed', 'aborted')),
	CONSTRAINT "file_upload_sessions_kind_check" CHECK ("file_upload_sessions"."kind" in ('application', 'account')),
	CONSTRAINT "file_upload_sessions_visibility_check" CHECK ("file_upload_sessions"."visibility" in ('private', 'public', 'unlisted')),
	CONSTRAINT "file_upload_sessions_size_check" CHECK ("file_upload_sessions"."size" > 0),
	CONSTRAINT "file_upload_sessions_parts_check" CHECK ("file_upload_sessions"."part_size" > 0 and "file_upload_sessions"."part_count" between 1 and 10000),
	CONSTRAINT "file_upload_sessions_sha256_check" CHECK ("file_upload_sessions"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "file_upload_sessions_completed_check" CHECK ("file_upload_sessions"."status" <> 'completed' or "file_upload_sessions"."finished_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "file_upload_sessions" ADD CONSTRAINT "file_upload_sessions_reservation_id_storage_byte_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."storage_byte_reservations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_upload_sessions" ADD CONSTRAINT "file_upload_sessions_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "file_upload_sessions_open_application_key" ON "file_upload_sessions" USING btree ("owner_application_id","sha256") WHERE "file_upload_sessions"."owner_application_id" is not null and "file_upload_sessions"."status" in ('uploading', 'verifying');--> statement-breakpoint
CREATE UNIQUE INDEX "file_upload_sessions_open_account_key" ON "file_upload_sessions" USING btree ("owner_user_id","sha256") WHERE "file_upload_sessions"."owner_user_id" is not null and "file_upload_sessions"."status" in ('uploading', 'verifying');--> statement-breakpoint
CREATE INDEX "file_upload_sessions_open_status_idx" ON "file_upload_sessions" USING btree ("status","expires_at") WHERE "file_upload_sessions"."status" in ('uploading', 'verifying');--> statement-breakpoint
CREATE INDEX "file_upload_sessions_finished_at_idx" ON "file_upload_sessions" USING btree ("finished_at");--> statement-breakpoint
CREATE INDEX "file_upload_sessions_file_id_idx" ON "file_upload_sessions" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "file_upload_sessions_reservation_id_idx" ON "file_upload_sessions" USING btree ("reservation_id");