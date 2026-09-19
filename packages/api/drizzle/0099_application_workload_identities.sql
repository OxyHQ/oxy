-- oxy:deploy-phase=pre
-- A new table nothing reads yet: the workload-identity mint arrives with it and
-- the previous image never selects from it, so it applies before the rollout.
CREATE TABLE "application_workload_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"description" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "application_workload_identities_provider_subject_key" UNIQUE("provider","subject")
);
--> statement-breakpoint
ALTER TABLE "application_workload_identities" ADD CONSTRAINT "application_workload_identities_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_workload_identities_application_idx" ON "application_workload_identities" USING btree ("application_id");