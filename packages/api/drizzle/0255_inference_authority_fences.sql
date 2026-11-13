-- oxy:deploy-phase=pre
-- New empty table; inline FKs validate no historical rows. No population is activated by this migration.
CREATE TABLE "inference_authority_fences" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"owner_account_id" text NOT NULL,
	"environment" text NOT NULL,
	"credential_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "inference_authority_fences_population_key" UNIQUE("application_id","owner_account_id","environment","credential_kind"),
	CONSTRAINT "inference_authority_fences_environment_check" CHECK ("inference_authority_fences"."environment" in ('development', 'staging', 'production')),
	CONSTRAINT "inference_authority_fences_credential_kind_check" CHECK ("inference_authority_fences"."credential_kind" = 'workload'),
	CONSTRAINT "inference_authority_fences_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT,
	CONSTRAINT "inference_authority_fences_owner_account_id_users_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "users"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE FUNCTION oxy_inference_authority_lock(app_id text, owner_id text, env text) RETURNS void
LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('inference-authority:' || json_build_array(app_id, owner_id, env)::text, 0));
$$;
--> statement-breakpoint
CREATE FUNCTION oxy_inference_authority_fence_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0AF2', MESSAGE = 'Inference authority fences are permanent';
  END IF;
  PERFORM oxy_inference_authority_lock(NEW.application_id, NEW.owner_account_id, NEW.environment);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inference_authority_fence_write BEFORE INSERT OR UPDATE OR DELETE
ON inference_authority_fences FOR EACH ROW EXECUTE FUNCTION oxy_inference_authority_fence_write();
--> statement-breakpoint
CREATE FUNCTION oxy_inference_admission_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Public client IDs and machine credentials never select this workload population.
  IF EXISTS (SELECT 1 FROM application_credentials c
    WHERE c.id = NEW.application_credential_id AND c.type = 'workload'
      AND c.application_id = NEW.application_id AND c.environment = NEW.environment) THEN
    PERFORM oxy_inference_authority_lock(NEW.application_id, NEW.account_id, NEW.environment);
    IF EXISTS (SELECT 1 FROM inference_authority_fences f
      WHERE f.application_id = NEW.application_id AND f.owner_account_id = NEW.account_id
        AND f.environment = NEW.environment AND f.credential_kind = 'workload') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0AF1', MESSAGE = 'Inference authority is transitioning';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inference_admission_authority BEFORE INSERT ON inference_metered_usage
FOR EACH ROW EXECUTE FUNCTION oxy_inference_admission_authority();
