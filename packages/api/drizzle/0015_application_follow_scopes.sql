-- oxy:deploy-phase=pre
--
-- PRE, because this only WIDENS what the column accepts. The previous image
-- never writes a follow scope, and every value it does write is still admitted,
-- so the constraint can land before the new image is live without a window in
-- which either version is rejected.
-- The follow scope family, admitted by the database.
--
-- `applications.scopes` is CHECK-constrained to the `APPLICATION_SCOPES` tuple,
-- and the constraint carries a literal copy of that list. Adding the scopes to
-- the TypeScript tuple therefore did nothing on its own: an application granted
-- `follows:write` was rejected at write time, so the consent flow shipped in
-- #810 could be exercised and then never satisfied.
--
-- Dropped and recreated rather than edited: a CHECK is not alterable in place,
-- and Postgres validates the new one against existing rows as it is added — so
-- a row this list would have excluded fails the migration loudly instead of
-- surviving under a constraint nobody re-checked.
ALTER TABLE "applications" DROP CONSTRAINT "applications_scopes_check";--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_scopes_check" CHECK ("applications"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'chat:completions', 'models:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register']::text[]);
