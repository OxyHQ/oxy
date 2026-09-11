-- oxy:deploy-phase=pre
ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_status_check";--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_status_check" CHECK ("application_credentials"."status" in ('pending', 'active', 'deprecated', 'revoked'));
