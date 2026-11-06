-- oxy:deploy-phase=pre
ALTER TABLE "user_link_metadata" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_link_metadata" ALTER COLUMN "title" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_link_metadata" ALTER COLUMN "description" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_link_metadata" ADD COLUMN "clarity_document_id" text;