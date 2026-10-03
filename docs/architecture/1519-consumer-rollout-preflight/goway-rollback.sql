-- Reviewed operator template, NOT executed in production.
-- psql --set=ON_ERROR_STOP=1 with receipt-derived owner_id, credential_id,
-- public_client_id, app_xmin and credential_xmin. No secret inputs.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
CREATE TEMP TABLE goway_rollback_expected ON COMMIT DROP AS SELECT
  :'owner_id'::text owner_id, :'credential_id'::text credential_id,
  :'public_client_id'::text public_client_id, :'app_xmin'::text app_xmin,
  :'credential_xmin'::text credential_xmin;
-- Match the seed lock order. Holding both locks prevents a change between CAS
-- validation and the two writes. Any exception rolls back both writes.
SELECT a.id FROM public.applications a
WHERE a.id = '73176d04c3654667138c23ec' FOR UPDATE;
SELECT c.id FROM public.application_credentials c
WHERE c.application_id = '73176d04c3654667138c23ec' ORDER BY c.id FOR UPDATE;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.applications a, goway_rollback_expected e
      WHERE a.id = '73176d04c3654667138c23ec'
        AND a.xmin::text = e.app_xmin AND a.name = 'GoWay'
        AND a.owner_account_id = e.owner_id AND a.created_by_user_id = e.owner_id
        AND a.status = 'active' AND a.type = 'first_party'
        AND a.is_official AND NOT a.is_internal
        AND a.website_url = 'https://goway.to'
        AND a.redirect_uris = ARRAY['https://goway.to']::text[]
        AND a.scopes = ARRAY['user:read']::text[]
        AND a.capabilities = ARRAY[]::text[]) <> 1 THEN
    RAISE EXCEPTION 'GoWay application receipt no longer matches; refusing rollback';
  END IF;
  IF (SELECT count(*) FROM public.application_credentials
      WHERE application_id = '73176d04c3654667138c23ec') <> 1 OR
     (SELECT count(*) FROM public.application_credentials c, goway_rollback_expected e
      WHERE c.id = e.credential_id AND c.application_id = '73176d04c3654667138c23ec'
        AND c.xmin::text = e.credential_xmin AND c.public_key = e.public_client_id
        AND c.created_by_user_id = e.owner_id AND c.type = 'public'
        AND c.environment = 'production' AND c.status = 'active'
        AND c.secret_hash IS NULL AND c.expires_at IS NULL
        AND c.scopes = ARRAY['user:read']::text[]) <> 1 THEN
    RAISE EXCEPTION 'GoWay credential receipt no longer matches; refusing rollback';
  END IF;
END $$;
UPDATE public.application_credentials SET status = 'revoked', updated_at = now()
WHERE id = (SELECT credential_id FROM goway_rollback_expected)
RETURNING id, application_id, status, xmin::text;
UPDATE public.applications SET status = 'suspended', updated_at = now()
WHERE id = '73176d04c3654667138c23ec'
RETURNING id, status, xmin::text;
COMMIT;
-- Follow with a new read-only transaction and public metadata refusal check.
-- Preserve rows/history. This does not claim existing user sessions are revoked.
