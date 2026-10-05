# Oxy One physical storage admission draft

This source change is inert until `storageAdapter` is configured. It does not
change bucket policies, CORS, lifecycle rules, deployment, or live entitlements.
The same central/individual/legacy maximum capacity and account locks apply.

Implemented paths:

- Buffered image variants (bulk and lazy): persist exact rendered-byte admission
  in an open transaction, check quota before PUT, use a unique object key, and
  keep the content-hash/account/file locks through PUT and readiness commit.
  A failed PUT/commit deletes that unique key and rolls back metadata. Existing
  rendition objects are reused by the normal ready-variant path; replacing an
  existing admitted type is rejected rather than silently orphaning its key.
- Owner and federated streams: stage the existing `maxBytes`-bounded stream on
  local temporary disk, calculate actual size/SHA, then admit its file row before
  bucket multipart upload. Hash/account locks span PUT and commit. Failed PUTs
  clean up the unique object and disk staging; duplicate own content reuses an
  existing valid object. Missing deduplicated objects require repair rather than
  silently writing into an uncoordinated key.
- System federation cache and sticker namespaces retain their existing bounded
  stream pipeline and cleanup; they are not consumer-account storage.

Exact remaining restrictions and operational gates:

- Newly generated owner video/poster/HLS paths fail closed with
  `STORAGE_PHYSICAL_PATH_UNAVAILABLE`. HLS needs reservation of **all** playlist,
  master, and segment bytes: its current segment objects lack variant size rows.
  Existing admitted ready variants remain readable. Image resizing from an
  existing admitted video poster can use the buffered image path.
- PDF rendition generation was a metadata-only placeholder without real bytes;
  configured accounts now receive the same explicit unsupported error.
- Bounded network writes hold a database connection and locks. Validate provider
  request timeout/pool capacity and local temporary-disk capacity before enabling.
  This draft does not assert that a finite `maxBytes` protects aggregate disk use.
- An abrupt process death after PUT but before DB commit can leave a unique
  object without a committed row. Ordinary cleanup failures surface to the caller;
  neither failure currently creates a durable cleanup reservation/ledger entry.
  A crash-recovery reservation ledger or bucket inventory/lifecycle policy is
  still required for a physical bucket guarantee. No production policy changed.
- Existing original direct uploads and outstanding presigned URL deletion/reuse
  need the same lifetime coordination. Signed exact size/hash/conditional PUT
  bounds one request, but an expired reservation/deleted row does not revoke a URL.

These are working admission paths and explicit restrictions, not an end-to-end
claim that all physical bytes or crash orphans are bounded by 100 GB.

## Bounded follow-up contract for physical lifetime recovery

Add a persistent reservation with account, immutable source/limit snapshot,
content hash, unique object key, exact admitted bytes (or HLS manifest total),
upload expiry, and states `reserved`, `uploading`, `committed`, `cleanup_pending`,
`cleaned`. Reserved and cleanup-pending bytes must count until deletion succeeds;
only a committed live file/variant may replace that reservation without double
counting. Creating the reservation and quota check must share the existing account
lock. A recovery worker rechecks ownership/key claims under the content-hash lock,
HEADs an interrupted upload, and either atomically attaches verified bytes or
records durable deletion. It must not credit capacity for failed cleanup.

Presigned reservations remain counted through URL expiry plus permitted in-flight
completion; file deletion cannot release that reservation while its PUT may still
arrive. Require exact signed size/hash/conditional key and never recycle that key.
HLS must reserve and associate every segment and playlist; master publication is
last and occurs only after all objects are verified. Add crash-before/after-PUT,
late-PUT-after-delete, two-account shared-key, restart recovery, cleanup failure,
and competing upload/expiry tests. This requires source/schema/worker work and
provider timeout/lifecycle verification, not a commercial price/provider decision.
