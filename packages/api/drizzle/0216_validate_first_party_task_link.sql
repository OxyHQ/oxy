-- oxy:deploy-phase=pre
-- Validate separately from additive DDL so the existing execution table keeps serving reads.
ALTER TABLE "capability_execution_authorizations"
  VALIDATE CONSTRAINT "capability_execution_authorizations_task_id_first_party_tasks_id_fk";
