# Per-owner asset rows

One live `files` row per **owner** per content hash. Rows for the same bytes
share one content-addressed stored object and its renditions. The bytes are
purged only when the last live row that uses them is deleted.

This replaced one live row per hash across the whole table
(`files_sha256_live_key`). That index let the upload paths hand an existing row
to any other account that uploaded the same bytes, along with its id, its links
and its delete authority. Owners ended up holding and linking each other's
files, and one owner's delete removed another owner's media. The security
review of #1441 found this.

## The model

- **Uniqueness.** `files_sha256_owner_user_live_key` covers
  `(sha256, owner_user_id)` and `files_sha256_system_owner_live_key` covers
  `(sha256, system_owner)`. Both are partial indexes on
  `status in ('active', 'trash')`. System namespaces are owners too: the
  federation media cache still keeps one row per hash.
- **Dedup is owner-scoped.** Every upload path first looks up the uploader's
  own live row (`findLiveFileBySha256ForOwner`). If a different owner uploads
  the same bytes, it gets a new row whose `storage_key` is taken from an
  existing live row (`findLiveStorageSourceBySha256`), so the bytes are not
  stored twice. The key is re-spelled with or without `public/` to match the
  new row's visibility, and the verified bytes are written only if that object
  is missing.
- **Federated uploads keep #1441's semantics.** If the same owner re-uploads
  the same bytes from the same app, it gets its existing row back with
  `deduplicated: true`. If the same owner already holds those bytes as
  anything else, the upload gets `409 FEDERATED_MEDIA_OWNED_ELSEWHERE`,
  because the per-owner unique leaves no second row to create. A different
  owner now gets its own row (`200`, `deduplicated: false`). That case used to
  be a 409.
- **Cache rows are never promoted.** A federated or direct upload whose bytes
  are in the media cache gets its own row that shares the cached object. The
  cache row keeps its namespace and its eviction route.
- **Presigned PUTs never target a shared key.** `initUpload` returns no upload
  URL when an object for the bytes already exists. If another owner's row holds
  the hash but its object is missing, the caller gets a key of its own
  (`…/<sha>-<random>.<ext>`). A repair URL for the caller's own row is refused
  if any other live row stores its original at that key.
  `POST /assets/:id/upload-direct` requires the row's owner and bytes that hash
  to the row's `sha256`. `POST /assets/complete` requires the row's owner.
- **Purges are decided per key spelling.** The storage-deletion worker
  (`storageSpellingsInUse`) checks the bare key and its `public/` copy
  separately. A private row that keeps the bare key does not keep a deleted
  owner's public CDN copy alive. Every delete goes through
  `S3Service.deleteFile`, which queues the CloudFront invalidation.
- **Visibility changes copy.** A visibility change copies the object and its
  renditions to the other spelling and repoints the row, under the
  content-hash lock. The spelling it left is recorded in
  `storage_object_deletions` with reason `file.relocated`, and the worker
  deletes it only if no live row still uses it. The old code moved the object,
  which would have pulled it out from under another owner.
- **Renditions are shared.** `generateVariants` copies the rendition set of a
  live twin that already uses the right spelling (`findVariantTwin`), so
  nothing is encoded twice. A finished generation is also handed to twins that
  do not have renditions yet (`shareVariantsWithTwins`). Only intrinsic
  metadata (`media`, `image`, `video`) is copied between rows, because
  application metadata (`source`, `serviceAppId`) is what the federated delete
  route authorizes by. Two owners' first uploads that race can still both
  encode. They write identical outputs to the same keys, so the cost is CPU,
  not correctness.
- **The content-hash lock guards every path that makes a live row use a key**:
  inserting a new row (including choosing which key to share), the
  copy-and-repoint of a relocation, and the split script. The purge re-checks
  under the same lock.
- **`in_use` stays as defence in depth.** The federated delete still refuses a
  file that another account links, attaches to mail or uses as a listing
  screenshot. New uploads no longer produce those references, but
  `POST /assets/:id/links` accepts any id, and rows created before this change
  keep their foreign links until they are split (see below).

## `POST /assets/service/by-sha256`

The new optional `ownerUserId` field resolves each hash to that account's own
row, or to nothing. Without it, the legacy form still resolves each hash to the
oldest live row of any owner, so existing callers see no change. That answer is
fine for "is this content stored" and for the public `url`. The id, however,
belongs to whoever uploaded first. `@oxy.so/core`'s
`assets.metadataBySha256(shas, { ownerUserId })` sends the field. It is
**unreleased**.

## Callers across `~/Oxy`

The census excluded `node_modules`, `dist` and worktrees.

| Caller | Endpoint | Effect |
|---|---|---|
| Mention `services/mtn/PostMaterializer.ts:227` | by-sha256 | Unchanged: it still gets the oldest row. It maps `sha256 -> id` into post media, so it should pass the record author's `ownerUserId` once core is released. |
| Mention `services/mtn/mtnNodeBlobMirror.ts:121` | by-sha256 | Unchanged. It treats "any owner has it" as "already mirrored". With `ownerUserId` it would upload the author's own row instead, and the bytes would still be stored once. |
| Mention `mediaCache/cacheWorker.ts:376`, `mediaCache/oxyMediaStore.ts:403`, `connectors/*` | `/service/federation` | A different owner's bytes now return `200` with a new row instead of a `409`. The cache worker currently retries a 409 indefinitely, so this fixes that loop. |
| Mention `cacheWorker.ts:216`, `gifLibraryService.ts:472`, eviction and purge scripts | `/service/cache`, `DELETE /service/cache/:id` | Unchanged. The cache namespace still keeps one row per hash, so two cache entries with the same bytes share an id. |
| Mention `utils/oxyHelpers.ts:195`, Move `utils/oxyHelpers.ts:64` | `/service/user-media` | Another user's bytes now give the caller its own row instead of a `409`. |
| Mercaria `services/digital/storage.ts:355`, Mention `routes/intentMedia.ts:223`, `useCaptureUpload.ts:53`, Syra `StreamConfigModal.tsx:101`, the services SDK (avatar, banner, file manager) | `/assets/upload` | These now always get the caller's own row. Mercaria's assumption that it owns the returned id is now true. |
| none found | `/assets/init`, `/assets/complete`, `/assets/:id/upload-direct` | No callers in any repository. |

## Migration `0121_files_per_owner_live_key` (`pre`)

The migration builds the two new uniques with `IF NOT EXISTS`, refuses an
invalid index left by a failed concurrent build, drops the global unique with
`IF EXISTS`, and widens the `storage_object_deletions` reason CHECK. All of it
is correct against both images:

- The new uniques are implied by the old one.
- Without the global unique, the old image can only create a second row for a
  hash when two different owners race the same bytes. That is the new model,
  and the old image's purge already handles it.
- The CHECK only widens.

The migration must run before the new image serves, because the global unique
would refuse the new image's second-owner inserts.

### Measured lock profile

Measured locally on PostgreSQL 17 under WSL2. A throwaway database held
1.1M `files` rows: 1.0M owned by accounts, 100k in the cache namespace, and
1.28 GB of heap plus indexes. Throughout each run, a writer inserted into
`files` and a reader selected by `sha256`, each every 20 ms, while
`pg_locks` on `files` was sampled.

| Route | Duration | Writer max | Reader max | Locks on `files` |
|---|---|---|---|---|
| Migration as written, one transaction (the real migrator, `--phase=pre`) | builds: 854 ms (owner) + 150 ms (system), then ~1 ms drop | **~1000 ms**: every insert queued for the whole build | 10 ms | `ShareLock` held, `RowExclusiveLock` waiting. `AccessExclusiveLock` briefly at the drop, held to commit. |
| Out of band: `CREATE UNIQUE INDEX CONCURRENTLY` ×2, then `DROP INDEX CONCURRENTLY` | 1113 + 313 + 13 ms | 14 ms | 10 ms | `ShareUpdateExclusiveLock` only |
| Migration after the out-of-band route | 89 ms in total | 13 ms | 10 ms | one momentary `ShareLock` (the `IF NOT EXISTS` lookup) |

As written, the migration blocks every upload, delete and visibility write for
about 1 s per million rows on this machine. Reads are not blocked except behind
the final `DROP INDEX`, which queues them behind any long-running query on
`files`. RDS timing will differ. Check `select count(*) from files` first.

## Rollout order

1. **Before merging**, if `files` is large or a write pause is not acceptable,
   run these against production from a one-shot task, outside any transaction:

   ```sql
   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS files_sha256_owner_user_live_key ON files USING btree (sha256, owner_user_id) WHERE status in ('active', 'trash') and owner_user_id is not null;
   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS files_sha256_system_owner_live_key ON files USING btree (sha256, system_owner) WHERE status in ('active', 'trash') and system_owner is not null;
   SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname LIKE 'files_sha256_%live_key';  -- both t
   DROP INDEX CONCURRENTLY IF EXISTS files_sha256_live_key;
   ```

   The order matters. The new uniques must be valid before the old one goes.
   If a build fails, `DROP INDEX CONCURRENTLY` the invalid index and build it
   again. The migration refuses to proceed while an invalid index is present.
2. **Merge.** `Deploy to AWS` applies 0121 in its `pre` phase, then rolls out
   the new image. After step 1, the migration only swaps the small
   `storage_object_deletions` CHECK.
3. **Report the existing shares** with a dry run from a one-shot task:
   `bun run packages/api/scripts/split-cross-owner-file-links.ts`. It prints
   one JSON line per (file, linking account) pair, followed by a summary that
   includes cross-owner mail attachments.
4. **Create the rows** with `--apply=create-rows`. This is additive: each
   linking account gets its own row that shares storage and renditions, and no
   existing reference changes. It is idempotent and batched (`--batch-size`,
   `--max-batches`, and `--after=<lastLinkId>` to resume). Keep the JSONL
   output: it is the `(sourceFileId, ownerUserId) -> fileId` mapping the
   consuming apps need.
5. **Consumers switch their stored ids** using that mapping, and Mention passes
   `ownerUserId` to by-sha256. Both need a release of `@oxy.so/core`, which this
   change does not publish.
6. **Repoint links per application** with
   `--apply=repoint-links --app=<name>`, and only for an app that now stores the
   new ids. Until then, the foreign link on the original is what keeps
   `in_use` protecting that app's reference.

**Rollback.** The previous image runs correctly against the new indexes, but its
global dedup lookup would start handing out another owner's row again. The
global unique cannot be restored once two owners hold live rows for one hash.
Treat 0121 as forward-only.

## Known gaps, not addressed here

- The presigned flow (`init` → PUT → `complete`) never verifies that the bytes
  PUT match the declared `sha256`. Such a row's object can hold other content,
  and a later second owner's row would share it. This predates the change. The
  fix is `ChecksumSHA256` on the presigned PUT, or a hash check at `complete`.
- `POST /assets/:id/links` and `DELETE /assets/:id/links` accept any
  authenticated caller and any file id. Linking also re-derives the file's
  visibility, so any account can make anyone's file private or public by
  linking it. This predates the change and was left alone because an owner
  check changes behaviour for consumers.
- A visibility relocation copies originals and recorded renditions, not HLS
  segments. Playlists relocated to the other spelling name segments that were
  never copied. This predates the change.
- The cache namespace stays at one row per hash, so Mention cache entries with
  identical bytes share one id. Evicting one entry deletes the row that another
  entry uses.
