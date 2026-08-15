-- oxy:deploy-phase=pre
-- Durable SMTP retry state, optimistic draft revisions, and saved searches.
-- All additions are additive for the previous image: existing message writes
-- receive a default revision and the two new tables have no old callers.

ALTER TABLE "messages" ADD COLUMN "draft_revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_draft_revision_check" CHECK ("messages"."draft_revision" >= 1);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"message_row_id" text,
	"message_id" text NOT NULL,
	"idempotency_key" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "email_outbox_status_check" CHECK ("email_outbox"."status" in ('pending', 'processing', 'sent', 'failed', 'cancelled')),
	CONSTRAINT "email_outbox_attempts_check" CHECK ("email_outbox"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_message_row_id_messages_id_fk" FOREIGN KEY ("message_row_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "email_outbox_due_idx" ON "email_outbox" USING btree ("status", "next_attempt_at", "created_at");
--> statement-breakpoint
CREATE INDEX "email_outbox_user_created_idx" ON "email_outbox" USING btree ("user_id", "created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_user_idempotency_key" ON "email_outbox" USING btree ("user_id", "idempotency_key") WHERE "email_outbox"."idempotency_key" is not null;
--> statement-breakpoint
CREATE TABLE "email_saved_searches" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"query" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "email_saved_searches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "email_saved_searches_user_name_key" UNIQUE ("user_id", "name")
);
--> statement-breakpoint
CREATE INDEX "email_saved_searches_user_order_idx" ON "email_saved_searches" USING btree ("user_id", "order", "created_at" DESC NULLS LAST);
