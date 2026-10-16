# ADR 0041 — Application-owned files

- Status: accepted; implemented in the change that adds this ADR
- Date: 2026-10-16
- Decided by: the owner of Oxy
- Changes: the `files` owner model of `0124_files_per_owner_live_key`
  (`docs/engineering/per-owner-asset-rows.md`), which had two owner kinds.

## Context

Every Oxy file was owned by an account (`files.owner_user_id`) or by one of a
closed set of system namespaces (`files.system_owner`: the federation avatar
and media caches, the sticker catalogue). Mercaria, a first-party application,
has platform artwork — category tile images — that belongs to no account. The
only ways to store it were to hang it off some person's account (whose
deletion would then delete the marketplace's artwork, and whose quota would pay
for it) or to add a system namespace per product (a platform code change for
every product's assets, with no billing principal at all).

The owner wants the root-level answer: an Oxy APPLICATION natively owns files.

## Decision

### D1 — An application is the third owner principal

`files.owner_application_id` references `applications(id)`, and
`files_owner_exclusive_check` becomes "exactly one of `owner_user_id`,
`system_owner`, `owner_application_id`". Dedup stays per owner:
`files_owner_application_id_sha256_live_key` keeps one live row per
(application, content hash), as 0124's two uniques do for the other owners.
Storage stays content-addressed and shared across owners, so an application's
row for bytes an account already holds shares that object.

### D2 — RESTRICT, never CASCADE

`ON DELETE RESTRICT`. A cascade would drop the rows and with them the only
record of the storage keys, so the bytes would never be purged. Whatever
removes an application first tombstones its files through the ordinary
tombstone + `storage_object_deletions` path. Today the only hard delete of an
application is the `users` cascade when its owning account is hard-deleted, so
`recordAccountStorageDeletion` records and removes the files of every
application the account owns, on the hard-delete and the archive path alike.
Their ledger rows are keyed `app:<applicationId>`, beside an account's id and
`system:<namespace>`. A soft-deleted application (`status = 'deleted'`) keeps
its files; it cannot write new ones (D4).

### D3 — Billing is the application's owning account

An application-owned file's bytes are metered against
`applications.owner_account_id` — the billing principal of ADR 0007, never the
person who happened to call. `reservedStorageBytes(account)` counts the
account's own rows plus every row of every application it owns, and every
admission path (row inserts, size and variant writes, the staged-stream
reservation, admitted variant uploads) locks and measures that account. A
system namespace stays unmetered. An application changing owning account moves
its files' bytes to the new account's usage with it.

### D4 — Two scopes, privileged, and bound to application type

`files:app:write` (upload, list, change visibility) and `files:app:delete`
(tombstone). The owner of every call is the verified service token's `appId` —
never a header, body field or query — so a token reaches only its own
application's files, and another application's file answers like no file
(404).

Both scopes are privileged (staff-granted) although they are own-tenant
authority: they make Oxy keep bytes no person owns, and whether an application
may have platform storage of its own is a platform decision. They are also
bound to the application's TYPE — only `first_party`, `internal` and `system`
applications may hold them, refused even to staff on create and update — and
the routes re-check, live, that the calling application is `active` and of
such a type, so a reclassified or suspended application's still-valid token
cannot write. Mercaria's seed spec carries both.

### D5 — What visibility means on an application's file

- `public` and `unlisted`: as for an account's file — readable by anyone who
  has the link, through the CDN or the origin stream.
- `private`: readable by NO person. There is no account that owns it, follows
  it, or can be shown it, so the media-privacy check denies every session and
  `GET /assets/:id` answers 404. The owning application reads the bytes with its
  own service token through `POST /assets/service/linked-url`, which admits an
  application's own file without a link.

Visibility is explicit: the upload requires it, and only the owning
application's `PATCH /assets/service/app/:id/visibility` changes it. Linking an
application-owned file never re-derives its visibility, and an application's
file is never moved to `trash` by link bookkeeping.

## Alternatives rejected

- **A system namespace per product** (`__mercaria__`). A schema change per
  product, nobody to bill, and nothing ties the namespace to the application
  that may write it.
- **A designated service account per application.** Precisely the "file hanging
  off an arbitrary user account" the owner ruled out: an account can be
  deleted, archived, signed in to and blocked, none of which describes an
  application.
- **CASCADE from `applications`.** Loses the purge (D2).

## Consequences

- `files` gains a column and two partial indexes; both index builds hold SHARE
  on `files` (migration `0167_application_owned_files`, whose header gives the
  out-of-band `CONCURRENTLY` route).
- `@oxy.so/core`'s `Asset.ownerUserId` becomes optional and
  `Asset.ownerApplicationId` exists; `OxyServer`'s `assets` namespace gains the
  application-file calls.
- The storage usage breakdown (`GET /storage/usage` categories) still lists the
  account's own files; `reservedBytes`, the figure quota enforces, includes its
  applications' files.

## Related

- `packages/api/src/db/schema/files.ts`, `services/storageQuota.service.ts`,
  `services/accountStorageDeletion.service.ts`, `routes/assets.ts`
  (`/service/app`)
- `packages/api/src/utils/applicationScopes.ts` — `files:app:*` and
  `isScopeGrantableToApplicationType`
- ADR 0007 (billing principal), ADR 0021 (service read of linked files)
