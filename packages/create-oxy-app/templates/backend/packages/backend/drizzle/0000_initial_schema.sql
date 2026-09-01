-- oxy:deploy-phase=pre

CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notes_oxy_user_id_created_at_idx" ON "notes" USING btree ("oxy_user_id","created_at" DESC NULLS LAST);
