-- oxy:deploy-phase=pre
--
-- ADR 0043 D6: a reference reconciliation's commit runs under a lease. Three
-- nullable columns on file_reference_reconciliations — the running commit's
-- lease (renewed after every batch), whether it is a dry run, and why the last
-- commit failed — and the worker's partial index over committing sessions.
-- Additive: every existing row reads NULL, which no running code inspects.
ALTER TABLE "file_reference_reconciliations" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "file_reference_reconciliations" ADD COLUMN "commit_dry_run" boolean;--> statement-breakpoint
ALTER TABLE "file_reference_reconciliations" ADD COLUMN "commit_error" text;--> statement-breakpoint
CREATE INDEX "file_reference_reconciliations_committing_lease_idx" ON "file_reference_reconciliations" USING btree ("lease_expires_at") WHERE "file_reference_reconciliations"."status" = 'committing';