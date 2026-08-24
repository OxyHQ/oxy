-- oxy:deploy-phase=pre
--
-- PRE: both `<@` allowlists are WIDENED by two values, so every write the live
-- image performs stays valid, while the arriving image cannot grant an
-- application `acting-as:offline` or `podcasts:write` until the values are
-- accepted. Nothing is narrowed and no row is rewritten, so this is correct
-- against both images at once.
--
-- `acting-as:offline` is the scope `GET /internal/service-acting-as/verify`
-- looks for in a user's `app_grants` row before it will answer
-- `authorized: true`. It is BOTH privileged (staff-only to add to an
-- application's ceiling) and consent-required (never auto-approved for the
-- user, whoever the application is) — `utils/applicationScopes.ts` records why
-- neither gate substitutes for the other.
--
-- `podcasts:write` is an ordinary non-privileged resource scope. It names a
-- resource this API does not itself serve, because Oxy is the ecosystem's
-- authorization server and `intersectScopes` DROPS any scope this vocabulary
-- does not contain — a consuming resource server's scope has to exist here or it
-- can never reach a token.
--
-- This migration creates no grant and authorises nothing on its own. Widening a
-- vocabulary is not granting: an application still needs staff to add the scope
-- to its ceiling, a credential still has to request it, and a user still has to
-- consent before any row exists for the verify endpoint to read.

ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_scopes_check";--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_scopes_check" CHECK ("application_credentials"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read', 'acting-as:offline', 'podcasts:write']::text[]);--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_scopes_check" CHECK ("applications"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read', 'acting-as:offline', 'podcasts:write']::text[]);