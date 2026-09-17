-- oxy:deploy-phase=pre
CREATE TABLE "families" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_members" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"member_user_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"invited_by_user_id" text,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "family_members_family_id_member_user_id_key" UNIQUE("family_id","member_user_id"),
	CONSTRAINT "family_members_role_check" CHECK ("family_members"."role" in ('organizer', 'member')),
	CONSTRAINT "family_members_status_check" CHECK ("family_members"."status" in ('invited', 'active', 'removed'))
);
--> statement-breakpoint
ALTER TABLE "family_members" ADD CONSTRAINT "family_members_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_members" ADD CONSTRAINT "family_members_member_user_id_users_id_fk" FOREIGN KEY ("member_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_members" ADD CONSTRAINT "family_members_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "family_members_member_user_id_active_key" ON "family_members" USING btree ("member_user_id") WHERE "family_members"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "family_members_family_id_organizer_key" ON "family_members" USING btree ("family_id") WHERE "family_members"."role" = 'organizer' and "family_members"."status" = 'active';--> statement-breakpoint
CREATE INDEX "family_members_family_id_status_idx" ON "family_members" USING btree ("family_id","status");--> statement-breakpoint
CREATE INDEX "family_members_member_user_id_status_idx" ON "family_members" USING btree ("member_user_id","status");