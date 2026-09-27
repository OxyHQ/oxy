-- oxy:deploy-phase=pre
-- Per-asset deletes (DELETE /assets/:id, the federated media delete, cache
-- eviction) now record the storage they owe in storage_object_deletions with
-- reason 'file.deleted', in the tombstone's own transaction, so the worker
-- retries a failed purge and guards it against a concurrent re-upload.
-- Pre-rollout: the check only WIDENS; the running image writes only
-- 'account.deleted', which the new check still admits, and the new image
-- writes 'file.deleted' from its first request.
ALTER TABLE "storage_object_deletions" DROP CONSTRAINT "storage_object_deletions_reason_check";--> statement-breakpoint
ALTER TABLE "storage_object_deletions" ADD CONSTRAINT "storage_object_deletions_reason_check" CHECK ("storage_object_deletions"."reason" in ('account.deleted', 'file.deleted'));
