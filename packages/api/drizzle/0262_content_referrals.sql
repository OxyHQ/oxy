-- oxy:deploy-phase=pre
-- ADR 0043 D14: an Oxy service refers content to the claim review. A referral is
-- a claim with a reason and no claimant, so `relationship` becomes nullable and
-- three vocabularies gain one word each. Additive: every existing row keeps its
-- relationship and has no referral, which is what the new CHECK asks of it.
-- The foreign key onto `applications` is NOT VALID here and validated in 0263.
ALTER TABLE "content_claim_events" DROP CONSTRAINT "content_claim_events_action_check";--> statement-breakpoint
ALTER TABLE "content_claim_notifications" DROP CONSTRAINT "content_claim_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "content_claim_targets" DROP CONSTRAINT "content_claim_targets_source_check";--> statement-breakpoint
ALTER TABLE "content_claims" ALTER COLUMN "relationship" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "content_claims" ADD COLUMN "referral_reason" text;--> statement-breakpoint
ALTER TABLE "content_claims" ADD COLUMN "referred_by_application_id" text;--> statement-breakpoint
ALTER TABLE "content_claims" ADD COLUMN "referral_key" text;--> statement-breakpoint
ALTER TABLE "content_claims" ADD CONSTRAINT "content_claims_referred_by_application_id_applications_id_fk" FOREIGN KEY ("referred_by_application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE UNIQUE INDEX "content_claims_open_referral_key" ON "content_claims" USING btree ("referral_key") WHERE "content_claims"."referral_key" is not null and "content_claims"."state" in ('received', 'reviewing', 'actioned', 'counter_noticed');--> statement-breakpoint
CREATE INDEX "content_claims_referred_by_application_id_idx" ON "content_claims" USING btree ("referred_by_application_id") WHERE "content_claims"."referred_by_application_id" is not null;--> statement-breakpoint
ALTER TABLE "content_claim_events" ADD CONSTRAINT "content_claim_events_action_check" CHECK ("content_claim_events"."action" in ('submitted', 'referred', 'review_started', 'targets_attached', 'targets_blocked', 'rejected', 'counter_notice_recorded', 'counter_notice_submitted', 'reinstated', 'upheld', 'note_added'));--> statement-breakpoint
ALTER TABLE "content_claim_notifications" ADD CONSTRAINT "content_claim_notifications_kind_check" CHECK ("content_claim_notifications"."kind" in ('claim_received', 'claim_actioned', 'claim_rejected', 'claim_counter_noticed', 'claim_reinstated', 'claim_upheld', 'content_blocked', 'content_reinstated', 'content_upheld', 'claim_counter_notice_copy', 'counter_notice_received', 'counter_notice_staff', 'referral_staff'));--> statement-breakpoint
ALTER TABLE "content_claim_targets" ADD CONSTRAINT "content_claim_targets_source_check" CHECK ("content_claim_targets"."source" in ('claimant', 'staff', 'service'));--> statement-breakpoint
ALTER TABLE "content_claims" ADD CONSTRAINT "content_claims_referral_reason_check" CHECK ("content_claims"."referral_reason" in ('child_safety'));--> statement-breakpoint
ALTER TABLE "content_claims" ADD CONSTRAINT "content_claims_referral_check" CHECK (("content_claims"."referral_reason" is null) = ("content_claims"."relationship" is not null) and ("content_claims"."referral_reason" is null) = ("content_claims"."referral_key" is null) and ("content_claims"."referral_reason" is not null or "content_claims"."referred_by_application_id" is null) and ("content_claims"."referral_reason" is null or "content_claims"."kind" = 'illegal_content'));