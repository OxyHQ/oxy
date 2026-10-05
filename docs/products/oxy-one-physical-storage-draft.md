# Oxy One physical storage admission draft

This source change is inert until `storageAdapter` is configured. No bucket
policy, CORS, lifecycle, deployment, or live entitlement changes are included.
The central/individual/legacy maximum capacity and account locks remain shared.

## Implemented admission and durable holds

`storage_byte_reservations` records account, SHA, exact key/size, writer kind and
recovery lease **before** network writes. It intentionally survives account
removal. Usage counts open reservations plus originals/variants, excluding a
reservation only when that account has an exact live key+size claim. Deletion or
transaction rollback therefore restores the physical hold; it does not release
capacity merely because metadata disappeared. Completed cleanup retains its audit
row. Migration 0149 is additive and marked pre-deploy; only throwaway test databases
have been migrated.

- Buffered image variants, both bulk and lazy, admit rendered bytes before PUT;
  unique keys and content-hash/account/file locks protect PUT/readiness commit.
  Existing ready variants are reused; replacing a claimed type is rejected.
- Owner/federated streams stage their existing `maxBytes`-bounded source on local
  disk, compute actual size/SHA, durably reserve, then insert quota-admitted rows
  before bucket multipart PUT. Hash/account locks span PUT and commit. Failure
  deletes the unique object and local staging, but retains the durable hold until
  recovery confirms terminal upload and cleanup. Concurrent identical uploads
  recheck owner deduplication under the hash lock; an attempt that never issued
  PUT or a URL releases its unique unwritten hold and reuses the winner. Missing
  own deduplicated objects
  require repair instead of uncoordinated reuse.
- Direct originals, direct repair, federation repair and configured presigned URL
  issuance also create/renew exact durable holds before PUT/URL delivery. Promotion
  of a server key to a presigned key is monotonic; renewal never changes its
  immutable account/hash/size. Configured init does not copy a missing opposite
  visibility spelling before byte admission.
- System federation cache/sticker namespaces retain their bounded stream cleanup;
  they do not spend consumer account storage.

## Recovery interface and exact activation gates

`recoverStorageByteReservations(deleteAndVerifyAbsent, confirmUploadQuiescent,
limit, now)` is a bounded backend drain interface. It serializes under existing
content-hash and account locks, rechecks the current reservation kind/lease,
excludes live key claims before the batch limit and rechecks them under locks,
then releases a server hold only after trusted
quiescence proof followed by verified absence. Failed proof/cleanup retains quota.
The recovery adapter/scheduler is **not connected or activated** in this draft.
A crashed PUT followed by failed DB commit still has its durable quota hold.

A lease or HEAD absence does not prove that an interrupted network request ended.
The future provider/proxy adapter must supply terminal completion evidence (or a
verified infrastructure maximum request lifetime) before automatic release. Tests
provide this proof only for synthetic, terminated bucket operations. Unknown
completion conservatively consumes capacity, even when a best-effort delete
appeared to succeed.

Presigned holds are never automatically cleaned: signature expiry does not bound
an already-started PUT. They remain counted after deletion and after the 60-second
signature window, preventing capacity reuse before a late PUT. A safe release
contract needs an enforced request lifetime/terminal proof for **every** issued
URL; no arbitrary in-flight grace period is invented.

## Remaining paths and verification

- Fresh owner video/poster/HLS generation returns 503
  `STORAGE_PHYSICAL_PATH_UNAVAILABLE`; its playlist/segment/master writes need a
  complete byte manifest and reservations. Existing ready variants stay readable,
  and image resizing from an existing video poster uses buffered admission.
- PDF generation was a metadata-only placeholder without bytes; configured owner
  calls now return the same explicit unsupported error.
- Visibility relocation and historical cross-owner/storage-key spelling repair
  retain older copy implementations, but configured owner writes now fail closed
  before an unreserved copy. A visibility transition requiring a copy is rejected
  before privacy metadata changes. Shared existing object references and system
  namespaces remain usable. The full copy-byte reservation/reclamation bridge is
  unfinished.
- Existing pre-ledger files are not retroactively inventoried. Temporary multipart
  parts, aggregate temporary-disk use, pool capacity and provider timeouts need
  infrastructure validation. Bounded writes hold DB connections/locks during PUT.
- Cleanup recovery requires the trusted adapter above before production activation.
  No production lifecycle policy or automatic reservation deletion is included.

Real PostgreSQL plus synthetic bucket tests cover admission before PUT, actual
sizes, exact claim deduplication, crash-after-PUT holds, failed cleanup, successful
verified drain, account/deleted-file isolation, and expiry/deletion/late-PUT
capacity retention. A SQL lock barrier checks server-to-presigned promotion after
candidate selection. These support the stated paths and conservative holds, not
a claim of complete physical bucket enforcement across all legacy paths.
