-- oxy:deploy-phase=pre
ALTER TABLE "storage_byte_reservations" ADD COLUMN "retry_after" timestamp with time zone;