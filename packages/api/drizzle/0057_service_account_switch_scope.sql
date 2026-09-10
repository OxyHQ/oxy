-- oxy:deploy-phase=pre
--
-- PRE: both `<@` allowlists are WIDENED by one value, so every write the live
-- image performs stays valid, while the arriving image cannot grant an
-- application `accounts:act-as-session` until the value is accepted. Nothing is
-- narrowed and no row is rewritten, so this is correct against both images at
-- once. It is the same shape as 0055, for the same reason.
--
-- `accounts:act-as-session` is the scope
-- `POST /internal/accounts/:id/service-switch` requires before it will mint a
-- session whose SUBJECT is a managed account (organization / project / bot), on
-- the authority of a human holding `account:act_as` over it.
--
-- It is PRIVILEGED (staff-only to add to an application's ceiling) and
-- deliberately NOT consent-required — `utils/applicationScopes.ts` records both
-- decisions and why the second is an argument rather than an omission.
--
-- It is NOT a variant of `acting-as:offline`. That scope buys per-request
-- attribution; this one buys a durable bearer that speaks as another account.
-- Spelling one as a flavour of the other would have promoted every current
-- holder of the smaller authority to the larger one, silently.
--
-- This migration creates no grant and authorises nothing on its own. Widening a
-- vocabulary is not granting: an application still needs staff to add the scope
-- to its ceiling, and a credential still has to request it, before any token can
-- carry it.

ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_scopes_check";--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_scopes_check" CHECK ("application_credentials"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'podcasts:write']::text[]);--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_scopes_check" CHECK ("applications"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'podcasts:write']::text[]);