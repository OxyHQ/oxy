-- oxy:deploy-phase=pre
-- Inbox threading and self-copies. Both columns are nullable and nothing in
-- the running image reads or writes them, so this is purely additive and safe
-- ahead of the rollout.
--   relay_message_id: the Message-ID the relay (SES) substituted for ours, a
--     thread key, so a recipient's reply joins the conversation it answers.
--   sent_copy_of: an inbound message that is the user's own outbound mail
--     coming back, linked to its Sent row so a conversation shows it once.
-- The partial index serves the thread walk's `relay_message_id = any(keys)` arm.
ALTER TABLE "messages" ADD COLUMN "relay_message_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sent_copy_of" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_copy_of_messages_id_fk" FOREIGN KEY ("sent_copy_of") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_user_id_relay_message_id_idx" ON "messages" USING btree ("user_id","relay_message_id") WHERE "messages"."relay_message_id" is not null;