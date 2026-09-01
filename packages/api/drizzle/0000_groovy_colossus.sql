-- oxy:deploy-phase=pre
-- Additive; safe while the previous image serves. See src/db/migrationPhases.ts.

CREATE TABLE "app_affinity_seen_events" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_affinity_seen_events_application_id_event_id_key" UNIQUE("application_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"challenge" text NOT NULL,
	"purpose" text DEFAULT 'signin' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_challenges_challenge_key" UNIQUE("challenge"),
	CONSTRAINT "auth_challenges_purpose_check" CHECK ("auth_challenges"."purpose" in ('signin', 'rotate_key'))
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"blocked_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_user_id_blocked_id_key" UNIQUE("user_id","blocked_id")
);
--> statement-breakpoint
CREATE TABLE "bookmarks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"post_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#4285f4' NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_previews" (
	"id" text PRIMARY KEY NOT NULL,
	"requested_url" text NOT NULL,
	"canonical_url" text NOT NULL,
	"title" text,
	"description" text,
	"site_name" text,
	"favicon" text,
	"image_url" text,
	"origin_image_url" text,
	"origin_favicon_url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_previews_status_check" CHECK ("link_previews"."status" in ('resolved', 'pending', 'empty'))
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"device_id" text,
	"application_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_tokens_user_id_token_key" UNIQUE("user_id","token"),
	CONSTRAINT "push_tokens_platform_check" CHECK ("push_tokens"."platform" in ('ios', 'android', 'web'))
);
--> statement-breakpoint
CREATE TABLE "webauthn_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"credential_public_key" "bytea" NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[],
	"device_type" text NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"user_verified" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "webauthn_credentials_credential_id_key" UNIQUE("credential_id"),
	CONSTRAINT "webauthn_credentials_device_type_check" CHECK ("webauthn_credentials"."device_type" in ('singleDevice', 'multiDevice'))
);
--> statement-breakpoint
CREATE INDEX "app_affinity_seen_events_created_at_idx" ON "app_affinity_seen_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "auth_challenges_expires_at_idx" ON "auth_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "blocks_blocked_id_idx" ON "blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE INDEX "bookmarks_user_id_idx" ON "bookmarks" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_user_id_lower_name_key" ON "labels" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE INDEX "link_previews_status_idx" ON "link_previews" USING btree ("status");--> statement-breakpoint
CREATE INDEX "link_previews_updated_at_idx" ON "link_previews" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "push_tokens_user_id_application_id_idx" ON "push_tokens" USING btree ("user_id","application_id");--> statement-breakpoint
CREATE INDEX "webauthn_credentials_user_id_idx" ON "webauthn_credentials" USING btree ("user_id");