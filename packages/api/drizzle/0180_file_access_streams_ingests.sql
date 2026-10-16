-- oxy:deploy-phase=pre
--
-- ADR 0043 stage 4c: consent, play sessions, large ingests. Three new tables,
-- nothing existing changes, so the previous image is unaffected.
--
--  * file_access_grants — a person's consent, per (file, application), for an
--    application to read that person's file with its service token: `granted`
--    when the application stored the file for them (user-media upload, import,
--    large upload, recording), `revoked` when the person withdrew it (which beats
--    an owner-made reference too).
--  * file_play_sessions — one revocable play of a file's HLS ladder by an
--    application: the SHA-256 of its URL secret, its sealed AES-128 key, expiry,
--    revocation.
--  * file_ingests — a large import by URL (> 40 MiB) or a recording target
--    (LiveKit egress S3 credentials scoped to one pending object) before its
--    bytes are a file: sealed secrets, the staging object, the worker's lease.
--
-- PRE: additive only.
CREATE TABLE "file_access_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"application_id" text NOT NULL,
	"state" text NOT NULL,
	"source" text NOT NULL,
	"changed_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "file_access_grants_file_id_application_id_key" UNIQUE("file_id","application_id"),
	CONSTRAINT "file_access_grants_state_check" CHECK ("file_access_grants"."state" in ('granted', 'revoked')),
	CONSTRAINT "file_access_grants_source_check" CHECK ("file_access_grants"."source" in ('upload', 'owner')),
	CONSTRAINT "file_access_grants_revoked_check" CHECK (("file_access_grants"."state" = 'revoked') = ("file_access_grants"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "file_ingests" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"owner_user_id" text,
	"owner_application_id" text,
	"creator_application_id" text NOT NULL,
	"mime" text,
	"ext" text,
	"original_name" text,
	"visibility" text NOT NULL,
	"metadata" jsonb,
	"reference" jsonb,
	"staging_key" text,
	"s3_upload_id" text,
	"object_name" text,
	"size" bigint,
	"sha256" text,
	"max_bytes" bigint NOT NULL,
	"secret_ciphertext" text,
	"source_url_sha256" text,
	"source_host" text,
	"source_url_ciphertext" text,
	"etag" text,
	"last_modified" text,
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
	CONSTRAINT "file_ingests_owner_check" CHECK (("file_ingests"."kind" = 'application' and "file_ingests"."owner_application_id" is not null and "file_ingests"."owner_user_id" is null)
        or ("file_ingests"."kind" = 'account' and "file_ingests"."owner_user_id" is not null and "file_ingests"."owner_application_id" is null)),
	CONSTRAINT "file_ingests_source_check" CHECK ("file_ingests"."source" in ('import', 'recording')),
	CONSTRAINT "file_ingests_status_check" CHECK ("file_ingests"."status" in ('awaiting_upload', 'receiving', 'verifying', 'completed', 'failed', 'aborted')),
	CONSTRAINT "file_ingests_kind_check" CHECK ("file_ingests"."kind" in ('application', 'account')),
	CONSTRAINT "file_ingests_visibility_check" CHECK ("file_ingests"."visibility" in ('private', 'public', 'unlisted')),
	CONSTRAINT "file_ingests_recording_check" CHECK ("file_ingests"."source" <> 'recording' or "file_ingests"."secret_ciphertext" is not null),
	CONSTRAINT "file_ingests_import_check" CHECK ("file_ingests"."source" <> 'import' or ("file_ingests"."source_url_sha256" is not null and "file_ingests"."source_host" is not null and "file_ingests"."source_url_ciphertext" is not null)),
	CONSTRAINT "file_ingests_max_bytes_check" CHECK ("file_ingests"."max_bytes" > 0),
	CONSTRAINT "file_ingests_size_check" CHECK ("file_ingests"."size" is null or "file_ingests"."size" >= 0),
	CONSTRAINT "file_ingests_sha256_check" CHECK ("file_ingests"."sha256" is null or "file_ingests"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "file_ingests_completed_check" CHECK ("file_ingests"."status" <> 'completed' or ("file_ingests"."finished_at" is not null and "file_ingests"."file_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "file_play_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"application_id" text NOT NULL,
	"end_user_id" text,
	"token_sha256" text NOT NULL,
	"encryption" text NOT NULL,
	"key_authorization" text NOT NULL,
	"content_key_ciphertext" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "file_play_sessions_encryption_check" CHECK ("file_play_sessions"."encryption" in ('aes-128', 'none')),
	CONSTRAINT "file_play_sessions_key_authorization_check" CHECK ("file_play_sessions"."key_authorization" in ('none', 'webhook')),
	CONSTRAINT "file_play_sessions_revoked_by_check" CHECK ("file_play_sessions"."revoked_by" is null or "file_play_sessions"."revoked_by" in ('application', 'owner', 'oxy')),
	CONSTRAINT "file_play_sessions_revoked_check" CHECK (("file_play_sessions"."revoked_at" is null) = ("file_play_sessions"."revoked_by" is null)),
	CONSTRAINT "file_play_sessions_key_check" CHECK (("file_play_sessions"."encryption" = 'aes-128') = ("file_play_sessions"."content_key_ciphertext" is not null)),
	CONSTRAINT "file_play_sessions_key_authorization_needs_key_check" CHECK ("file_play_sessions"."key_authorization" = 'none' or "file_play_sessions"."encryption" = 'aes-128'),
	CONSTRAINT "file_play_sessions_token_check" CHECK ("file_play_sessions"."token_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "file_access_grants" ADD CONSTRAINT "file_access_grants_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_access_grants" ADD CONSTRAINT "file_access_grants_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_access_grants" ADD CONSTRAINT "file_access_grants_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_ingests" ADD CONSTRAINT "file_ingests_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_play_sessions" ADD CONSTRAINT "file_play_sessions_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_play_sessions" ADD CONSTRAINT "file_play_sessions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_play_sessions" ADD CONSTRAINT "file_play_sessions_end_user_id_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_access_grants_application_id_idx" ON "file_access_grants" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "file_access_grants_changed_by_user_id_idx" ON "file_access_grants" USING btree ("changed_by_user_id");--> statement-breakpoint
CREATE INDEX "file_ingests_open_status_idx" ON "file_ingests" USING btree ("status","expires_at") WHERE "file_ingests"."status" in ('awaiting_upload', 'receiving', 'verifying');--> statement-breakpoint
CREATE INDEX "file_ingests_finished_at_idx" ON "file_ingests" USING btree ("finished_at");--> statement-breakpoint
CREATE INDEX "file_ingests_file_id_idx" ON "file_ingests" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "file_play_sessions_file_id_application_id_idx" ON "file_play_sessions" USING btree ("file_id","application_id");--> statement-breakpoint
CREATE INDEX "file_play_sessions_application_id_end_user_id_idx" ON "file_play_sessions" USING btree ("application_id","end_user_id");--> statement-breakpoint
CREATE INDEX "file_play_sessions_end_user_id_idx" ON "file_play_sessions" USING btree ("end_user_id");--> statement-breakpoint
CREATE INDEX "file_play_sessions_expires_at_idx" ON "file_play_sessions" USING btree ("expires_at");