-- oxy:deploy-phase=pre
-- Delivery state on sent messages. A send is now filed in Sent first and
-- delivered in the background, so the row carries whether it actually left.
-- Every column is nullable and the image still serving neither reads nor writes
-- them, so this is additive and safe ahead of the rollout.
--
-- LOCKING: the CHECKs are added `NOT VALID` (a brief ACCESS EXCLUSIVE, no scan)
-- and then VALIDATEd, which scans under SHARE UPDATE EXCLUSIVE and so never
-- blocks reads or writes. Every existing row has all six columns NULL and
-- satisfies all three trivially; the split only keeps `messages`, the largest
-- Inbox table, readable while they are proven.
ALTER TABLE "messages" ADD COLUMN "delivery_state" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivery_attempts" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivery_error" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivery_error_code" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivery_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivery_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_delivery_state_check" CHECK ("messages"."delivery_state" is null or "messages"."delivery_state" in ('sending', 'retrying', 'sent', 'failed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "messages" VALIDATE CONSTRAINT "messages_delivery_state_check";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_delivery_error_code_check" CHECK ("messages"."delivery_error_code" is null or "messages"."delivery_error_code" in ('relay_unavailable', 'relay_unconfigured', 'relay_auth', 'rejected', 'retries_exhausted')) NOT VALID;--> statement-breakpoint
ALTER TABLE "messages" VALIDATE CONSTRAINT "messages_delivery_error_code_check";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_delivery_whole_check" CHECK (("messages"."delivery_state" is null) = ("messages"."delivery_attempts" is null)
        and ("messages"."delivery_state" is null) = ("messages"."delivery_updated_at" is null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "messages" VALIDATE CONSTRAINT "messages_delivery_whole_check";
