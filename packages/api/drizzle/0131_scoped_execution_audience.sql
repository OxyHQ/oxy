-- oxy:deploy-phase=pre
ALTER TABLE "inference_deployments" ADD COLUMN "scoped_execution" jsonb;
