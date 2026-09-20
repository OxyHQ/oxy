-- oxy:deploy-phase=pre
-- An added column with a default, on a table nothing selects with `*`: the
-- image still serving names its columns explicitly (the mint's select and
-- BINDING_COLUMNS), so it neither sees nor writes this one and the migration is
-- safe ahead of the rollout. The image that arrives next reads it, so `pre` is
-- also the only phase that works: `post` would leave the new mint selecting a
-- column that does not exist yet for the length of a rollout.
--
-- Empty is the whole of the old behaviour, so no backfill exists or is wanted:
-- every binding written before today keeps minting the application's
-- non-privileged grants until staff name scopes on it deliberately.
ALTER TABLE "application_workload_identities" ADD COLUMN "scopes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "application_workload_identities" ADD CONSTRAINT "application_workload_identities_scopes_check" CHECK ("application_workload_identities"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'podcasts:write']::text[]);
