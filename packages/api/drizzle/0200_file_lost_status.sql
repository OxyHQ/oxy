-- oxy:deploy-phase=pre
--
-- ADR 0043 D13: a file whose bytes are gone for good is `lost`, not an
-- `active` row that 404s.
--
--  * files.status admits `lost`. It is NOT a live status: the per-owner live
--    uniques and every partial index keep their predicates.
--  * file_event_deliveries.type admits `file.lost`, the event the using
--    applications receive.
--
-- PRE. Both CHECKs only widen, and no row is `lost` until this image marks
-- one; the image still serving serves nothing but `active`, so a lost row is
-- refused by both.
--
-- ## LOCKS
--
-- Both CHECKs are re-added NOT VALID, as 0170 and 0174 did: enforced on every
-- write from here on, without the full-table scan a validating ADD runs under
-- ACCESS EXCLUSIVE on `files`. Every existing row passed the narrower CHECK,
-- so it passes this one; `VALIDATE CONSTRAINT` can be run later, out of band.
ALTER TABLE "file_event_deliveries" DROP CONSTRAINT "file_event_deliveries_type_check";--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_status_check";--> statement-breakpoint
ALTER TABLE "file_event_deliveries" ADD CONSTRAINT "file_event_deliveries_type_check" CHECK ("file_event_deliveries"."type" in ('file.deleted', 'file.visibility_changed', 'file.trashed', 'file.restored', 'file.blocked', 'file.unblocked', 'file.lost')) NOT VALID;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_status_check" CHECK ("files"."status" in ('active', 'trash', 'blocked', 'lost', 'deleted')) NOT VALID;
