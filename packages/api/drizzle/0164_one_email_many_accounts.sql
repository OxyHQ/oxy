-- oxy:deploy-phase=pre
-- Loosening and additive, safe against the image still serving:
--
-- - `users_lower_email_key` becomes the plain `users_lower_email_idx` on the
--   same expression: one address may hold several accounts. The previous image
--   still refuses a second sign-up for an address in code (it mails a notice
--   instead of a code), so it never relied on the index to stay correct.
-- - `email_signin_requests` gains `mailbox` (DEFAULT false, which is exactly
--   what every row the previous image writes means) and `proven_at` (NULL),
--   and its CHECKs widen to admit a mailbox request; every row already stored
--   has `mailbox = false` and satisfies them.
--
-- `users` holds ~136k rows (production, 2026-10-15), almost all federated and
-- only 14 with an email: the plain CREATE INDEX is one short scan.
ALTER TABLE "email_signin_requests" DROP CONSTRAINT "email_signin_requests_approved_check";--> statement-breakpoint
DROP INDEX "users_lower_email_key";--> statement-breakpoint
ALTER TABLE "email_signin_requests" ADD COLUMN "mailbox" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "email_signin_requests" ADD COLUMN "proven_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "users_lower_email_idx" ON "users" USING btree (lower(btrim("email")));--> statement-breakpoint
ALTER TABLE "email_signin_requests" ADD CONSTRAINT "email_signin_requests_mailbox_check" CHECK (not ("email_signin_requests"."mailbox" and "email_signin_requests"."user_id" is not null));--> statement-breakpoint
ALTER TABLE "email_signin_requests" ADD CONSTRAINT "email_signin_requests_proven_check" CHECK ("email_signin_requests"."proven_at" is null or "email_signin_requests"."mailbox");--> statement-breakpoint
ALTER TABLE "email_signin_requests" ADD CONSTRAINT "email_signin_requests_approved_check" CHECK ("email_signin_requests"."approved_at" is null or "email_signin_requests"."user_id" is not null or "email_signin_requests"."mailbox");