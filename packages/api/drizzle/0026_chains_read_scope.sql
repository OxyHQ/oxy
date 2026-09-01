-- oxy:deploy-phase=pre
--
-- PRE, and for the same reason as 0025: the three `<@` allowlists are WIDENED by
-- one value, so nothing the live image writes becomes invalid, while the
-- arriving image cannot have a credential granted `chains:read` until the value
-- is accepted.
--
-- `chains:read` is deliberately NOT in `PRIVILEGED_APPLICATION_SCOPES`, unlike
-- its write counterpart. It can only ever return collections
-- `config/chainCollectionPolicy.ts` declares public, and the server takes that
-- intersection itself rather than trusting the request — so its risk is bulk
-- access to already-public records, which is a rate-limit question rather than
-- an authority one.

ALTER TABLE "account_credentials" DROP CONSTRAINT "account_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_scopes_check";--> statement-breakpoint
ALTER TABLE "account_credentials" ADD CONSTRAINT "account_credentials_scopes_check" CHECK ("account_credentials"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'chat:completions', 'models:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read']::text[]);--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_scopes_check" CHECK ("application_credentials"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'chat:completions', 'models:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read']::text[]);--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_scopes_check" CHECK ("applications"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'chat:completions', 'models:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read']::text[]);
