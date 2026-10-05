-- oxy:deploy-phase=pre
CREATE TABLE "storage_byte_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"sha256" text NOT NULL,
	"object_key" text NOT NULL,
	"size" bigint NOT NULL,
	"kind" text NOT NULL,
	"recover_after" timestamp with time zone NOT NULL,
	"cleaned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "storage_byte_reservation_account_key_unique" UNIQUE("account_id","object_key"),
	CONSTRAINT "storage_byte_reservation_size_check" CHECK ("storage_byte_reservations"."size" >= 0),
	CONSTRAINT "storage_byte_reservation_kind_check" CHECK ("storage_byte_reservations"."kind" in ('server', 'presigned'))
);
--> statement-breakpoint
CREATE INDEX "storage_byte_reservation_recovery_idx" ON "storage_byte_reservations" USING btree ("recover_after");