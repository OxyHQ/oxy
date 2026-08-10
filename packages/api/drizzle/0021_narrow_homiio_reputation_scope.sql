-- Homiio reports lease lifecycle events; it must not inherit the global ledger
-- mutation authority used by trusted platform services.
ALTER TABLE "account_credentials" DROP CONSTRAINT "account_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_scopes_check";--> statement-breakpoint

UPDATE "applications"
SET "scopes" = array_append(array_remove("scopes", 'reputation:write'), 'reputation:lease:write')
WHERE lower(btrim("name")) = 'homiio'
  AND "scopes" @> array['reputation:write']::text[]
  AND NOT "scopes" @> array['reputation:lease:write']::text[];--> statement-breakpoint

ALTER TABLE "account_credentials" ADD CONSTRAINT "account_credentials_scopes_check" CHECK ("account_credentials"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'chat:completions', 'models:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register']::text[]);--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_scopes_check" CHECK ("application_credentials"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'chat:completions', 'models:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register']::text[]);--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_scopes_check" CHECK ("applications"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'chat:completions', 'models:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register']::text[]);
