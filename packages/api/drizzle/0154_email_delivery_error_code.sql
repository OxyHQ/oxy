-- oxy:deploy-phase=pre
-- Additive: a nullable column, a partial index on a small table, and a CHECK
-- every existing row satisfies (they are all NULL). A Sent message reads its
-- delivery from email_outbox through message_row_id.
ALTER TABLE "email_outbox" ADD COLUMN "error_code" text;--> statement-breakpoint
CREATE INDEX "email_outbox_message_row_idx" ON "email_outbox" USING btree ("message_row_id") WHERE "email_outbox"."message_row_id" is not null;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_error_code_check" CHECK ("email_outbox"."error_code" is null or "email_outbox"."error_code" in ('relay_unavailable', 'relay_unconfigured', 'relay_auth', 'rejected', 'retries_exhausted', 'bounced', 'cancelled'));