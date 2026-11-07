-- oxy:deploy-phase=pre
-- ADR 0063 D4: a keychain member is bound to the account's presence on the
-- device (device_account_contexts), not only to the device session, so an
-- account that signs out of a device other accounts still use orphans its
-- member. Additive: two nullable columns, their foreign keys and indexes. The
-- previous image never reads them; rows it writes have no context and read as
-- orphaned to the new one (no vault is live yet). The old unique index on the
-- device session is dropped after the rollout (0244, post).
ALTER TABLE "keychain_enrollments" ADD COLUMN "device_context_id" text;--> statement-breakpoint
ALTER TABLE "keychain_members" ADD COLUMN "device_context_id" text;--> statement-breakpoint
ALTER TABLE "keychain_enrollments" ADD CONSTRAINT "keychain_enrollments_device_context_id_device_account_contexts_id_fk" FOREIGN KEY ("device_context_id") REFERENCES "public"."device_account_contexts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keychain_members" ADD CONSTRAINT "keychain_members_device_context_id_device_account_contexts_id_fk" FOREIGN KEY ("device_context_id") REFERENCES "public"."device_account_contexts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "keychain_enrollments_device_context_id_idx" ON "keychain_enrollments" USING btree ("device_context_id");--> statement-breakpoint
CREATE UNIQUE INDEX "keychain_members_live_device_context_key" ON "keychain_members" USING btree ("vault_id","device_context_id") WHERE "keychain_members"."removed_seq" is null and "keychain_members"."device_context_id" is not null;--> statement-breakpoint
CREATE INDEX "keychain_members_device_context_id_idx" ON "keychain_members" USING btree ("device_context_id");