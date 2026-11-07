-- oxy:deploy-phase=pre
-- The Oxy Keychain (ADR 0063, docs/identity/keychain.md): six new tables, all
-- under keychain_vaults and the vault under users (ON DELETE CASCADE). Additive:
-- the only change to an existing table widens email_verifications'
-- reauth_action CHECK with 'reset_keychain' (a small, swept table; the same
-- shape as 0169 and 0185), which the serving image never writes.
CREATE TABLE "keychain_enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"vault_id" text NOT NULL,
	"device_session_id" text NOT NULL,
	"member" jsonb NOT NULL,
	"commitment" text NOT NULL,
	"approver_nonce" text,
	"approver_member_id" text,
	"device_nonce" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "keychain_enrollments_status_check" CHECK ("keychain_enrollments"."status" in ('pending', 'approved', 'denied')),
	CONSTRAINT "keychain_enrollments_commitment_check" CHECK ("keychain_enrollments"."commitment" ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
	CONSTRAINT "keychain_enrollments_approver_check" CHECK (("keychain_enrollments"."approver_nonce" is null) = ("keychain_enrollments"."approver_member_id" is null) and ("keychain_enrollments"."approver_nonce" is null or "keychain_enrollments"."approver_nonce" ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$') and ("keychain_enrollments"."approver_member_id" is null or "keychain_enrollments"."approver_member_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
	CONSTRAINT "keychain_enrollments_device_nonce_check" CHECK ("keychain_enrollments"."device_nonce" is null or ("keychain_enrollments"."approver_nonce" is not null and "keychain_enrollments"."device_nonce" ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$')),
	CONSTRAINT "keychain_enrollments_member_check" CHECK (jsonb_typeof("keychain_enrollments"."member") = 'object')
);
--> statement-breakpoint
CREATE TABLE "keychain_items" (
	"vault_id" text NOT NULL,
	"item_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"generation" integer NOT NULL,
	"nonce" text,
	"ciphertext" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "keychain_items_vault_id_item_id_pk" PRIMARY KEY("vault_id","item_id"),
	CONSTRAINT "keychain_items_vault_id_revision_key" UNIQUE("vault_id","revision"),
	CONSTRAINT "keychain_items_item_id_check" CHECK ("keychain_items"."item_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "keychain_items_revision_check" CHECK ("keychain_items"."revision" >= 1),
	CONSTRAINT "keychain_items_generation_check" CHECK ("keychain_items"."generation" >= 1),
	CONSTRAINT "keychain_items_tombstone_check" CHECK (("keychain_items"."deleted_at" is null) = ("keychain_items"."ciphertext" is not null) and ("keychain_items"."ciphertext" is null) = ("keychain_items"."nonce" is null)),
	CONSTRAINT "keychain_items_nonce_check" CHECK ("keychain_items"."nonce" is null or "keychain_items"."nonce" ~ '^[A-Za-z0-9_-]{32}$'),
	CONSTRAINT "keychain_items_ciphertext_check" CHECK ("keychain_items"."ciphertext" is null or char_length("keychain_items"."ciphertext") <= 65536)
);
--> statement-breakpoint
CREATE TABLE "keychain_members" (
	"vault_id" text NOT NULL,
	"member_id" text NOT NULL,
	"device_session_id" text,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"signing_key" text NOT NULL,
	"box_key" text NOT NULL,
	"added_seq" integer NOT NULL,
	"removed_seq" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "keychain_members_vault_id_member_id_pk" PRIMARY KEY("vault_id","member_id"),
	CONSTRAINT "keychain_members_member_id_check" CHECK ("keychain_members"."member_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "keychain_members_platform_check" CHECK ("keychain_members"."platform" in ('oxyos', 'ios', 'android', 'macos', 'windows', 'linux', 'web')),
	CONSTRAINT "keychain_members_signing_key_check" CHECK ("keychain_members"."signing_key" ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
	CONSTRAINT "keychain_members_box_key_check" CHECK ("keychain_members"."box_key" ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
	CONSTRAINT "keychain_members_seq_check" CHECK ("keychain_members"."added_seq" >= 0 and ("keychain_members"."removed_seq" is null or "keychain_members"."removed_seq" > "keychain_members"."added_seq"))
);
--> statement-breakpoint
CREATE TABLE "keychain_roster_entries" (
	"vault_id" text NOT NULL,
	"seq" integer NOT NULL,
	"hash" text NOT NULL,
	"op" text NOT NULL,
	"body" text NOT NULL,
	"signatures" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "keychain_roster_entries_vault_id_seq_pk" PRIMARY KEY("vault_id","seq"),
	CONSTRAINT "keychain_roster_entries_seq_check" CHECK ("keychain_roster_entries"."seq" >= 0),
	CONSTRAINT "keychain_roster_entries_hash_check" CHECK ("keychain_roster_entries"."hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "keychain_roster_entries_op_check" CHECK ("keychain_roster_entries"."op" in ('genesis', 'add', 'remove', 'generation', 'recovery')),
	CONSTRAINT "keychain_roster_entries_signatures_check" CHECK (jsonb_typeof("keychain_roster_entries"."signatures") = 'array' and jsonb_array_length("keychain_roster_entries"."signatures") between 1 and 2)
);
--> statement-breakpoint
CREATE TABLE "keychain_vaults" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"genesis_hash" text NOT NULL,
	"roster_seq" integer NOT NULL,
	"roster_head" text NOT NULL,
	"generation" integer NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "keychain_vaults_account_id_key" UNIQUE("account_id"),
	CONSTRAINT "keychain_vaults_id_check" CHECK ("keychain_vaults"."id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "keychain_vaults_genesis_hash_check" CHECK ("keychain_vaults"."genesis_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "keychain_vaults_roster_head_check" CHECK ("keychain_vaults"."roster_head" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "keychain_vaults_roster_seq_check" CHECK ("keychain_vaults"."roster_seq" >= 0),
	CONSTRAINT "keychain_vaults_generation_check" CHECK ("keychain_vaults"."generation" >= 1),
	CONSTRAINT "keychain_vaults_revision_check" CHECK ("keychain_vaults"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "keychain_wraps" (
	"vault_id" text NOT NULL,
	"recipient" text NOT NULL,
	"generation" integer NOT NULL,
	"signer" text NOT NULL,
	"epk" text NOT NULL,
	"nonce" text NOT NULL,
	"ciphertext" text NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "keychain_wraps_vault_id_recipient_pk" PRIMARY KEY("vault_id","recipient"),
	CONSTRAINT "keychain_wraps_recipient_check" CHECK ("keychain_wraps"."recipient" = 'recovery' or "keychain_wraps"."recipient" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "keychain_wraps_signer_check" CHECK ("keychain_wraps"."signer" = 'recovery' or "keychain_wraps"."signer" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "keychain_wraps_generation_check" CHECK ("keychain_wraps"."generation" >= 1),
	CONSTRAINT "keychain_wraps_epk_check" CHECK ("keychain_wraps"."epk" ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
	CONSTRAINT "keychain_wraps_nonce_check" CHECK ("keychain_wraps"."nonce" ~ '^[A-Za-z0-9_-]{32}$'),
	CONSTRAINT "keychain_wraps_signature_check" CHECK ("keychain_wraps"."signature" ~ '^[A-Za-z0-9_-]{85}[AQgw]$')
);
--> statement-breakpoint
ALTER TABLE "email_verifications" DROP CONSTRAINT "email_verifications_reauth_action_check";--> statement-breakpoint
ALTER TABLE "keychain_enrollments" ADD CONSTRAINT "keychain_enrollments_vault_id_keychain_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."keychain_vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keychain_enrollments" ADD CONSTRAINT "keychain_enrollments_device_session_id_device_sessions_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "public"."device_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keychain_items" ADD CONSTRAINT "keychain_items_vault_id_keychain_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."keychain_vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keychain_members" ADD CONSTRAINT "keychain_members_vault_id_keychain_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."keychain_vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keychain_members" ADD CONSTRAINT "keychain_members_device_session_id_device_sessions_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "public"."device_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keychain_roster_entries" ADD CONSTRAINT "keychain_roster_entries_vault_id_keychain_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."keychain_vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keychain_vaults" ADD CONSTRAINT "keychain_vaults_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keychain_wraps" ADD CONSTRAINT "keychain_wraps_vault_id_keychain_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."keychain_vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "keychain_enrollments_vault_id_status_idx" ON "keychain_enrollments" USING btree ("vault_id","status");--> statement-breakpoint
CREATE INDEX "keychain_enrollments_device_session_id_idx" ON "keychain_enrollments" USING btree ("device_session_id");--> statement-breakpoint
CREATE INDEX "keychain_enrollments_expires_at_idx" ON "keychain_enrollments" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "keychain_members_live_device_session_key" ON "keychain_members" USING btree ("vault_id","device_session_id") WHERE "keychain_members"."removed_seq" is null and "keychain_members"."device_session_id" is not null;--> statement-breakpoint
CREATE INDEX "keychain_members_device_session_id_idx" ON "keychain_members" USING btree ("device_session_id");--> statement-breakpoint
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_reauth_action_check" CHECK (("email_verifications"."purpose" = 'reauth') = ("email_verifications"."reauth_action" is not null) and ("email_verifications"."reauth_action" is null or "email_verifications"."reauth_action" in ('change_password', 'change_email', 'totp', 'link_commons', 'delete_account', 'credentials_manage', 'supervision', 'supervision_purchase', 'reset_keychain')));