-- oxy:deploy-phase=pre
-- Retire one absent backend: no service, runnable task definition, IAM role or
-- scheduler remains. Noted's public client and Nilo-hosted MCP remain active.
-- No schema change, grant deletion, global v1 cutover or attribution-row deletion.
-- Tuple and expiry guards make concurrent identity drift a hard failure.
DO $retire_noted$
DECLARE
  binding public.application_workload_identities%ROWTYPE;
  retired_at CONSTANT timestamptz := '2026-10-25T00:00:00.000Z';
BEGIN
  SELECT * INTO binding FROM public.application_workload_identities
  WHERE id = '01a12a46-0ab6-721d-86a0-c63669a4e9b6'
  FOR UPDATE;
  -- Fresh databases never had this retired production workload.
  IF NOT FOUND THEN RETURN; END IF;
  IF binding.application_id IS DISTINCT FROM '6a37b3e71ddfd195b65681d2'
     OR binding.provider IS DISTINCT FROM 'aws-iam'
     OR binding.subject IS DISTINCT FROM 'arn:aws:iam::237343248947:role/oxy-noted-task'
     OR binding.environment IS DISTINCT FROM 'production' THEN
    RAISE EXCEPTION 'Noted workload binding identity drift; no change applied';
  END IF;
  IF binding.expires_at IS NULL THEN
    UPDATE public.application_workload_identities
    SET expires_at = retired_at, updated_at = now()
    WHERE id = binding.id AND expires_at IS NULL;
  ELSIF binding.expires_at IS DISTINCT FROM retired_at THEN
    RAISE EXCEPTION 'Noted workload expiry drift; no change applied';
  END IF;
END
$retire_noted$;
