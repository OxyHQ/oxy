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
  Since ADR 0043 an application is the third owner
  (`files.owner_application_id`), with its own partial unique
  `files_owner_application_id_sha256_live_key` on
  `(owner_application_id, sha256)`. Only a `third_party` application's
  files are metered (against its developer account); Oxy's own are not.
  Usage is `file_references` (migration 0171), which names a real
  application and never changes a file's visibility.
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
| oxy `stickers.service.ts` (`uploadStickerFile`) | in-process | The `__stickers__` namespace keeps its own row per hash. A user's file or a cached copy with the same bytes shares the object but never the row, so the catalogue can't point at a file its owner can delete or make private. The `sticker` dedupe scope that used to refuse this is gone. |
| none found | `/assets/init`, `/assets/complete`, `/assets/:id/upload-direct` | No callers in any repository. |

## Migration `0124_files_per_owner_live_key` (`pre`)

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
2. **Merge.** `Deploy to AWS` applies 0124 in its `pre` phase, then rolls out
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
Treat 0124 as forward-only.

## Known gaps, not addressed here

- The presigned flow (`init` → PUT → `complete`) never verifies that the bytes
  PUT match the declared `sha256`. Such a row's object can hold other content,
  and a later second owner's row would share it. This predates the change. The
  fix is `ChecksumSHA256` on the presigned PUT, or a hash check at `complete`.
- `POST /assets/:id/links` now requires the file's owner (the session's
  subject or its operator). `DELETE /assets/:id/links` still accepts any
  authenticated caller: GoWay's business-claim withdrawal removes a
  contributor's link with the business's session, so an owner check there
  needs a decision about that flow first.
- A visibility relocation copies originals and recorded renditions, not HLS
  segments. Playlists relocated to the other spelling name segments that were
  never copied. This predates the change.
- The cache namespace stays at one row per hash, so Mention cache entries with
  identical bytes share one id. Evicting one entry deletes the row that another
  entry uses.

## Video rendition repair

Video encoding preserves the displayed aspect ratio (including rotation and
non-square input pixels), with even square-pixel output, no generated padding,
and no enlargement beyond the displayed source dimensions. MP4 and HLS share
one tier calculation; HLS has aligned two-second segments. MP4 stores its index
at the beginning of the file. The HLS master advertises the encoded dimensions
and measured segment bandwidth.

A background generation acquires its original once through the configured R2
S3-compatible GET (including Sippy hydration), then probes and decodes that
seekable local file through an inherited descriptor. The input protocol allows
only that descriptor, so uploaded containers cannot open nested local paths or
network URLs. On-demand poster reads retain their bounded remote range path.
The download has a 15-minute overall deadline, the existing 8 GiB upload ceiling,
and one restart for an interrupted body; SDK retries own HTTP/status failures.
Temporary originals are removed on success or failure. A live disk check before
GET and at 1 MiB body intervals preserves 2 GiB of shared host headroom. This is
an acquisition guard, not an isolated disk quota or a reservation for encoder
outputs; low space remains an operational error under the normal queue policy.

File uploads use the existing bounded multipart upload manager (5 MiB parts,
four in flight). Each request can replay buffered bytes on transient storage
errors; terminal failures abort incomplete multipart uploads. Caller cancellation
rejects immediately; SDK multipart cleanup follows after outstanding parts settle.
Storage connections have a 10-second connection limit and 120-second socket
inactivity limit, so a silent part cannot defer that cleanup indefinitely. Queue attempts and
backoff remain unchanged. Probes and poster output are bounded, and failures
retain process status plus safe local-source diagnostics without signed URLs.

Each tier is encoded once into a local faststart MP4 with closed GOPs and
keyframes at two-second boundaries. HLS remuxes that same H.264/AAC stream
without another decode or encode; the retained MP4 is removed after remuxing,
and the generation's temporary directory is removed on success or failure.
Lazy MP4 creation uses the same encoder without building HLS. This optimization
preserves the `video-v2` playback contract: existing valid generations remain
current and are not regenerated merely because the encoder does less work.

A complete video set uses a `video-v2/<generation>` directory. Segments upload
before rendition playlists; the master uploads last. Only after the whole set
succeeds does one transaction replace the video rows and intrinsic metadata.
Old playable objects and the original remain untouched. A finished master’s
`metadata.encodingProfile` is the completion marker; legacy twin sets cannot
satisfy it. The same completed set is shared only with live twins of the same
visibility spelling, and each public file resolver is purged.

Service metadata does not advertise a legacy HLS ladder whose ready tiers
have a different aspect ratio from the persisted original (allowing even-pixel
rounding), when the original is known MP4/M4V with H.264 and AAC audio.
Instead, `hlsRejectedReadyAt` names that exact master generation; `hlsReadyAt`
is absent. This is an authoritative playback selection fact, not deletion:
objects and HLS resolver semantics remain intact. Current `video-v2` sets,
compatible legacy geometry, and unknown original codecs or dimensions retain
their existing readiness behavior. Original dimensions must come from source
metadata, never from a rendition fallback.

A consumer clears an observed stored readiness stamp no newer than the rejected
current generation, using file/row identity and equality with the observed
stamp to guard the write, then invalidates its hydrated post caches. An older
revision URL resolves the current generation, not historical bytes: retaining
an older stamp would still select the rejected ladder.
Missing responses and absent rejection fields never authorize clearing. A
newer repaired generation must survive a delayed rejection response. Use the
normal original URL directly (which supports byte ranges); do not redirect an
HLS URL to MP4 bytes. The original may be larger or lack a faststart index, so
this restores correct framing while background repair supplies efficient HLS.

The file’s intrinsic `metadata.video.storageRoots` retains validated SHA roots
from previous generations and twins. Subsequent generations reuse a known root
instead of changing it with the calendar. File/account/application deletion and
visibility relocation record those roots in the existing storage deletion
ledger, whose content lock and per-spelling ownership checks protect live
public/private twins. Old generation playlists, MP4s and unlisted HLS segments
therefore follow the same visibility/deletion lifecycle as the current set.

Run **Repair video renditions** (`run-video-rendition-repair.yml`) on protected
`main` after deploying the encoder. It builds a dedicated one-shot image, uses
the live ECS network/roles, and does not replace the API service. Default is a
dry run, capped at 100 content/visibility groups (maximum 1,000). Start with
`file_id=01a16684-e7ee-7213-8bca-051c9cabce02` and `limit=1`; inspect its original,
new MP4/HLS dimensions, manifests and browser playback before a broader pass.
Set `dry_run=false` only for the intended pass.

The underlying command inside the API image is:

```bash
DRY_RUN=true LIMIT=1 FILE_ID=01a16684-e7ee-7213-8bca-051c9cabce02 bun run packages/api/src/scripts/repair-video-renditions.ts
```

Each completed/skipped/failed group logs its `cursor`; the final result contains
`nextCursor`. Pass it as workflow `after` (or environment `AFTER`) to continue
past failures without starving later groups. Keep failed file IDs for explicit
retries without a cursor. Re-running from the beginning skips completed current
sets. Missing originals and encoding failures remain visible and exit 75.
The task is stopped when its workflow ends; a partially encoded generation never
replaces a playable set. No production repair runs automatically on deployment.

An edge resolver purge cannot remove a `302` already cached in a browser.
Mention keeps the canonical by-ID `?variant=hls_master` URL, whose current
response allows one hour of freshness and up to one day of stale revalidation.
Validate both a cold client and a resolver that has expired/revalidated; do not
report instant convergence for clients still holding an earlier redirect.
The repair adds no hydration request and no random query parameter.

### Durable application-scoped backfill

For a corpus, use the same workflow with `mode=backlog`. This task only inserts
requests into the existing `file_rendition_requests` table. It does not download
originals or run encoders. The normal worker fleet processes these requests
after the seeder exits, with its existing leases, deduplicated job IDs, three
attempts with backoff, and bounded Redis window. Migration 0216 adds durable
request lanes to this existing table; there is no separate repair queue.
Deploy the idempotent video worker before seeding: ordinary video jobs skip an
already complete current generation and copy it to outdated same-spelling twins.
An explicit `reencode` still rebuilds from the original.

An application ID is required. Candidates must be active videos owned by that
application or named by an actual `file_references` row for it; old descriptive
`metadata.serviceAppId` alone is insufficient. Each content/visibility group
gets one representative request. Existing pending requests keep their timestamps
and leases. Existing bulk requests move to the repair lane; fresh upload
requests keep their fresh lane. Portrait groups are seeded first, using ordinary request timestamps,
then the other shapes. Finished current masters are excluded.

For Mention, start with a dry run using:

```bash
gh workflow run run-video-rendition-repair.yml --repo OxyHQ/oxy --ref main \
  -f mode=backlog -f dry_run=true \
  -f application_id=6a2f851751b784a86fd0e916 -f limit=1000 -f max_groups=100000
```

Review the scope and counts, then use `dry_run=false` for the intended seed.
`limit` bounds each database page (maximum 1,000); `max_groups` bounds the whole
invocation (maximum 100,000). One image build can seed the full intended corpus.
Each page logs considered/inserted/promoted counts and an `after` cursor of the form
`0:<sha256>:public` (portrait) or `1:<sha256>:public` (other). Resume an interrupted
seed with that cursor, or rerun from the beginning: existing requests keep their
identity and leases while bulk requests are promoted, and finished videos are skipped. Never pass a sample-encode cursor to a
backlog run, or a backlog cursor to an encode run.

Every normal upload enters the same dispatcher: there is no direct 2,000-job
prefill. It leases full 32-slot rounds of 30 fresh uploads, 1 targeted repair and
1 legacy bulk request, oldest within each lane. Each background lane can hold
only one unexpired durable lease, including waiting, active and delayed retry
jobs. Empty or capped lanes donate slots to eligible lanes; an idle fresh lane
cannot fill the queue with slow background jobs before uploads arrive. Redis
holds at most 64 waiting/delayed jobs (two complete rounds) under the new fleet; all use equal
BullMQ priority so FIFO preserves the dispatch order. Refilling only full rounds
prevents continuous one-slot vacancies from resetting the quota to fresh uploads.
An idle upload wakes admission immediately; otherwise workers tick every 10 seconds.

Deploy migration 0216 before the new API/workers. Existing rows and old writers
that omit `lane` default to bulk. During rolling deployment, the new dispatcher
normalizes old priority 10 jobs without resetting attempts/delay and commits excess
waiting work back to PostgreSQL before removing it from Redis. Active jobs and
already-attempted retries remain owned by their existing jobs. Such retained
retries can temporarily keep the window above 64 until they drain; do not reset
their retry budget to shrink it. Verify all old API/worker revisions are gone and
the queue has converged before bulk seeding. The fair-slot guarantee applies to
the complete new fleet, not while old dispatchers can still refill 1,000 jobs.

A repair at its lane's head with no outstanding lease waits behind at most
64 already-admitted jobs plus its reserved slot in the next 32-job round
(position 31). A lane's previous lease must settle or expire before another
request can be admitted. Existing over-cap leases drain naturally; retries,
request renewal and lease-expiry recovery retain their existing ownership rules.
The cap limits unexpired durable ownership, not absolute concurrent execution
after recovery or during a rolling deployment.

The 30:1:1 dispatch ratio alone does not allocate CPU fairly: observed video jobs
can take much longer than images. Limiting each background lane to one lease
leaves capacity for normal uploads while continuing background repairs. Both
weights and the two-round window are dispatch policy, not a latency or completion
SLA. Measure fresh backlog age, arrivals and completions after rollout rather
than converting job counts into a promised repair ETA.

Inspect `Oxy/Queues` `QueueDepth`, `PendingRenditionRequests`,
`OldestWaitingJobAgeSeconds` and `PermanentJobFailures`, worker completion logs,
and lane counts before estimating completion. For read-only operational progress:

```sql
SELECT lane, count(*) AS pending,
       count(*) FILTER (WHERE enqueued_until > now()) AS leased,
       min(requested_at) AS oldest
FROM file_rendition_requests GROUP BY lane ORDER BY lane;
```

An active older Redis job can deduplicate a renewed request for the same file.
Admission checks the stored job version and releases only the newly claimed
request's lease if it is not actually represented, so it becomes runnable after
the older job finishes instead of waiting for the 30-minute lease expiry.
A crash after a partial Redis write rolls the claim back; stable job IDs suppress
duplicate queued work on restart. Seeding remains distinct from successful repair.

Cancellation of the seeding workflow stops further inserts, but requests already
committed continue through the worker fleet. A fleet stop is the existing
operational stop for encoding and affects all rendition work; there is no
independent per-backfill cancel mechanism. Do not delete requests shared with
normal uploads to simulate cancellation. Failed jobs log file IDs and settle
after their final attempt; unresolved videos still lack the current marker and
can be selected again for an explicit retry. Compare the remaining scoped
candidate count and recorded failures with the initial count to monitor progress.

After completed generations publish, consumers that persist rendition metadata
must reconcile the new `hls_master.readyAt` value. Oxy's original is unchanged,
and completing a rendition does not currently emit an application file event.


### Retained terminal rendition jobs

A pre-durable BullMQ job can remain in `completed` or `failed` and reserve the
stable per-file ID. Admission reconciles that record under the fleet scheduler
lock before adding a due request: an explicitly older terminal request (or an
unstamped legacy job created before the durable request) is removed through
BullMQ, while a matching terminal result settles only that exact PostgreSQL
request. This does not reset the completed/exhausted request's retry budget.
Active, waiting, paused and delayed jobs retain their ownership and attempts;
newer or invalid request identities are not retired. A failed removal/add rolls
back the lease, leaving durable work available to the next pass.

Normal producers share admission ownership; the database-outage fallback only
adds/deduplicates and does not retry terminal jobs. There is no application API
for manually retrying these jobs. Any future manual recovery must coordinate
with the scheduler lock or stop admission: BullMQ removal refuses an active
worker lock, but `getState()` followed by `remove()` is not an atomic comparison
against arbitrary administrative state changes. Do not bulk-delete or re-seed
the queue to recover a retained terminal head.
