-- oxy:deploy-phase=post
-- Clean cut: an owned organization's directory profile is INSERTed by
-- `createChildAccount` (as `claimed`, with its type) in the transaction that
-- creates the account, so the 0160 compatibility trigger that conjured it from
-- the owner membership goes. Post-rollout: the previous image still relies on it.
DROP TRIGGER "organization_owner_profile" ON "account_members";--> statement-breakpoint
DROP FUNCTION "ensure_owned_organization_profile"();
