-- oxy:deploy-phase=pre
ALTER TABLE "inference_provider_credential_validations" DROP CONSTRAINT "inference_provider_credential_validations_outcome_check";--> statement-breakpoint
ALTER TABLE "inference_provider_credential_validations" ADD CONSTRAINT "inference_provider_credential_validations_outcome_check" CHECK ((
        "inference_provider_credential_validations"."state" = 'pending' and "inference_provider_credential_validations"."failure_code" is null and "inference_provider_credential_validations"."completed_at" is null
      ) or (
        "inference_provider_credential_validations"."state" = 'valid' and "inference_provider_credential_validations"."failure_code" is null and "inference_provider_credential_validations"."completed_at" is not null
      ) or (
        "inference_provider_credential_validations"."state" = 'invalid' and "inference_provider_credential_validations"."failure_code" = 'unauthorized' and "inference_provider_credential_validations"."completed_at" is not null
      ) or (
        "inference_provider_credential_validations"."state" = 'inconclusive' and "inference_provider_credential_validations"."failure_code" is not null and "inference_provider_credential_validations"."failure_code" <> 'unauthorized' and "inference_provider_credential_validations"."completed_at" is not null
      ));
