-- oxy:deploy-phase=pre
-- Changing and removing the email of an account without a key (ADR 0030):
-- email_verifications takes the purpose 'email_change' (a code to the new
-- address) and the re-verification action 'change_email'. Both checks only
-- WIDEN, so every row the running image writes still passes; safe ahead of
-- the rollout, and the new image's routes need them in place.
ALTER TABLE "email_verifications" DROP CONSTRAINT "email_verifications_purpose_check";--> statement-breakpoint
ALTER TABLE "email_verifications" DROP CONSTRAINT "email_verifications_reauth_action_check";--> statement-breakpoint
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_purpose_check" CHECK ("email_verifications"."purpose" in ('signup', 'signin', 'reauth', 'email_change'));--> statement-breakpoint
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_reauth_action_check" CHECK (("email_verifications"."purpose" = 'reauth') = ("email_verifications"."reauth_action" is not null) and ("email_verifications"."reauth_action" is null or "email_verifications"."reauth_action" in ('change_password', 'change_email', 'totp', 'link_commons', 'delete_account', 'credentials_manage', 'supervision', 'supervision_purchase')));