-- oxy:deploy-phase=pre
--
-- ADR 0041 stage 4b: the owner's own counter-notice (D10; 17 U.S.C. § 512(g)).
--
--  * content_claim_counter_notices — new: an owner's counter-notice, its
--    identity, contact details and statement SEALED, erased three years after
--    the claim closes (the claimant's clock), one per (claim, account).
--  * content_claim_events.action admits `counter_notice_submitted`.
--  * content_claim_notifications: `recipient` admits `staff` (legal@oxy.so);
--    `kind` admits `claim_counter_notice_copy`, `counter_notice_received` and
--    `counter_notice_staff`; `counter_notice_id` names the notice those three
--    are about (CHECK: set for exactly them).
--
-- PRE. Every statement is correct against BOTH images: the table and the
-- column are new and the image still serving never touches them, and the
-- three CHECKs only widen (the new one holds for every existing row, whose
-- `counter_notice_id` is NULL and whose kind is none of the three). The two
-- tables they constrain were created by 0171, in the same release, and hold
-- few rows, so the CHECKs are validated in place.
CREATE TABLE "content_claim_counter_notices" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"submitted_by_user_id" text,
	"file_ids" text[] NOT NULL,
	"statement_version" text NOT NULL,
	"name_ciphertext" text NOT NULL,
	"address_ciphertext" text NOT NULL,
	"phone_ciphertext" text NOT NULL,
	"email_ciphertext" text NOT NULL,
	"material_description_ciphertext" text NOT NULL,
	"material_location_ciphertext" text NOT NULL,
	"explanation_ciphertext" text NOT NULL,
	"signature_ciphertext" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "content_claim_counter_notices_file_ids_check" CHECK (cardinality("content_claim_counter_notices"."file_ids") between 1 and 50)
);
--> statement-breakpoint
ALTER TABLE "content_claim_events" DROP CONSTRAINT "content_claim_events_action_check";--> statement-breakpoint
ALTER TABLE "content_claim_notifications" DROP CONSTRAINT "content_claim_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "content_claim_notifications" DROP CONSTRAINT "content_claim_notifications_recipient_check";--> statement-breakpoint
ALTER TABLE "content_claim_notifications" ADD COLUMN "counter_notice_id" text;--> statement-breakpoint
ALTER TABLE "content_claim_counter_notices" ADD CONSTRAINT "content_claim_counter_notices_claim_id_content_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."content_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_claim_counter_notices" ADD CONSTRAINT "content_claim_counter_notices_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_claim_counter_notices_claim_id_idx" ON "content_claim_counter_notices" USING btree ("claim_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "content_claim_counter_notices_claim_id_submitted_by_key" ON "content_claim_counter_notices" USING btree ("claim_id","submitted_by_user_id") WHERE "content_claim_counter_notices"."submitted_by_user_id" is not null;--> statement-breakpoint
CREATE INDEX "content_claim_counter_notices_submitted_by_user_id_idx" ON "content_claim_counter_notices" USING btree ("submitted_by_user_id") WHERE "content_claim_counter_notices"."submitted_by_user_id" is not null;--> statement-breakpoint
CREATE INDEX "content_claim_counter_notices_expires_at_idx" ON "content_claim_counter_notices" USING btree ("expires_at") WHERE "content_claim_counter_notices"."expires_at" is not null;--> statement-breakpoint
ALTER TABLE "content_claim_notifications" ADD CONSTRAINT "content_claim_notifications_counter_notice_id_content_claim_counter_notices_id_fk" FOREIGN KEY ("counter_notice_id") REFERENCES "public"."content_claim_counter_notices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_claim_notifications_counter_notice_id_idx" ON "content_claim_notifications" USING btree ("counter_notice_id") WHERE "content_claim_notifications"."counter_notice_id" is not null;--> statement-breakpoint
ALTER TABLE "content_claim_events" ADD CONSTRAINT "content_claim_events_action_check" CHECK ("content_claim_events"."action" in ('submitted', 'review_started', 'targets_attached', 'targets_blocked', 'rejected', 'counter_notice_recorded', 'counter_notice_submitted', 'reinstated', 'upheld', 'note_added'));--> statement-breakpoint
ALTER TABLE "content_claim_notifications" ADD CONSTRAINT "content_claim_notifications_counter_notice_check" CHECK (("content_claim_notifications"."kind" in ('claim_counter_notice_copy', 'counter_notice_received', 'counter_notice_staff')) = ("content_claim_notifications"."counter_notice_id" is not null));--> statement-breakpoint
ALTER TABLE "content_claim_notifications" ADD CONSTRAINT "content_claim_notifications_kind_check" CHECK ("content_claim_notifications"."kind" in ('claim_received', 'claim_actioned', 'claim_rejected', 'claim_counter_noticed', 'claim_reinstated', 'claim_upheld', 'content_blocked', 'content_reinstated', 'content_upheld', 'claim_counter_notice_copy', 'counter_notice_received', 'counter_notice_staff'));--> statement-breakpoint
ALTER TABLE "content_claim_notifications" ADD CONSTRAINT "content_claim_notifications_recipient_check" CHECK ("content_claim_notifications"."recipient" in ('claimant', 'account', 'staff'));