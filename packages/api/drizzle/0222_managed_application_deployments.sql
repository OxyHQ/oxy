-- oxy:deploy-phase=pre
CREATE TABLE "managed_application_deployments" (
	"deployment_id" uuid PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"owner_account_id" text NOT NULL,
	"origin" text NOT NULL,
	"environment" text NOT NULL,
	"backend_role_arn" text NOT NULL,
	"worker_role_arn" text NOT NULL,
	"mcp_role_arn" text NOT NULL,
	"public_client_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "managed_application_deployments_applicationId_unique" UNIQUE("application_id"),
	CONSTRAINT "managed_application_deployments_origin_unique" UNIQUE("origin"),
	CONSTRAINT "managed_application_deployments_publicClientId_unique" UNIQUE("public_client_id"),
	CONSTRAINT "managed_application_deployments_environment_check" CHECK ("managed_application_deployments"."environment" in ('development', 'staging', 'production')),
	CONSTRAINT "managed_application_deployments_distinct_roles_check" CHECK ("managed_application_deployments"."backend_role_arn" <> "managed_application_deployments"."worker_role_arn" and "managed_application_deployments"."backend_role_arn" <> "managed_application_deployments"."mcp_role_arn" and "managed_application_deployments"."worker_role_arn" <> "managed_application_deployments"."mcp_role_arn")
);
--> statement-breakpoint
ALTER TABLE "managed_application_deployments" ADD CONSTRAINT "managed_application_deployments_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_application_deployments" ADD CONSTRAINT "managed_application_deployments_owner_account_id_users_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;