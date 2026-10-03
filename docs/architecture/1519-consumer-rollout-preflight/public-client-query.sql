-- Proposed read-only projection for operator review; not executed here.
-- Only PUBLIC client identifiers (never service/confidential/machine keys).
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '2s';
SELECT
  a.id AS application_id,
  a.name AS application_name,
  a.type AS application_type,
  a.status AS application_status,
  a.redirect_uris,
  c.id AS credential_id,
  c.public_key AS public_client_id,
  c.type AS credential_type,
  c.environment,
  c.status AS credential_status,
  c.expires_at
FROM public.applications AS a
JOIN public.application_credentials AS c ON c.application_id = a.id
WHERE c.type = 'public'
  AND (a.id = 'ed143b1b58d60eab417f7d5c' OR a.name = 'GoWay')
ORDER BY a.id, c.id
LIMIT 101;
ROLLBACK;
-- Refuse interpretation if 101 rows: bound exceeded. No row is not a fabricated
-- client. Multiple GoWay applications/active clients require exact registration
-- reconciliation; names are discovery only, never authority or an automatic pick.
