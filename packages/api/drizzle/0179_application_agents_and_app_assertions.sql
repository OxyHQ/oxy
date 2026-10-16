-- oxy:deploy-phase=pre
-- ADR 0044: which agents are an application's, and where they open
-- (`anywhere` | `own_application`), written only by Oxy staff.
-- ADR 0045: how an application is recognised (its exact web origins, Android
-- package and signing certificates, iOS team and bundle), written only by Oxy
-- staff; the single-use challenges a device proof is bound to; and the App
-- Attest keys Oxy verified.
--
-- `pre`: new tables only. The image still serving never reads or writes them,
-- so nothing it does can fail.
CREATE TABLE "application_agents" (
	"agent_account_id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"availability" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "application_agents_availability_check" CHECK ("application_agents"."availability" in ('anywhere', 'own_application'))
);
--> statement-breakpoint
CREATE TABLE "application_recognition" (
	"application_id" text PRIMARY KEY NOT NULL,
	"android_package_name" text,
	"android_signing_cert_sha256" text[] DEFAULT '{}'::text[] NOT NULL,
	"ios_team_id" text,
	"ios_bundle_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "application_recognition_android_check" CHECK (("application_recognition"."android_package_name" is null) = (cardinality("application_recognition"."android_signing_cert_sha256") = 0)),
	CONSTRAINT "application_recognition_ios_check" CHECK (("application_recognition"."ios_team_id" is null) = ("application_recognition"."ios_bundle_id" is null))
);
--> statement-breakpoint
CREATE TABLE "application_web_origins" (
	"origin" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "application_web_origins_origin_check" CHECK ("application_web_origins"."origin" ~ '^https://[^/?#@]+$')
);
--> statement-breakpoint
CREATE TABLE "app_assertion_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"challenge_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"application_id" text NOT NULL,
	"platform" text NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "app_assertion_challenges_challenge_hash_key" UNIQUE("challenge_hash"),
	CONSTRAINT "app_assertion_challenges_challenge_hash_check" CHECK ("app_assertion_challenges"."challenge_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "app_assertion_challenges_platform_check" CHECK ("app_assertion_challenges"."platform" in ('android', 'ios')),
	CONSTRAINT "app_assertion_challenges_purpose_check" CHECK ("app_assertion_challenges"."purpose" in ('assertion', 'attest_key')),
	CONSTRAINT "app_assertion_challenges_attest_key_check" CHECK ("app_assertion_challenges"."purpose" <> 'attest_key' or "app_assertion_challenges"."platform" = 'ios')
);
--> statement-breakpoint
CREATE TABLE "app_attest_keys" (
	"key_id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"public_key_spki" text NOT NULL,
	"sign_count" bigint DEFAULT 0 NOT NULL,
	"environment" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_attest_keys_key_id_check" CHECK ("app_attest_keys"."key_id" ~ '^[A-Za-z0-9+/]{43}=$'),
	CONSTRAINT "app_attest_keys_environment_check" CHECK ("app_attest_keys"."environment" in ('production', 'development')),
	CONSTRAINT "app_attest_keys_sign_count_check" CHECK ("app_attest_keys"."sign_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "application_agents" ADD CONSTRAINT "application_agents_agent_account_id_users_id_fk" FOREIGN KEY ("agent_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_agents" ADD CONSTRAINT "application_agents_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_agents" ADD CONSTRAINT "application_agents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_recognition" ADD CONSTRAINT "application_recognition_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_recognition" ADD CONSTRAINT "application_recognition_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_web_origins" ADD CONSTRAINT "application_web_origins_application_id_application_recognition_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application_recognition"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_assertion_challenges" ADD CONSTRAINT "app_assertion_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_assertion_challenges" ADD CONSTRAINT "app_assertion_challenges_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_attest_keys" ADD CONSTRAINT "app_attest_keys_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_agents_application_id_idx" ON "application_agents" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "application_recognition_android_package_name_key" ON "application_recognition" USING btree ("android_package_name");--> statement-breakpoint
CREATE UNIQUE INDEX "application_recognition_ios_app_key" ON "application_recognition" USING btree ("ios_team_id","ios_bundle_id");--> statement-breakpoint
CREATE INDEX "application_web_origins_application_id_idx" ON "application_web_origins" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "app_assertion_challenges_expires_at_idx" ON "app_assertion_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "app_attest_keys_application_id_idx" ON "app_attest_keys" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "app_attest_keys_last_used_at_idx" ON "app_attest_keys" USING btree ("last_used_at");