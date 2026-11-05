-- oxy:deploy-phase=pre
-- ADR 0056: a first-party key names the owning account's roles that hold it.
ALTER TABLE "application_role_permissions" ADD COLUMN "held_by_account_roles" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "application_role_permissions" ADD CONSTRAINT "application_role_permissions_held_by_account_roles_check" CHECK ("application_role_permissions"."held_by_account_roles" <@ array['owner', 'admin', 'editor', 'developer', 'billing', 'viewer']::text[]);
