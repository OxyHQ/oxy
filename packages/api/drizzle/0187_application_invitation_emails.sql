-- oxy:deploy-phase=pre
-- `application_invitation_emails` (new): the invitation emails an application
-- had Oxy send through `POST /apps/invitations/email` — the idempotency claim,
-- the rate-limit ledger and the delivery state of each, in one row. The message
-- itself is rendered at delivery and never stored.
--
-- PRE. Additive against both images: a new table the serving image never
-- touches.
--
-- LOCKS. CREATE TABLE takes no lock on an existing table beyond its two foreign
-- keys' SHARE ROW EXCLUSIVE on `applications` and `users`, for the instant each
-- constraint is added to an empty table. Nothing here scans or rewrites an
-- existing table, and every index is built on the new, empty one.
CREATE TABLE "application_invitation_emails" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"inviter_user_id" text NOT NULL,
	"recipient" text NOT NULL,
	"resource_name" text NOT NULL,
	"accept_url" text NOT NULL,
	"locale" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"error_code" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "application_invitation_emails_locale_check" CHECK ("application_invitation_emails"."locale" in ('en', 'es')),
	CONSTRAINT "application_invitation_emails_status_check" CHECK ("application_invitation_emails"."status" in ('pending', 'processing', 'sent', 'failed')),
	CONSTRAINT "application_invitation_emails_attempts_check" CHECK ("application_invitation_emails"."attempts" >= 0),
	CONSTRAINT "application_invitation_emails_error_code_check" CHECK ("application_invitation_emails"."error_code" is null or "application_invitation_emails"."error_code" in ('relay_unavailable', 'relay_unconfigured', 'relay_auth', 'rejected', 'retries_exhausted', 'bounced', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "application_invitation_emails" ADD CONSTRAINT "application_invitation_emails_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_invitation_emails" ADD CONSTRAINT "application_invitation_emails_inviter_user_id_users_id_fk" FOREIGN KEY ("inviter_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_invitation_emails_application_key" ON "application_invitation_emails" USING btree ("application_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "application_invitation_emails_recipient_idx" ON "application_invitation_emails" USING btree ("application_id","recipient","created_at");--> statement-breakpoint
CREATE INDEX "application_invitation_emails_inviter_idx" ON "application_invitation_emails" USING btree ("inviter_user_id","application_id","created_at");--> statement-breakpoint
CREATE INDEX "application_invitation_emails_application_created_idx" ON "application_invitation_emails" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX "application_invitation_emails_due_idx" ON "application_invitation_emails" USING btree ("next_attempt_at") WHERE "application_invitation_emails"."status" in ('pending', 'processing', 'failed');--> statement-breakpoint
CREATE INDEX "application_invitation_emails_created_at_idx" ON "application_invitation_emails" USING btree ("created_at");