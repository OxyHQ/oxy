-- oxy:deploy-phase=pre
--
-- ADR 0041 stage 3: import by URL (D7), application deletion (D8) and file
-- events to applications (D9).
--
--  * file_sources (new): per owner (an account or an application, exactly one)
--    and per source URL, the file an import stored and the source's validators
--    (`etag`, `last_modified`), so the same import is answered without a
--    download and revalidated with a conditional GET. The URL is kept as its
--    SHA-256 (the key), its host, and sealed (`secretBox`) — never in clear.
--  * applications.files_webhook_url / files_webhook_secret_ciphertext /
--    files_webhook_verified_at (new, nullable): one verified endpoint per
--    application for file events, the HMAC secret sealed. A CHECK refuses a URL
--    without its secret and verification time.
--  * file_event_deliveries (new): the outbox of `file.*` events, one row per
--    (event, application), written in the transaction that changed the file;
--    leased, retried with backoff, dead-lettered.
--
-- `file_references.webhook_url` is no longer read or written by this image
-- (D9 replaces per-reference webhooks); the column is dropped by a later post
-- migration once no serving image reads it.
--
-- PRE. Additive against both images: two new tables the previous image never
-- touches, three nullable columns it never reads, and a CHECK every existing
-- row satisfies (all three columns are NULL).
--
-- LOCKS. CREATE TABLE takes no lock on existing tables beyond its foreign keys'
-- SHARE ROW EXCLUSIVE on `applications`, `users` and `files` for the instant
-- the constraint is added (the new tables are empty). ADD COLUMN (nullable, no
-- default) is a catalogue change. ADD CONSTRAINT … CHECK scans `applications`
-- under ACCESS EXCLUSIVE — a small table.
CREATE TABLE "file_event_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"application_id" text NOT NULL,
	"type" text NOT NULL,
	"file_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_status" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "file_event_deliveries_event_id_application_id_key" UNIQUE("event_id","application_id"),
	CONSTRAINT "file_event_deliveries_type_check" CHECK ("file_event_deliveries"."type" in ('file.deleted', 'file.visibility_changed', 'file.trashed', 'file.restored', 'file.blocked', 'file.unblocked')),
	CONSTRAINT "file_event_deliveries_attempts_check" CHECK ("file_event_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "file_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text,
	"owner_application_id" text,
	"source_url_sha256" text NOT NULL,
	"source_host" text NOT NULL,
	"source_url_ciphertext" text NOT NULL,
	"file_id" text NOT NULL,
	"etag" text,
	"last_modified" text,
	"content_sha256" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"last_status" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "file_sources_owner_exclusive_check" CHECK (num_nonnulls("file_sources"."owner_user_id", "file_sources"."owner_application_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "files_webhook_url" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "files_webhook_secret_ciphertext" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "files_webhook_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "file_event_deliveries" ADD CONSTRAINT "file_event_deliveries_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_sources" ADD CONSTRAINT "file_sources_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_sources" ADD CONSTRAINT "file_sources_owner_application_id_applications_id_fk" FOREIGN KEY ("owner_application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_sources" ADD CONSTRAINT "file_sources_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_event_deliveries_due_idx" ON "file_event_deliveries" USING btree ("next_attempt_at") WHERE "file_event_deliveries"."delivered_at" is null and "file_event_deliveries"."failed_at" is null;--> statement-breakpoint
CREATE INDEX "file_event_deliveries_created_at_idx" ON "file_event_deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "file_sources_owner_user_id_source_url_sha256_key" ON "file_sources" USING btree ("owner_user_id","source_url_sha256") WHERE "file_sources"."owner_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "file_sources_owner_application_id_source_url_sha256_key" ON "file_sources" USING btree ("owner_application_id","source_url_sha256") WHERE "file_sources"."owner_application_id" is not null;--> statement-breakpoint
CREATE INDEX "file_sources_file_id_idx" ON "file_sources" USING btree ("file_id");--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_files_webhook_secret_check" CHECK ("applications"."files_webhook_url" is null or ("applications"."files_webhook_secret_ciphertext" is not null and "applications"."files_webhook_verified_at" is not null));