-- oxy:deploy-phase=post
-- Passkeys are removed (ADR 0030): an account signs in with an email code or
-- link, an optional password and an optional authenticator, or with Commons.
-- The WebAuthn tables, the passkey rows of user_auth_methods (and their two
-- columns) and the email 'recovery' purpose go. Post-deploy: the image still
-- serving during the rollout reads and writes all of these; the new one
-- reads none of them and writes no 'recovery' row, so the narrower checks
-- hold for every row it writes.
DROP TABLE "webauthn_challenges" CASCADE;--> statement-breakpoint
DROP TABLE "webauthn_credentials" CASCADE;--> statement-breakpoint
DELETE FROM "user_auth_methods" WHERE "type" <> 'identity';--> statement-breakpoint
ALTER TABLE "user_auth_methods" DROP CONSTRAINT "user_auth_methods_type_check";--> statement-breakpoint
ALTER TABLE "user_auth_methods" DROP CONSTRAINT "user_auth_methods_identifier_check";--> statement-breakpoint
DROP INDEX "user_auth_methods_method_credential_id_key";--> statement-breakpoint
ALTER TABLE "user_auth_methods" DROP COLUMN "method_credential_id";--> statement-breakpoint
ALTER TABLE "user_auth_methods" DROP COLUMN "method_name";--> statement-breakpoint
ALTER TABLE "user_auth_methods" ADD CONSTRAINT "user_auth_methods_type_check" CHECK ("user_auth_methods"."type" in ('identity'));--> statement-breakpoint
ALTER TABLE "user_auth_methods" ADD CONSTRAINT "user_auth_methods_identifier_check" CHECK ("user_auth_methods"."method_public_key" is not null);--> statement-breakpoint
DELETE FROM "email_verifications" WHERE "purpose" = 'recovery';--> statement-breakpoint
ALTER TABLE "email_verifications" DROP CONSTRAINT "email_verifications_purpose_check";--> statement-breakpoint
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_purpose_check" CHECK ("email_verifications"."purpose" in ('signup', 'signin', 'reauth'));
