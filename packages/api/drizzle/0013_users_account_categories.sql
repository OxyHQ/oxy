-- oxy:deploy-phase=pre
-- Additive; safe while the previous image serves. See src/db/migrationPhases.ts.

-- users.account_categories — the ordered, multi-valued replacement for the
-- single-valued users.organization_category.
--
-- SAFE TO APPLY BEFORE THE CODE THAT USES IT DEPLOYS, which is the order this
-- repo's migrations run in. Nothing here drops or renames a column the running
-- image reads, and the new column carries a DEFAULT, so an INSERT issued by the
-- old image (which does not name it) still succeeds.
--
-- users.organization_category is deliberately LEFT IN PLACE. Dropping it here
-- would 500 every user read served by the still-running image, because drizzle
-- selects columns by name. Its drop is a SEPARATE migration, dispatched only
-- after the new image is live.
--
-- BEFORE running that drop migration, check that nothing was left behind by the
-- carry below:
--
--   select id, kind, organization_category
--   from users
--   where organization_category is not null
--     and cardinality(account_categories) = 0;
--
-- Expect zero rows. A row here is a PERSONAL account carrying an organization
-- category — a state every write path has always refused, so the expected count
-- is zero, which is exactly why a silent skip would never be noticed if it were
-- wrong. The carry skips those rows rather than failing, because
-- users_account_categories_kind_check does not admit them and blocking a
-- production migration on a cosmetic pre-existing defect is the worse trade.
-- The value is not lost while this column still exists — that is what makes the
-- skip recoverable, and why the check above must be run before the drop.
--
-- ALSO IN THIS MIGRATION, and unrelated to categories: the three
-- `scopes <@ array[…]` CHECK constraints are widened to include
-- `accounts:provision`. That scope was added to APPLICATION_SCOPES in 8730111f
-- without a migration, so the CHECKs in production REJECT it today — an
-- application or credential granted `accounts:provision` cannot be stored. The
-- statements below are what `db:generate` emits from the current schema; they
-- are not optional and separating them would record the drift as applied
-- without applying it.

ALTER TABLE "account_credentials" DROP CONSTRAINT "account_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_scopes_check";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "account_categories" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- Carry the single value across as a one-element list. It becomes the PRIMARY
-- category by virtue of being first, which is the whole ordering contract.
UPDATE "users"
   SET "account_categories" = array["organization_category"]
 WHERE "organization_category" IS NOT NULL
   AND "kind" IN ('organization', 'project', 'bot', 'channel');--> statement-breakpoint
ALTER TABLE "account_credentials" ADD CONSTRAINT "account_credentials_scopes_check" CHECK ("account_credentials"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'chat:completions', 'models:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision']::text[]);--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_scopes_check" CHECK ("application_credentials"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'chat:completions', 'models:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision']::text[]);--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_scopes_check" CHECK ("applications"."scopes" <@ array['files:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'chat:completions', 'models:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'payments:read', 'payments:write', 'accounts:provision']::text[]);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_categories_check" CHECK ("users"."account_categories" <@ array['news', 'politics', 'business', 'startup', 'finance', 'crypto', 'marketplace', 'retail', 'real_estate', 'agency', 'landlord', 'cooperative', 'architecture', 'technology', 'software', 'ai', 'security', 'automation', 'science', 'education', 'books', 'health', 'fitness', 'sports', 'gaming', 'music', 'film', 'podcast', 'art', 'photography', 'comedy', 'food', 'travel', 'fashion', 'home_garden', 'diy', 'automotive', 'animals', 'family', 'nonprofit', 'government', 'community', 'activism', 'environment', 'religion', 'other']::text[]);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_categories_max_check" CHECK (cardinality("users"."account_categories") <= 4);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_categories_kind_check" CHECK ("users"."kind" in ('organization', 'project', 'bot', 'channel') or cardinality("users"."account_categories") = 0);