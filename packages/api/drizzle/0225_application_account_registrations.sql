-- oxy:deploy-phase=pre
CREATE TABLE "application_account_registrations" (
	"application_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "application_account_registrations_application_id_user_id_pk" PRIMARY KEY("application_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "application_account_totals" (
	"application_id" text PRIMARY KEY NOT NULL,
	"total" bigint NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "application_account_totals_total_check" CHECK ("application_account_totals"."total" >= 0)
);
--> statement-breakpoint
ALTER TABLE "application_account_registrations" ADD CONSTRAINT "application_account_registrations_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_account_registrations" ADD CONSTRAINT "application_account_registrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_account_totals" ADD CONSTRAINT "application_account_totals_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_account_registrations_user_id_idx" ON "application_account_registrations" USING btree ("user_id");