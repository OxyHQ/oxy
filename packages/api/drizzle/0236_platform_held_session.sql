-- oxy:deploy-phase=pre
-- ADR 0058, the platform holds the Oxy session. Additive: every new column is
-- NULL for every existing row, and the image still serving reads none of them.
-- On `device_credentials` (hot) only brief DDL here: the foreign key and both
-- CHECKs are added NOT VALID, the index is 0237 and the validation 0238.
CREATE TABLE "application_oxyos_entries" (
	"desktop_entry_id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "application_oxyos_entries_desktop_entry_id_check" CHECK ("application_oxyos_entries"."desktop_entry_id" ~ '^[a-z0-9]+([.][a-z0-9-]+)+$' and length("application_oxyos_entries"."desktop_entry_id") <= 255)
);
--> statement-breakpoint
ALTER TABLE "application_oxyos_entries" ADD CONSTRAINT "application_oxyos_entries_application_id_application_recognition_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application_recognition"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_oxyos_entries_application_id_idx" ON "application_oxyos_entries" USING btree ("application_id");--> statement-breakpoint
ALTER TABLE "application_recognition" ADD COLUMN "platform_host" text;--> statement-breakpoint
ALTER TABLE "application_recognition" ADD CONSTRAINT "application_recognition_platform_host_check" CHECK ("application_recognition"."platform_host" is null or "application_recognition"."platform_host" in ('oxyos', 'astro'));--> statement-breakpoint
ALTER TABLE "signin_second_factor_challenges" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "signin_second_factor_challenges" ADD COLUMN "platform_client_id" text;--> statement-breakpoint
ALTER TABLE "signin_second_factor_challenges" ADD CONSTRAINT "signin_second_factor_challenges_platform_check" CHECK (("signin_second_factor_challenges"."platform" is null) = ("signin_second_factor_challenges"."platform_client_id" is null) and ("signin_second_factor_challenges"."platform" is null or "signin_second_factor_challenges"."platform" in ('oxyos', 'astro')));--> statement-breakpoint
ALTER TABLE "device_credentials" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD COLUMN "platform_application_id" text;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_platform_application_id_applications_id_fk" FOREIGN KEY ("platform_application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_platform_check" CHECK ("device_credentials"."platform" is null or "device_credentials"."platform" in ('oxyos', 'astro')) NOT VALID;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_platform_application_check" CHECK (("device_credentials"."platform" is null) = ("device_credentials"."platform_application_id" is null)) NOT VALID;
