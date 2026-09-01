-- oxy:deploy-phase=pre
--
-- NOT IN HERE, and deliberately: `ALTER TABLE users DROP COLUMN
-- organization_category`. `drizzle-kit generate` emitted it alongside these
-- tables because the column is absent from the TypeScript schema — 0013
-- replaced it with `account_categories` and says in its own header that it
-- LEAVES THE COLUMN IN PLACE. So the drop is real pending work that nobody has
-- scheduled, and it does not belong in a migration titled "follow graph": a
-- reviewer reading this file has no reason to look for a users column being
-- destroyed, which is exactly how that kind of change ships.
--
-- The generated snapshot (`meta/0016_snapshot.json`) already omits the column,
-- which is what stops drizzle re-proposing the drop on every subsequent
-- generate. Do not "fix" the snapshot to match the database: putting the column
-- back into it re-arms this.
--
-- `users.test.ts` is what caught it, by asserting the column still exists and
-- is still CHECK-constrained.
--
-- PRE: five new tables and nothing else. The previous image does not know they
-- exist, so it can keep serving while they land — which is the point of doing
-- it before the new image rather than after.
--
-- The seed at the end registers the PLATFORM's own kinds. Everything else is an
-- application's to register through `follow-targets:register`: the platform must
-- not enumerate what a thousand applications can make followable, or every new
-- app would need a migration here before it could ship a follow button.

CREATE TABLE "follow_target_kinds" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"namespace" text NOT NULL,
	"application_id" text,
	"label" text,
	"capabilities" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_target_kinds_kind_key" UNIQUE("kind"),
	CONSTRAINT "follow_target_kinds_namespace_prefix_check" CHECK ("follow_target_kinds"."kind" like "follow_target_kinds"."namespace" || '.%'),
	CONSTRAINT "follow_target_kinds_namespace_shape_check" CHECK ("follow_target_kinds"."namespace" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "follow_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_uri" text NOT NULL,
	"kind" text NOT NULL,
	"provider_application_id" text,
	"provider_reference" text,
	"local_user_id" text,
	"metadata_snapshot" jsonb,
	"capabilities" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_targets_canonical_uri_key" UNIQUE("canonical_uri"),
	CONSTRAINT "follow_targets_local_user_id_key" UNIQUE("local_user_id")
);
--> statement-breakpoint
CREATE TABLE "follow_relationships" (
	"id" text PRIMARY KEY NOT NULL,
	"follower_user_id" text NOT NULL,
	"follow_target_id" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"origin_application_id" text,
	"created_by_grant_id" text,
	"source" text DEFAULT 'app' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_relationships_follower_target_key" UNIQUE("follower_user_id","follow_target_id")
);
--> statement-breakpoint
CREATE TABLE "follow_application_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"relationship_id" text NOT NULL,
	"application_id" text NOT NULL,
	"mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_application_overrides_relationship_application_key" UNIQUE("relationship_id","application_id")
);
--> statement-breakpoint
CREATE TABLE "follow_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"cause" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"relationship_id" text NOT NULL,
	"target_uri" text NOT NULL,
	"target_kind" text NOT NULL,
	"origin_application_id" text,
	"grant_id" text,
	"context_application_id" text,
	"payload" jsonb,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_events_event_id_key" UNIQUE("event_id")
);
--> statement-breakpoint
ALTER TABLE "account_credentials" DROP CONSTRAINT "account_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "follow_target_kinds" ADD CONSTRAINT "follow_target_kinds_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_targets" ADD CONSTRAINT "follow_targets_kind_follow_target_kinds_kind_fk" FOREIGN KEY ("kind") REFERENCES "public"."follow_target_kinds"("kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_targets" ADD CONSTRAINT "follow_targets_provider_application_id_applications_id_fk" FOREIGN KEY ("provider_application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_targets" ADD CONSTRAINT "follow_targets_local_user_id_users_id_fk" FOREIGN KEY ("local_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_relationships" ADD CONSTRAINT "follow_relationships_follower_user_id_users_id_fk" FOREIGN KEY ("follower_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_relationships" ADD CONSTRAINT "follow_relationships_follow_target_id_follow_targets_id_fk" FOREIGN KEY ("follow_target_id") REFERENCES "public"."follow_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_relationships" ADD CONSTRAINT "follow_relationships_origin_application_id_applications_id_fk" FOREIGN KEY ("origin_application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_relationships" ADD CONSTRAINT "follow_relationships_created_by_grant_id_app_grants_id_fk" FOREIGN KEY ("created_by_grant_id") REFERENCES "public"."app_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_application_overrides" ADD CONSTRAINT "follow_application_overrides_relationship_id_follow_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."follow_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_application_overrides" ADD CONSTRAINT "follow_application_overrides_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_events" ADD CONSTRAINT "follow_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_events" ADD CONSTRAINT "follow_events_origin_application_id_applications_id_fk" FOREIGN KEY ("origin_application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_events" ADD CONSTRAINT "follow_events_grant_id_app_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."app_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_events" ADD CONSTRAINT "follow_events_context_application_id_applications_id_fk" FOREIGN KEY ("context_application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "follow_target_kinds_namespace_idx" ON "follow_target_kinds" USING btree ("namespace");--> statement-breakpoint
CREATE INDEX "follow_targets_kind_idx" ON "follow_targets" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "follow_targets_provider_application_id_idx" ON "follow_targets" USING btree ("provider_application_id");--> statement-breakpoint
CREATE INDEX "follow_relationships_follower_created_idx" ON "follow_relationships" USING btree ("follower_user_id","created_at");--> statement-breakpoint
CREATE INDEX "follow_relationships_target_idx" ON "follow_relationships" USING btree ("follow_target_id");--> statement-breakpoint
CREATE INDEX "follow_relationships_origin_application_id_idx" ON "follow_relationships" USING btree ("origin_application_id");--> statement-breakpoint
CREATE INDEX "follow_relationships_expires_at_idx" ON "follow_relationships" USING btree ("expires_at") WHERE "follow_relationships"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "follow_application_overrides_application_idx" ON "follow_application_overrides" USING btree ("application_id","mode");--> statement-breakpoint
CREATE INDEX "follow_events_pending_idx" ON "follow_events" USING btree ("created_at") WHERE "follow_events"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "follow_events_relationship_idx" ON "follow_events" USING btree ("relationship_id");--> statement-breakpoint
CREATE INDEX "follow_events_actor_idx" ON "follow_events" USING btree ("actor_user_id","created_at");--> statement-breakpoint
ALTER TABLE "account_credentials" ADD CONSTRAINT "account_credentials_scopes_check" CHECK ("account_credentials"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'chat:completions', 'models:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register']::text[]);--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_scopes_check" CHECK ("application_credentials"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'chat:completions', 'models:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register']::text[]);

--> statement-breakpoint
-- The `oxy` namespace, owned by the platform rather than by any application —
-- hence a NULL `application_id`. `oxy.user` is the one kind whose reverse side
-- is public, because a person's followers already are.
INSERT INTO "follow_target_kinds" ("id", "kind", "namespace", "application_id", "label", "capabilities")
VALUES
  (gen_random_uuid()::text, 'oxy.user', 'oxy', NULL, 'People',
   '{"verb":"follow","reverse":"public","federated":true}'::jsonb),
  (gen_random_uuid()::text, 'oxy.topic', 'oxy', NULL, 'Topics',
   '{"verb":"follow","reverse":"aggregate","federated":false}'::jsonb)
ON CONFLICT ("kind") DO NOTHING;
