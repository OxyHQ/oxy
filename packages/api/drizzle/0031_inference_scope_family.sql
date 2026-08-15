-- oxy:deploy-phase=pre
--
-- The inference scope family replaces `chat:completions` and `models:read`. This
-- is a RENAME of two vocabulary entries plus five new ones, not a revocation:
-- every row holding a retired name is rewritten to its successor here, in the
-- same statement block that stops the retired name being writable.
--
-- WHY `pre`, even though the allowlists NARROW.
--
-- The widening half forces it: the arriving image writes `inference:*` values
-- that the CURRENT constraint rejects, so this cannot wait until after the
-- rollout. The narrowing half is the part worth arguing, and the question the
-- repo's gate rule asks is not "does it narrow" but "does it break a write the
-- PREVIOUS image performs". It does not, in normal operation: no seed, no boot
-- path and no automatic write in the running image emits either retired name —
-- `scripts/seed-oxy-applications.ts` and `scripts/register-commons-clients.ts`
-- name neither, and `developer_api_keys` (whose column default did) has no
-- reader or writer left in this package. The only way the outgoing image can
-- still write one is an operator explicitly granting it through Console during
-- the rollout window, and what they would be granting authorises nothing: no
-- middleware, route or service ever read either scope. That trade is worth
-- taking rather than deferring the narrowing to `post`, which a zero-capacity
-- deploy skips entirely and which would leave the retired names writable for as
-- long as the deferral lasts — the opposite of the clean cut this is.
--
-- ORDER MATTERS. Every rewrite runs after the DROPs and before the ADDs. Run the
-- other way round, the narrowed CHECK would reject the very rows the UPDATE
-- exists to fix, and the migration would fail on any database holding one.
--
-- `array_replace` preserves both order and cardinality, and it cannot introduce
-- a duplicate here: `inference:invoke` and `inference:models:read` are new names
-- this migration is the first thing to write, so no existing row can already
-- hold one to collide with.
--
-- `app_grants` carries no CHECK, deliberately — a grant records what the USER
-- consented to, and constraining it to the current vocabulary would make the
-- historical record un-writable the moment a scope is retired (see the header of
-- `db/schema/appGrants.ts`). It is still rewritten, because a grant is read to
-- decide whether a returning user skips the consent screen: leaving the old name
-- there would silently re-prompt every user who has already agreed to exactly
-- this permission under its previous spelling.

ALTER TABLE "account_credentials" DROP CONSTRAINT "account_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_scopes_check";--> statement-breakpoint
ALTER TABLE "developer_api_keys" DROP CONSTRAINT "developer_api_keys_scopes_check";--> statement-breakpoint
UPDATE "applications" SET "scopes" = array_replace(array_replace("scopes", 'chat:completions', 'inference:invoke'), 'models:read', 'inference:models:read') WHERE "scopes" && array['chat:completions', 'models:read']::text[];--> statement-breakpoint
UPDATE "application_credentials" SET "scopes" = array_replace(array_replace("scopes", 'chat:completions', 'inference:invoke'), 'models:read', 'inference:models:read') WHERE "scopes" && array['chat:completions', 'models:read']::text[];--> statement-breakpoint
UPDATE "account_credentials" SET "scopes" = array_replace(array_replace("scopes", 'chat:completions', 'inference:invoke'), 'models:read', 'inference:models:read') WHERE "scopes" && array['chat:completions', 'models:read']::text[];--> statement-breakpoint
UPDATE "developer_api_keys" SET "scopes" = array_replace(array_replace("scopes", 'chat:completions', 'inference:invoke'), 'models:read', 'inference:models:read') WHERE "scopes" && array['chat:completions', 'models:read']::text[];--> statement-breakpoint
UPDATE "app_grants" SET "scopes" = array_replace(array_replace("scopes", 'chat:completions', 'inference:invoke'), 'models:read', 'inference:models:read') WHERE "scopes" && array['chat:completions', 'models:read']::text[];--> statement-breakpoint
ALTER TABLE "developer_api_keys" ALTER COLUMN "scopes" SET DEFAULT '{"inference:invoke","inference:models:read"}';--> statement-breakpoint
ALTER TABLE "account_credentials" ADD CONSTRAINT "account_credentials_scopes_check" CHECK ("account_credentials"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read']::text[]);--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_scopes_check" CHECK ("application_credentials"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read']::text[]);--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_scopes_check" CHECK ("applications"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'chains:read']::text[]);--> statement-breakpoint
ALTER TABLE "developer_api_keys" ADD CONSTRAINT "developer_api_keys_scopes_check" CHECK ("developer_api_keys"."scopes" <@ array['inference:invoke', 'inference:models:read', 'files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive']::text[]);
