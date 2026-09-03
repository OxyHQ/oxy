-- oxy:deploy-phase=pre
CREATE TABLE "inference_provider_credential_validations" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"application_id" text NOT NULL,
	"provider" text NOT NULL,
	"owner_account_id" text NOT NULL,
	"environment" text NOT NULL,
	"credential_handle" text NOT NULL,
	"credential_revision" bigint NOT NULL,
	"deployment_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"failure_code" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_provider_credential_validations_state_check" CHECK ("inference_provider_credential_validations"."state" in ('pending', 'valid', 'invalid', 'inconclusive')),
	CONSTRAINT "inference_provider_credential_validations_environment_check" CHECK ("inference_provider_credential_validations"."environment" in ('development', 'staging', 'production')),
	CONSTRAINT "inference_provider_credential_validations_handle_check" CHECK ("inference_provider_credential_validations"."credential_handle" ~ '^kcred_[a-z2-7]{26}$'),
	CONSTRAINT "inference_provider_credential_validations_revision_check" CHECK ("inference_provider_credential_validations"."credential_revision" > 0 and "inference_provider_credential_validations"."credential_revision" <= 9007199254740991),
	CONSTRAINT "inference_provider_credential_validations_deployment_check" CHECK (length("inference_provider_credential_validations"."deployment_id") between 1 and 128 and "inference_provider_credential_validations"."deployment_id" = btrim("inference_provider_credential_validations"."deployment_id") and "inference_provider_credential_validations"."deployment_id" !~ E'[\r\n]'),
	CONSTRAINT "inference_provider_credential_validations_outcome_check" CHECK ((
        "inference_provider_credential_validations"."state" = 'pending' and "inference_provider_credential_validations"."failure_code" is null and "inference_provider_credential_validations"."completed_at" is null
      ) or (
        "inference_provider_credential_validations"."state" = 'valid' and "inference_provider_credential_validations"."failure_code" is null and "inference_provider_credential_validations"."completed_at" is not null
      ) or (
        "inference_provider_credential_validations"."state" = 'invalid' and "inference_provider_credential_validations"."failure_code" = 'unauthorized' and "inference_provider_credential_validations"."completed_at" is not null
      ) or (
        "inference_provider_credential_validations"."state" = 'inconclusive' and "inference_provider_credential_validations"."failure_code" is not null and "inference_provider_credential_validations"."completed_at" is not null
      ))
);
--> statement-breakpoint
ALTER TABLE "inference_provider_credential_validations" ADD CONSTRAINT "inference_provider_credential_validations_connection_id_inference_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."inference_provider_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_provider_credential_validations" ADD CONSTRAINT "inference_provider_credential_validations_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_provider_credential_validations_pending_generation_key" ON "inference_provider_credential_validations" USING btree ("connection_id","credential_handle","credential_revision") WHERE "inference_provider_credential_validations"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "inference_provider_credential_validations_connection_created_at_idx" ON "inference_provider_credential_validations" USING btree ("connection_id","created_at" DESC NULLS LAST);
