-- oxy:deploy-phase=pre
ALTER TABLE "users" ADD COLUMN "pronouns" text DEFAULT 'unspecified' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_pronouns_check" CHECK ("users"."pronouns" in ('unspecified', 'he_him', 'she_her', 'they_them', 'he_they', 'she_they', 'it_its')) NOT VALID;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_pronouns_person_check" CHECK ("users"."pronouns" = 'unspecified' or "users"."kind" = 'personal') NOT VALID;