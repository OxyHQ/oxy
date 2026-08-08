-- oxy:deploy-phase=pre

CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_oxy_user_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "notes_status_check" CHECK ("notes"."status" in ('draft', 'published', 'archived'))
);
--> statement-breakpoint
CREATE INDEX "notes_owner_created_idx" ON "notes" USING btree ("owner_oxy_user_id","created_at" DESC NULLS LAST);