-- oxy:deploy-phase=pre
CREATE TABLE "github_trusted_publishers" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"repository" text NOT NULL,
	"repository_id" text NOT NULL,
	"ref" text DEFAULT 'refs/heads/main' NOT NULL,
	"workflow" text,
	"created_by_user_id" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "github_trusted_publishers_rule_key" UNIQUE NULLS NOT DISTINCT("application_id","repository_id","ref","workflow"),
	CONSTRAINT "github_trusted_publishers_repository_check" CHECK ("github_trusted_publishers"."repository" ~ '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$'),
	CONSTRAINT "github_trusted_publishers_repository_id_check" CHECK ("github_trusted_publishers"."repository_id" ~ '^[1-9][0-9]{0,19}$'),
	CONSTRAINT "github_trusted_publishers_ref_check" CHECK ("github_trusted_publishers"."ref" ~ '^refs/(heads|tags)/[^[:space:]]{1,255}$'),
	CONSTRAINT "github_trusted_publishers_workflow_check" CHECK ("github_trusted_publishers"."workflow" is null or "github_trusted_publishers"."workflow" ~ '^\.github/workflows/[A-Za-z0-9._-]{1,200}\.ya?ml$')
);
--> statement-breakpoint
ALTER TABLE "github_trusted_publishers" ADD CONSTRAINT "github_trusted_publishers_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_trusted_publishers" ADD CONSTRAINT "github_trusted_publishers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_trusted_publishers_created_by_user_id_idx" ON "github_trusted_publishers" USING btree ("created_by_user_id");