-- oxy:deploy-phase=pre
-- No fence is activated. Drain transactions using the old owner-specific advisory key
-- before replacing it. This brief writer lock permits reads; no data backfill occurs.
LOCK TABLE inference_metered_usage IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "inference_authority_fences" DROP CONSTRAINT "inference_authority_fences_credential_kind_check";--> statement-breakpoint
CREATE UNIQUE INDEX "inference_authority_fences_application_key" ON "inference_authority_fences" USING btree ("application_id","environment") WHERE "inference_authority_fences"."credential_kind" = 'application';--> statement-breakpoint
ALTER TABLE "inference_authority_fences" ADD CONSTRAINT "inference_authority_fences_credential_kind_check" CHECK ("inference_authority_fences"."credential_kind" in ('workload', 'application'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION oxy_inference_authority_lock(app_id text, owner_id text, env text) RETURNS void
LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('inference-authority-application:' || json_build_array(app_id, env)::text, 0));
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION oxy_inference_admission_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Authority migrates with the application-wide budget, not the credential lane.
  -- This lock is shared by all owners/credentials and by explicit fence activation.
  PERFORM oxy_inference_authority_lock(NEW.application_id, NEW.account_id, NEW.environment);
  IF EXISTS (SELECT 1 FROM inference_authority_fences f
    WHERE f.application_id = NEW.application_id AND f.environment = NEW.environment
      AND (f.credential_kind = 'application' OR
        (f.credential_kind = 'workload' AND f.owner_account_id = NEW.account_id
          AND EXISTS (SELECT 1 FROM application_credentials c
            WHERE c.id = NEW.application_credential_id AND c.type = 'workload')))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0AF1', MESSAGE = 'Inference authority is transitioning';
  END IF;
  RETURN NEW;
END;
$$;
