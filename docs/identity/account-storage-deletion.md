# Account deletion: the account's stored uploads

> Related: [Account events](account-events.md) · OxyHQ/Mention#1178 · OxyHQ/Mention#1169

Oxy stores every upload made through the file manager: photos, video, avatars,
and post media for every app (Mention's post media are bare Oxy file ids). This
page covers what happens to those files when their owner deletes the account.

## What happened before

`files.owner_user_id` is `ON DELETE CASCADE`, so `DELETE /users/me` removed the
account's asset rows (`files`, `file_variants`, `file_links`) together with the
only record of where the bytes were. Nothing removed the S3 objects. A deleted
person's originals, renditions and HLS segments stayed in the media bucket, and
a public one stayed reachable on `cloud.oxy.so` at its content-addressed key. On
the archive path (an account kept for financial records) the rows survived as
well.

## What happens now

In the same transaction that deletes or archives the account,
`recordAccountStorageDeletion` (`packages/api/src/services/accountStorageDeletion.service.ts`)
reads the storage keys of every asset the account owns and writes them to
`storage_object_deletions`. If the deletion rolls back, nothing is recorded.
If it commits, the keys have been captured before the cascade drops them.

| Path | Asset rows | Storage |
|---|---|---|
| Hard delete (`retained: false`) | Removed by the `users` cascade | Recorded, then deleted by the worker |
| Archive for retention (`retained: true`) | Removed explicitly in the archive transaction (the cascade never fires) | Recorded, then deleted by the worker |

Uploads are optional data, not financial records. Nothing financial references
an asset, so the archive keeps none of them.

`accountStorageDeletion.worker.ts` then deletes the objects. It runs in every
API task, is on by default, and pauses with `STORAGE_DELETION_WORKER_ENABLED=false`
(rows keep accumulating while it is paused).

- **Targets.** Each recorded target is either the original (`content/…/<sha256>.<ext>`)
  or the asset's variant directory (`variants/<y>/<m>/<pp>/<sha256>/`). The
  directory is deleted as a prefix because it also holds the HLS segments that a
  video's playlists name and no `file_variants` row lists. Both spellings of
  every target are deleted: the base key and its CDN `public/` copy. A public
  asset can carry a legacy backfilled copy.
- **Idempotent and convergent.** S3 answers a delete of a missing key with
  success, so a re-run after a crash, or two tasks racing a lapsed lease,
  deletes nothing twice and fails on nothing. Recording the same account twice
  records each target once (unique on account, kind and target).
- **Retries without a dead letter.** A failure backs off (1 minute, doubling,
  capped at 6 hours) and retries indefinitely, with `attempts` and `last_error`
  on the row. A permanent fault such as a revoked IAM grant converges once it
  is fixed instead of abandoning the bytes. `countPendingStorageDeletions()`
  reports the backlog.
- **Bounded.** 25 rows per batch, and a prefix yields after 20 pages of 1,000
  keys and resumes on the next attempt.

## What is kept, and why

| Kept | Why |
|---|---|
| System-owned assets (`files.system_owner`: the federation avatar cache and the remote-media cache) | Keyed by a remote URL, not by a local account. No account deletion reaches them. |
| An owned asset attached to a message in **another person's** mailbox (`message_attachments`, `no action`) | That message is the other person's data. On a hard delete this reference already refuses the whole deletion (behaviour from before this change). On an archive the asset is kept with the message that uses it. |
| An owned asset used as an **app listing screenshot** (`app_listing_screenshots`, `RESTRICT`) | Belongs to the published listing. Same treatment as above. |
| Bytes a **live asset with the same content** still uses (`outcome = 'retained_shared'`) | Storage is content-addressed and upload dedup is global. Someone who uploads the same bytes after the deletion is given the same key, and those bytes are then their upload, not the deleted account's. The worker checks for a live asset whose original or rendition is the target before deleting. For a variant directory it checks for any live asset with that content. |
| Completed `storage_object_deletions` rows: account id, target keys, outcome | Proof the deletion ran. Swept 30 days after completion (`STORAGE_OBJECT_DELETION_RETENTION_SECONDS`, `db/expiry.ts`). An unfinished row is never swept. |

**Dedup caveat.** Before an account is deleted, upload dedup hands later uploaders
of identical bytes the FIRST uploader's file id. When that first uploader is
deleted, the row cascades and other accounts' references to that id stop
resolving. That was already the case before this change, and deleting the bytes
follows the row. Fixing it means giving each uploader their own asset row over
shared bytes, which is a separate change.

## Timing and copies outside the bucket

- **When.** The worker polls every 30 s (`STORAGE_DELETION_POLL_INTERVAL_MS`), so
  the objects normally go within about a minute of the deletion.
- **In-process caches.** `fileCache` entries are invalidated on the task that
  served the deletion. Other tasks' entries expire within 5 minutes, and by then
  the row no longer exists.
- **The CDN.** Public objects are served by CloudFront with
  `Cache-Control: public, max-age=31536000, immutable`. Deleting the origin object
  does not purge copies already cached at the edge. Oxy issues no CloudFront
  invalidation today: the API has no `cloudfront:CreateInvalidation` grant, and
  the per-file delete path has the same gap. Edge copies expire on CloudFront's
  own eviction. Closing this needs an infra grant and an invalidation step in
  the worker.
- **Bucket versioning.** The media buckets (`oxy-*-media-usw2-*`,
  `oxy-infra/terraform-uswest2/s3-apps.tf`) have no versioning and no lifecycle
  rules, checked live on 2026-09-26 with `get-bucket-versioning` (never enabled).
  A delete is final and leaves no non-current version behind. If versioning is
  ever enabled on these buckets, erasure needs a lifecycle rule that expires
  non-current versions.
- **Backups.** Postgres backups (14 days) contain the deleted rows, including
  storage keys, until they age out. They contain no media bytes.

## Verifying a deletion

For an account id `U`:

```sql
select kind, target, outcome, attempts, completed_at, last_error
from storage_object_deletions where account_id = 'U';
```

Every row should be `completed_at is not null`, with outcome `deleted` or
`retained_shared`. A row with a growing `attempts` and a `last_error` is
retrying. Fix the cause (usually S3 permissions) and the row converges.

Tests: `packages/api/src/services/__tests__/accountStorageDeletion.test.ts` (the
recording, the worker, the guard, retry and lease) and
`packages/api/src/routes/__tests__/usersDeleteAccountStorage.test.ts` (both
`DELETE /users/me` outcomes and a refused deletion), against a real Postgres. No
real account is deleted to test this.
