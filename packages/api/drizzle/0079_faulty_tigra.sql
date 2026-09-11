-- oxy:deploy-phase=pre
-- Widen the application and credential scope CHECKs for `files:linked:read`
-- (ADR 0021), the scope that lets a relying service mint a download URL for a
-- file the file's own owner attached to it.
--
-- `pre`, and the DROP in the first two statements is not a reason to make it
-- `post`. Each constraint is re-added in the SAME file as a strict SUPERSET of
-- itself, so at no point does anything become unrepresentable and the image
-- still serving is unaffected — it writes only scope values the wider CHECK
-- already accepts. The reverse ordering is the one that breaks: this file must
-- land BEFORE the image that can grant the new scope, or granting it is refused
-- by a constraint nobody thinks to look at, which is the shape of the outage
-- `check-migration-phases.mjs` documents.
--
-- Generated, not hand-written: `applications_scopes_check` is rendered from the
-- APPLICATION_SCOPES tuple, so adding a member to that tuple silently owes this
-- migration. `check-drizzle-snapshot-sync` is what caught the first commit
-- shipping the tuple change without it.
ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_scopes_check";--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_scopes_check" CHECK ("application_credentials"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'podcasts:write']::text[]);--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_scopes_check" CHECK ("applications"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'podcasts:write']::text[]);