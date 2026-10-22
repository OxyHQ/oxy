-- oxy:deploy-phase=pre
--
-- console_onboarding: a new table, one row per user (Oxy Console first-run terms and use cases).
-- Purely additive; the image still serving never reads it.
CREATE TABLE "console_onboarding" (
	"user_id" text PRIMARY KEY NOT NULL,
	"terms_version" text,
	"terms_accepted_at" timestamp with time zone,
	"adult_acknowledged" boolean DEFAULT false NOT NULL,
	"aup_acknowledged" boolean DEFAULT false NOT NULL,
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"use_cases" text[] DEFAULT '{}'::text[] NOT NULL,
	"use_case_description" text,
	"use_cases_answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "console_onboarding_use_case_description_check" CHECK ("console_onboarding"."use_case_description" is null or char_length("console_onboarding"."use_case_description") <= 2000),
	CONSTRAINT "console_onboarding_use_cases_check" CHECK ("console_onboarding"."use_cases" <@ array['build-with-api', 'ai-models', 'publish-apps', 'billing-credits', 'explore-platform']::text[]),
	CONSTRAINT "console_onboarding_terms_complete_check" CHECK (("console_onboarding"."terms_version" is null) = ("console_onboarding"."terms_accepted_at" is null) and ("console_onboarding"."terms_version" is null or ("console_onboarding"."adult_acknowledged" and "console_onboarding"."aup_acknowledged")))
);
--> statement-breakpoint
ALTER TABLE "console_onboarding" ADD CONSTRAINT "console_onboarding_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;