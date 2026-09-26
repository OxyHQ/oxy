-- oxy:deploy-phase=pre
-- Signing in without a passkey: an email code or link, an optional password
-- and an optional authenticator (TOTP) with one-use backup codes.
-- Five new tables nothing in the running image reads or writes; on
-- email_verifications a WIDER purpose check (adds 'signin' and 'reauth') and
-- a nullable reauth_action column whose check every row the running image
-- writes (signup/recovery, no action) passes. Safe ahead of the rollout;
-- 'post' would leave the new image's sign-in routes addressing tables that
-- do not exist yet.
CREATE TABLE "email_signin_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"verification_id" text NOT NULL,
	"user_id" text,
	"request_secret_hash" text NOT NULL,
	"link_token_hash" text NOT NULL,
	"requester_device_id" text,
	"approved_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "email_signin_requests_verification_id_key" UNIQUE("verification_id"),
	CONSTRAINT "email_signin_requests_link_token_hash_key" UNIQUE("link_token_hash"),
	CONSTRAINT "email_signin_requests_secret_hash_check" CHECK ("email_signin_requests"."request_secret_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "email_signin_requests_link_hash_check" CHECK ("email_signin_requests"."link_token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "email_signin_requests_approved_check" CHECK ("email_signin_requests"."approved_at" is null or "email_signin_requests"."user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "user_passwords" (
	"user_id" text PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "user_passwords_hash_check" CHECK ("user_passwords"."password_hash" like '$scrypt$%')
);
--> statement-breakpoint
CREATE TABLE "user_totp" (
	"user_id" text PRIMARY KEY NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"enabled_at" timestamp with time zone,
	"last_used_step" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "user_totp_secret_check" CHECK ("user_totp"."secret_ciphertext" like 'v1.%')
);
--> statement-breakpoint
CREATE TABLE "user_totp_backup_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "user_totp_backup_codes_user_id_code_hash_key" UNIQUE("user_id","code_hash"),
	CONSTRAINT "user_totp_backup_codes_hash_check" CHECK ("user_totp_backup_codes"."code_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "signin_second_factor_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"challenge_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "signin_second_factor_challenges_hash_key" UNIQUE("challenge_hash"),
	CONSTRAINT "signin_second_factor_challenges_hash_check" CHECK ("signin_second_factor_challenges"."challenge_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "signin_second_factor_challenges_attempts_check" CHECK ("signin_second_factor_challenges"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "email_verifications" DROP CONSTRAINT "email_verifications_purpose_check";--> statement-breakpoint
ALTER TABLE "email_verifications" ADD COLUMN "reauth_action" text;--> statement-breakpoint
ALTER TABLE "email_signin_requests" ADD CONSTRAINT "email_signin_requests_verification_id_email_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."email_verifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_signin_requests" ADD CONSTRAINT "email_signin_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_passwords" ADD CONSTRAINT "user_passwords_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_totp" ADD CONSTRAINT "user_totp_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_totp_backup_codes" ADD CONSTRAINT "user_totp_backup_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signin_second_factor_challenges" ADD CONSTRAINT "signin_second_factor_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_signin_requests_user_id_idx" ON "email_signin_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "email_signin_requests_expires_at_idx" ON "email_signin_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_totp_backup_codes_user_id_idx" ON "user_totp_backup_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "signin_second_factor_challenges_user_id_idx" ON "signin_second_factor_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "signin_second_factor_challenges_expires_at_idx" ON "signin_second_factor_challenges" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_reauth_action_check" CHECK (("email_verifications"."purpose" = 'reauth') = ("email_verifications"."reauth_action" is not null) and ("email_verifications"."reauth_action" is null or "email_verifications"."reauth_action" in ('change_password', 'totp', 'link_commons', 'delete_account')));--> statement-breakpoint
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_purpose_check" CHECK ("email_verifications"."purpose" in ('signup', 'recovery', 'signin', 'reauth'));