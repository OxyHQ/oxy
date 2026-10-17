# ADR 0043 — Who owns a file, who uses it, and when it goes away

- Status: proposed (design agreed with the owner of Oxy on 2026-10-16; stages
  1, 2, 3, 4a, 4b and 4c of the rollout are implemented on this branch; the
  release runbook is at the end)
- Date: 2026-10-16
- Decided by: the owner of Oxy
- Changes: the `files` owner model of `0124_files_per_owner_live_key`
  (`docs/engineering/per-owner-asset-rows.md`), the `file_links` usage model,
  and the file lifecycle (`active | trash | deleted`).

## Context

Oxy Files is the platform's file system: content-addressed storage, shared
bytes across owners, image and video renditions, CDN delivery. Three things are
missing, and every product has worked around them separately.

1. **A file can only belong to a person (or one of three hard-coded system
   namespaces).** Content that belongs to a product, not to anybody — marketplace
   catalogue photos for items no store sells, category and brand artwork, a GIF
   library, music artwork, imported place photos — has nowhere to live. Today:
   Mercaria imports catalogue photos under the personal account of whichever
   operator made the request; Mention keeps its GIF library in the evictable
   federation cache, exempted from eviction by convention; Syra, Homiio, the
   Oxy website and Alia run their own buckets; Moovo hotlinks supplier URLs;
   GoWay cannot import a place photo without a contributor account.
2. **Oxy does not know who uses a file.** `file_links` exists, but `app` is free
   text, only a signed-in person can write a link, linking re-derives (and can
   silently flip) a file's visibility, and only GoWay and Nilo register usage.
   A file that was never linked can never become unused.
3. **Nothing ever goes away.** There is no trash expiry and no garbage
   collection. Each product that cared built its own (Mention's deletion outbox,
   the website's `storage_cleanups`, Allo's 7-day sweep, Clarity's 30-day sweep,
   Syra's duplicate-merge script) and the rest accumulate orphans (Homiio records
   ~950). Importers re-upload the same supplier image on every sync because
   nothing remembers it was already imported.

There is also no way to take content down on a rights or privacy claim.

## The model in one paragraph

Like Google: **what is Oxy's belongs to Oxy, what is a person's belongs to the
person, and a third-party developer's app owns its own files inside the
developer's storage plan.** Separately from ownership, **every product that uses
a file says so**, and a product-owned file nobody uses any more goes to the trash
and is deleted after 30 days. A person's file is never deleted behind their back.

## Decisions

### D1 — Three kinds of owner

| Owner | Column | Examples |
|---|---|---|
| **Account** (a person or an organization) | `owner_user_id` | a person's uploads; a store's photos (the store is the account's) |
| **Application** | `owner_application_id` → `applications(id)` | Mercaria's catalogue and category art; Mention's GIF library; a third-party app's assets |
| **Platform namespace** (Oxy core itself) | `system_owner` | stickers, the federation caches |

Exactly one is set (CHECK). Dedup stays per owner: one live row per (owner,
sha256); the bytes stay shared across owners. `ON DELETE RESTRICT` from
`applications` — a cascade would drop rows and with them the only record of what
to purge (D8 says how an application's files really go).

### D2 — Oxy's own applications are the platform, not a customer

An application whose `type` is `first_party`, `internal` or `system` is Oxy.
Its files belong to the application itself, are not attributed to any account,
and are **not billed or quota-limited**. They are observed instead: per-application
stored bytes and daily growth are exported, and a growth anomaly (e.g. an import
loop) alerts the platform team. This replaces the earlier draft that metered
first-party files against `applications.owner_account_id` — the `oxy` account
that owns every official application is an artefact of registration, not a
storage customer.

### D3 — A third-party application owns its files inside its developer's plan

A `third_party` application may own files too. They belong to **that
application** (not to the developer's personal files) and their bytes count
toward the storage plan of the developer account that owns the application
(`applications.owner_account_id`, the billing principal of ADR 0007), shown per
application in the console. Over plan, the application's uploads are refused
with a clear error; existing files keep being served. A transfer of the
application to another account moves its bytes to that account's usage.

### D4 — Usage is a first-class record: `file_references`

`file_links` becomes `file_references`:

`(file_id, application_id → applications, entity_type, entity_id, created_by_user_id NULL, created_at)`, unique on the four identifying columns.

- The using product is a real application id, never free text. Existing
  `app` strings are mapped once by the migration (`goway`, `mercaria`,
  `nilo`, `oxy-mail`, `profiles` …); an unmappable value fails the migration.
- **An application registers and removes its own references with its service
  token**; a signed-in person can still reference their own file from inside an
  application (the session's client application is recorded).
- An application may reference a file it does not own only if the owner is the
  application itself, the file is public/unlisted, or the account owner granted
  it (ADR 0021). It never references another application's private file.
- **A reference never changes visibility.** Only the owner changes visibility.
  (Today linking a public file with a non-avatar entity type makes it private.)
- Webhook URLs move from the link row to the application (D9).

### D5 — Lifecycle: nothing in limbo, nothing deleted behind a person's back

- **Account-owned files are never deleted automatically.** When the last
  reference goes, the file stays `active` and is marked *not in use*
  (`unreferenced_since`), visible as such in the person's file manager. Only the
  person moves it to trash or deletes it. Trash is the person's: no expiry.
- **Application-owned files are garbage-collected.** `unreferenced_since` is set
  at upload and whenever the last reference goes, and cleared by any new
  reference. A new GC worker moves an application file that has been
  unreferenced for 24 hours into `trash`, and tombstones + purges (the existing
  `storage_object_deletions` ledger) one that has been in trash for **30 days**.
  A new reference during those 30 days restores it.
- **Platform namespaces** keep their own rules (the federation cache is evicted
  by its using service, stickers are curated by staff).
- **`trash`, `blocked` (D10) and `deleted` files are never served** — not by the
  stream fast path and not by the CDN (closes OxyHQ/oxy#1284). Every transition
  out of `active` invalidates the CDN path.
- Uploads that never completed (`initUpload` rows with no object) are swept
  after 24 hours.

### D6 — Reconciliation: the safety net

Registering references at every write can still miss one (a crash between two
writes, an old bug). An application can send its full inventory for one
`entity_type`: `begin` → paged `put` of `(file_id, entity_id)` pairs → `commit`.
Oxy diffs against stored references, adds the missing, removes the stale, and
reports both counts. Products run it on a schedule; the first run of each product
is how existing data enters the model.

### D7 — Import by URL happens in Oxy, once

`POST /assets/service/app/import` (and the account-owned equivalent behind
`files:user-media:write`) takes a source URL. Oxy downloads it with its own
SSRF-safe fetcher, stores it, and records `file_sources(owner, source_url_hash,
file_id, etag, last_modified, fetched_at)`. Importing the same URL for the same
owner again returns the existing file without downloading (and revalidates with
the stored ETag / Last-Modified when asked). One fetcher replaces the copies in
Mercaria, Move, Mention, Homiio, Syra and the website, and ends re-uploads on
every sync. The source URL is provenance, kept hashed plus in clear only for the
owner.

### D8 — Deleting an application deletes its files, now

Deleting an application in the console requires typing its name. In the same
operation every file the application owns is tombstoned and owed a purge (no
30-day trash — the developer asked for deletion), and every reference the
application registered is removed. Account-owned files it used are untouched
(they just become *not in use* for their owner). Deleting a developer account
deletes its applications first, the same way. The soft-deleted `applications`
row stays as the audit record; nothing of the application's content remains.

### D9 — Events to the using applications

Each application has one verified webhook endpoint (and an outbox with retries
for it). Oxy emits `file.blocked`, `file.unblocked`, `file.deleted` and
`file.visibility_changed` to every application holding a reference, so a product
can remove or replace the image it shows. This replaces per-link webhook URLs.

### D10 — Takedown: rights and privacy claims

- The Oxy website gets a public **"Report content / rights claim"** page under
  `/transparency/legal` (copyright, trademark, privacy/personal data, illegal
  content), linked from every product's legal footer. A claim names the content
  (Oxy file URL, or a product page URL that Oxy resolves to files), the claimant,
  a contact address and a good-faith statement.
- Claims land in a staff review queue in the console with an audit trail and
  state (`received → reviewing → actioned | rejected → counter-noticed`).
- Actioning blocks the file: status `blocked`, CDN invalidated, `file.blocked`
  sent to every referencing application (D9), and the sha256 put on a blocklist
  so the same bytes cannot be re-imported or re-uploaded by any owner. A counter
  notice can unblock. The claimant and the owner are notified.
- A person asking for their own data to be removed uses the same page; that path
  is the GDPR erasure request and has its statutory deadline tracked.

### D11 — Scopes

- `files:app:write` — upload/import/list/change visibility of the calling
  application's own files. `files:app:delete` — delete them.
  `files:references:write` — add/remove/reconcile the calling application's
  references.
- For `first_party`/`internal`/`system` applications they are granted by staff;
  for `third_party` applications `files:app:*` and `files:references:write` are
  self-service and covered by D3's plan limits.
- The owner of every call is the verified token's application — never a header,
  body or query field. Another application's file answers like no file (404).

### D12 — Access-check fixes that ship first

Independent of the model, and already implemented on this branch: only the
owner may restore a file, link it, or ask whether it exists; `GET /assets/:id`
hides private files and other people's links from non-owners; an unlink that
removes nothing no longer trashes. `DELETE /assets/:id/links` is closed by D4
(GoWay's claim withdrawal removes a contributor's reference as the GoWay
application, not with the business's session).

## Rollout

1. **Oxy core**: D12; schema (owner, `file_references`, `unreferenced_since`,
   `blocked`, `file_sources`); D4 migration of existing links; D5 GC worker and
   CDN serving fix; D6, D7, D8, D9; D10 backend + console queue + website page;
   SDK (`@oxy.so/core` server: `assets.app.*`, `assets.references.*`,
   `assets.import`, webhook verification). The GC worker starts in report-only
   mode and is switched to deleting after a week of reviewed reports.
2. **Mercaria**: store and listing media under the store's account; canonical,
   external-offer, brand and category media owned by the Mercaria application;
   every usage referenced; nightly reconciliation; `file.blocked` handling;
   importer replaced by D7 (ends the connector re-upload and the canonical
   duplicate-row bugs); production backfills.
3. **Mention** (GIF library out of the federation cache into the Mention
   application; references for post media), **Moovo** (category art), **GoWay**
   (imported place photos owned by GoWay with attribution; claim withdrawal via
   the application), and references from Noted, Nilo, Peable, CrowdSource, Move.
4. **Own-bucket products move into Oxy Files**, one at a time with a verified
   copy and a read-only soak before the bucket is retired: Syra (catalogue
   artwork, and Alia's show covers move to Alia), Homiio, the website, Alia
   (skill bundles), Clarity (crawler image cache as Clarity-owned files under D5's
   collection). Allo's end-to-end-encrypted chat blobs stay where they are: they
   are ciphertext with a 7-day contract, not media.

### Stage 1 as built (D2, D3, D4, D11; D12 earlier)

- **Metering.** `storageAccountForOwner` attributes an application's file to
  `applications.owner_account_id` only when the application is `third_party`,
  read live (a transfer or reclassification moves the bytes at once); Oxy's
  own applications attribute to no one. Per-application stored bytes are
  `applicationStoredBytes` and `GET /applications/:appId/storage`
  (`usage:read`); the growth alert of D2 came in stage 4b.
- **Scopes.** `files:references:write` joins `files:app:write` and
  `files:app:delete`. `isPrivilegedScopeForApplicationType` makes the three
  staff-only on `first_party`/`internal`/`system` and self-service on
  `third_party`, on create, update and credential creation; a `third_party`
  application may hold a SERVICE credential (and mint a token) carrying only
  these and the payments pair. Type-blind readers of the privileged set (the
  legacy scopeless-credential fallback, workload bindings) still treat them as
  privileged. The routes re-check live only that the application is `active`.
- **`file_references`.** Migration `0171_file_references` (pre) creates the
  table, copies every `file_links` row with its `app` resolved by
  `oxy_file_link_application_id` — `goway` → GoWay, `mercaria` → Mercaria,
  `nilo` → Nilo, `oxy-mail` → Oxy Inbox, `profiles` → Oxy Accounts, or an
  application id itself (`src/utils/legacyFileLinkApplications.ts`, held equal
  by a test) — and FAILS naming every value that resolves to no single active
  application. `scripts/file-references-preflight.ts` lists the values a
  database holds before deploying. A trigger mirrors the previous image's
  `file_links` writes until `0177_drop_file_links` (post) drops the table:
  each later stage put its `pre` migrations in front of the drop (stages 2,
  3, 4a and 4b moved it from 0168 up to 0174, and main's
  `0167_application_roles`, `0168_agent_requester_ceilings` and
  `0169_supervised_personal_policy` three further, to 0177), so one release
  carries them all and the drop runs after the rollout.
  For that window the previous image does not see references the new image
  writes.
- **Who may reference.** `POST`/`DELETE /assets/service/references` (batch of
  100, per-item `created`/`exists`/`removed`/`not_found`) as D4 says; a
  refusal answers like a missing file. A service-made reference has no
  creator, so it can never satisfy ADR 0021's owner-linked predicate.
- **The session surface** (`POST`/`DELETE /assets/:id/links`) stays as a
  compatibility path. A session bound to one application records that
  application; the shared first-party session cannot name its application, so
  its body `app` is resolved like the migration (id or legacy name; anything
  else is 400). Only the owner may add; `visibility` in the body is the
  owner's explicit change and nothing is inferred. A non-owner may remove only
  a reference it created, and that never trashes the owner's file.
- **Not changed yet (D5).** An OWNER's session removing the last reference
  still moved their file to trash; stage 2 ended that (below).
- **Webhook URL** stays on the reference row, deprecated, until D9.

### Stage 2 as built (D5, D6)

- **`unreferenced_since`, `trashed_at`** (`0172_file_lifecycle`, pre). The
  reference write maintains `unreferenced_since` in its own transaction under
  a `FOR NO KEY UPDATE` lock on the file row (`fileRepository.addFileReferences`,
  `deleteFileReference`, `deleteFileReferencesByIds`, the owner split's
  repoint): stamped at insert (for EVERY owner — a new file is used by nothing)
  and when the last reference goes, cleared by a new one. The migration
  back-fills it on every live unreferenced file (`coalesce(updated_at,
  created_at)`) and `trashed_at = updated_at` on trash. `inUse` (from the
  reference set itself) and `unreferencedSince` are on the owner's `GET
  /assets` and `GET /assets/:id`; `GET /assets?inUse=false` lists the files no
  application uses. The file manager shows "Not in use".
- **No reference bookkeeping trashes anything, on any path** — the owner's
  session removing the last link included (it did until now). A new reference
  still brings a trashed file back, now clearing `trashed_at` and republishing
  it; an application's re-upload of bytes it holds in trash does too, with a
  fresh 24-hour clock. There is still no "move to trash" route for an account:
  its owner deletes, or restores what an earlier version trashed.
- **The sweep** (`services/fileLifecycle.worker.ts`, every API task, one runs
  at a time): `purge` (an application's file 30 days in trash → tombstone +
  `storage_object_deletions`), `trash` (an application's active file
  unreferenced 24 hours), `staleUploads` (an account's `/assets/init` row with
  no name and no metadata — what `/complete` always sets — 24 hours old and
  holding NO object; one that holds an object is counted, never deleted) and
  `unpublishTrashed` (a public file in trash still under `public/`). Every
  action is one conditional write re-checking the whole condition, including
  "no reference, mail attachment or store screenshot at all", so a stale
  stamp can never collect a used file. Platform namespaces and every
  account's unused or trashed file match no step. Runs are leased, scheduled
  and backed off in `file_lifecycle_sweeps`, which is also the report
  (`GET /assets/admin/lifecycle/sweeps`, staff): per step, files `due` and
  `acted` on, and up to 100 named. One EMF log line per run
  (`Oxy/FileLifecycle`, dimension `Mode`).
- **Serving.** Only `active` is served (`config/cdn.isServableStatus`): the
  stream route (its CDN fast path redirected a trashed public file —
  OxyHQ/oxy#1284), `/download`, `/url`, `/batch-access`, `/cdn/:id`,
  `/service/linked-url` and `getPublicCdnUrl`. Because the CDN's origin is the
  bucket, a public file leaving `active` also MOVES its objects off `public/`
  (key spelling follows `isServedPublicly` = public AND active), owing the
  `public/` spelling a delete through the ledger, and queues CloudFront
  invalidations for its `public/` keys and for `/<id>` (the cached
  `/cdn/:id` redirect). Restoring moves them back. The shared-content guard
  no longer lets a trashed public row keep a `public/` copy alive. `blocked`
  is not added yet: every gate names `active`, so stage 4's status is refused
  the day it exists (hook marked on `FILE_STATUSES`).
- **Reconciliation (D6).** `POST /assets/service/references/reconcile`
  `{ entityType }` → `{ sessionId, expiresAt }`; `PUT …/:sessionId`
  `{ items: [{ fileId, entityId }] }` (≤ 1,000; ≤ 500,000 per session; each
  page slides the one-hour deadline); `POST …/:sessionId/commit`
  `{ dryRun? }` → `{ added, removed, unchanged, refused }`; `DELETE
  …/:sessionId` releases it. Scope `files:references:write`. Additions follow
  `mayApplicationReference`; a removal removes only a reference created
  BEFORE the session began, so a write made during the inventory is never
  undone. One open session per (application, entity type), 409 otherwise; an
  expired one answers 410 and is retired by the next `begin`. SDK:
  `OxyServer.assets.references.reconcile(entityType, items, { dryRun })`,
  `@oxy.so/core` 4.18.0 (4.12.0 through 4.17.0 went to `main` first).
- **GoWay** holds `files:references:write` in the seed.

#### Switching the sweep to enforce

`FILE_LIFECYCLE_MODE` is `off`, `report` (default) or `enforce`
(`FILE_LIFECYCLE_INTERVAL_MS`, default an hour; `FILE_LIFECYCLE_BATCH_SIZE`,
default 200 per step per run). After deploying, leave it in `report` for a
week and review `GET /assets/admin/lifecycle/sweeps` daily: `trash.due` and
`purge.due` should be applications' files nobody references (spot-check the
samples against the owning product — Mercaria and GoWay should have run their
first reconciliation, since an unreconciled product's files read as unused),
`staleUploads.withObject` should be explained, and no count should jump
without a cause. Then set `FILE_LIFECYCLE_MODE=enforce` on the API task
definition and redeploy; the first enforced runs work the back-filled backlog
off 200 files per step per hour. To stop at once, set `report` (or `off`)
again: nothing is deleted until a file has spent 30 days in trash, and a
reference or a re-upload restores it until then.

### Required changes in other repositories (stage 1)

- **GoWay** withdraws a contributor's photo from a place with the business's
  session today (`placeFiles.detach`). Since the D12 restriction that call is
  refused (best effort: GoWay logs it and the contributor's reference stays,
  keeping the file alive and changing nothing visible). GoWay must call
  `OxyServer.assets.references.remove([{ fileId, entityType: 'place',
  entityId }])` with its own token, which needs staff to grant GoWay
  `files:references:write`. No compatibility path was kept: the lingering
  reference is harmless and reconciliation (D6) removes it.
- **Mercaria**: review media are no longer made private by their link (the
  link carried no visibility and the old inference chose `private`); the
  digital-asset link (`services/digital/storage.ts`, sent from the server
  client with no user session, which the session route does not accept) must
  move to `assets.references.add`.

### Stage 3 as built (D7, D8, D9; owner trash)

Migration `0173_application_file_events` (pre): `file_sources`,
`file_event_deliveries`, and three nullable `applications.files_webhook_*`
columns. The drop of `file_links` moved after it (now `0177_drop_file_links`,
post).

- **Import by URL (D7).** `POST /assets/service/app/import`
  (`files:app:write`) `{ sourceUrl, visibility, reference?, revalidate? }`;
  `POST /assets/service/app/import/batch` `{ items }` (≤ 50, run four at a
  time, per item `{ index, ok, … | error: { status, code, message } }`);
  `POST /assets/service/user-media/import` — the account-owned twin, with
  exactly `/service/user-media`'s authority and owner: the owner is the
  `x-owner-user-id` header (not a body field, to stay identical to the
  upload), and the scope check is the same helper (`files:user-media:write`,
  or the legacy `files:write` + `federation:write` pair Mention holds);
  `visibility` defaults to `public` like the upload. `reference` registers
  the CALLING application's use in the same request under
  `mayApplicationReference`, and needs `files:references:write` too (403
  before anything is fetched). The fetcher is `services/fileImport.service.ts`
  over `safeFetch` with `redirect: 'manual'`: every hop re-resolved and pinned
  by safeFetch AND required to be `https` (safeFetch alone would follow to
  http), ≤ 5 redirects, no credentials (a `user:pass@` URL is 400),
  `Accept-Encoding: identity` (an encoded body is refused), 15 s to headers,
  60 s in all, 40 MiB through the upload pipeline's own byte meter, image or
  video types `isAllowedCacheMime` admits. The bytes go through the normal
  upload (`uploadApplicationFileStream` / `uploadUserMediaStreamDetailed`):
  per-owner sha256 dedupe, variants, a third-party application's plan. Errors:
  400 `INVALID_SOURCE_URL`, 422 `SOURCE_URL_REFUSED`, 502
  `SOURCE_FETCH_FAILED`, 504 `SOURCE_FETCH_TIMEOUT`, 415, 413
  `PAYLOAD_TOO_LARGE` / `STORAGE_QUOTA_EXCEEDED`. `file_sources` is unique per
  (owner, SHA-256 of the normalized URL, fragment dropped); the URL is sealed
  with `secretBox` (context `file-source|<owner>|<hash>`) and only the host is
  in clear. A repeat import of an ACTIVE file answers `outcome: 'existing'`
  with no request; `revalidate` sends `If-None-Match` / `If-Modified-Since`
  (`not_modified` on 304); new bytes become a file of their own and the
  source row moves (`downloaded`); a source whose file was trashed or deleted
  is downloaded again. Answers carry `{ file, outcome, deduplicated, source:
  { host, fetchedAt, etag?, lastModified? }, reference? }`, never the URL.
- **Application deletion (D8).** `DELETE /applications/:appId` takes
  `{ confirmName }` (checked AFTER `app:delete`, so a caller without it still
  gets 403), compared trimmed and case-sensitively with the current name,
  re-checked under the row lock; otherwise 400 `CONFIRM_NAME_MISMATCH` and
  nothing changes. In the same transaction
  (`services/applicationDeletion.service.ts`): `status = 'deleted'`, every
  reference the application holds removed (`unreferenced_since` stamped on
  files left with none — an account's file becomes *not in use*, never
  trashed), every non-deleted file it owns tombstoned (trash included; a file
  someone else holds too — they are told) with its targets armed in
  `storage_object_deletions` (`file.deleted`, `app:<id>`), and `file.deleted`
  queued for every other application using one. After commit the CDN paths
  are invalidated; the console route also starts draining the ledger in the
  background, and the storage-deletion worker finishes anything left (it does
  all of it on the account paths). Answer: `{ success, filesDeleted,
  referencesRemoved }`. A write racing the deletion cannot add to it: the
  reference insert and an application file's insert read the application
  under `FOR KEY SHARE` (conflicting with the deletion's `FOR UPDATE`, taken
  first in the same lock order) and refuse a deleted one. Tokens: unchanged —
  the file routes already re-check `active` live. **Accounts:** the hard
  delete, the personal archive and the organization archive call
  `deleteAccountApplications` before `recordAccountStorageDeletion`, which
  then removes the tombstoned rows, so `RESTRICT` never meets the cascade.
  The console's delete dialog requires typing the name.
- **File events (D9).** Not the existing `applications.webhook_url`: it
  receives account events as Security Event Tokens at an endpoint built for
  them, and its secret is never readable by the developer, so HMAC
  verification against it was impossible. Instead
  `applications.files_webhook_url` + `files_webhook_secret_ciphertext`
  (`secretBox`, context `files-webhook|<id>`) + `files_webhook_verified_at`
  (CHECK: no URL without both). `PUT /applications/:appId/files-webhook`
  `{ url }` (`webhooks:update`; https; `safeFetch`, so a public address)
  POSTs `{ type: 'webhook.challenge', challenge }` signed with a NEW secret
  and stores the endpoint only on a 2xx `{ challenge }` echo (422
  `WEBHOOK_VERIFICATION_FAILED` otherwise); it returns `{ url, verifiedAt,
  secret }`, the only time the secret is shown. `GET` (`webhooks:read`)
  answers `{ url, verifiedAt }`; `DELETE` clears all three. The console's
  Webhooks section has a "File events" block for it. `recordFileEvents`
  writes one `file_event_deliveries` row per (file, application) in the
  transaction of the change — the owning application and every referencing
  one, only with a verified endpoint, never a deleted one — with the payload
  `{ id, type, occurredAt, file: { id, ownerKind, visibility, status },
  references }` (that application's own references only; an account owner is
  `ownerKind: 'account'`, never named). Emitted from: every tombstone
  (`tombstoneAndOwePurge`: owner delete, application delete, federated delete,
  cache eviction, the 30-day purge), application deletion, visibility changes
  (`updateFile`'s `afterUpdate`), the sweep's trash and the owner's trash
  (`file.trashed`), and every return from trash (restore, a re-upload, a new
  reference: `file.restored`). `file.blocked` / `file.unblocked` are in the
  CHECK and the SDK union for stage 4. `fileEventDelivery.worker.ts`
  (every API task, `FILE_EVENT_WEBHOOK_WORKER_ENABLED`, default on) leases
  rows `FOR UPDATE SKIP LOCKED`, reads the endpoint and secret at delivery
  time, POSTs the stored JSON with `oxy-event-id`, `oxy-event-type` and
  `oxy-signature: t=<unix>,v1=<HMAC-SHA256(secret, "<t>.<body>")>`, no
  redirects, 10 s; 2xx acknowledges, anything else backs off 1 min doubling to
  6 h, dead-lettered after 16 attempts; an endpoint removed (or application
  deleted) dead-letters at once. Rows expire 30 days after creation
  (`db/expiry.ts`). SDK: `verifyFileEventSignature(rawBody, headers, secret,
  { toleranceSeconds = 300 })` in `@oxy.so/core/server`.
  `file_references.webhook_url` is no longer read, written or serialized; the
  column stays until a later post migration drops it.
- **Owner trash.** `POST /assets/:id/trash` (the owner's session only; 404
  for anyone else and for a deleted file; idempotent): `active` → `trash`
  with `trashed_at`, off the CDN at once, `file.trashed` to every application
  using it; `POST /:id/restore` brings it back. SDK `assets.trash(id)`. The
  file manager is NOT switched to it: it has a delete flow but no trash view
  to restore from, so trashing there would make files vanish from the
  person's sight while still counting against them; that needed a trash view
  first (stage 4b added it and switched the file manager).
- **Not done / open.** Applications deleted BEFORE this stage keep their
  files (not retroactively purged; a one-off operator run of
  `deleteApplicationContent` per such application would do it). An account's
  hard delete or archive does not send `file.deleted` for the ACCOUNT's own
  files (relying parties get `account.deleted`). An application's file held
  by a mail attachment or a store screenshot is tombstoned and purged with
  the application (the developer asked); on an account hard delete such a
  row still refuses the cascade, as an account's own file always did. The D2
  growth alert is still not built. (Stage 4b closed the first two and the
  growth alert.)

### Stage 4a as built (D10: claims and the takedown)

Migration `0174_content_claims` (pre): six tables, `files.status` gains
`blocked`, `users.staff_capabilities` admits `content:claims`. The drop of
`file_links` moved after it (now `0177_drop_file_links`, post). The two widened
CHECKs are added `NOT VALID` (as 0170 did); the three per-owner live uniques are rebuilt
with `blocked` in their predicate, behind a guard that skips an index already
rebuilt out of band (the header gives the `CONCURRENTLY` route for a large
`files`).

- **The intake.** `POST /content-claims` is public — the Oxy website's
  "Report content" page (OxyHQ/website#173, `src/lib/contentClaims.ts`)
  posts there; a valid bearer records the submitting account, none is needed
  (an unusable bearer is simply anonymous). The body is
  `contentClaimSubmissionSchema` in `@oxy.so/contracts` 4.22.0 (strict; every
  message a key under `contentClaim.errors.*`, which the website translates
  and the API answers as its own English sentence): `201 { id, reference }`
  (`OXY-XXXX-XXXX`, Crockford base32, random), or `400 { error, code:
  CONTENT_CLAIM_INVALID, fields }` with one sentence per body path. Ten an
  hour per network (`hashedIpKey`) and five a day per claimant email (an HMAC
  under its own server key; the address never reaches Redis): 429 with
  `Retry-After`. CORS is the registry's: `oxy.so` is a first-party
  application origin, so nothing was added. The claimant's confirmation, with
  the reference, is queued in the same transaction (below).
- **What a claim stores.** `content_claims` (kind, relationship, state,
  submitting account, `deadline_at`, `closed_at`); `content_claim_claimants`
  — name, email, organization, signature, description and original-work URL,
  each SEALED with `secretBox` (context `content-claim|<id>|<field>`), opened
  only for the reviewer and the email worker. Retention: `expires_at` is set
  when the claim closes, to three years after it (the US limitation period for
  a copyright action, within the EU's range), and the expiry sweep deletes the
  row; every read already treats an expired row as erased. The claim keeps
  its kind, state, targets and trail. A privacy claim by the affected person
  is the GDPR erasure request: `deadline_at` = received + 30 days (a CHECK
  ties it to exactly those), and the queue filters and sorts by it.
- **What a URL names** (`contentClaimUrls.ts`, never fetched — a fetch would
  make the intake an SSRF probe): `cloud.oxy.so/<id>`, the API's `/cdn/<id>`,
  `/assets/<id>` (`/stream`, `/download`, `/url`, with or without `/api`) on
  `api.oxy.so` or the host the claim was posted to, and a stored key
  (`cloud.oxy.so/content/…`, `/variants/…`: the row whose original or
  rendition is that key, else by the SHA-256 in it). Any status resolves —
  the bytes are what matter. Everything else (a Mention post, a Mercaria
  listing) is an `unresolved` target; the reviewer attaches the files it
  shows by id (`source = 'staff'`). A target keeps the bytes' `sha256`: the
  file row can go (`file_id` is `SET NULL`).
- **The review** (`content:claims`, the fourth graded staff capability —
  READING is graded too, since a claim holds the claimant's personal data):
  `GET /content-claims` (`state`, `kind`, `deadline=overdue|due_soon|any`,
  cursor), `GET /:id`, `POST /:id/review`, `/:id/targets { fileIds, url? }`,
  `/:id/block { targetIds?, note? }`, `/:id/reject { reason }`,
  `/:id/counter-notice { note }`, `/:id/reinstate { note? }`,
  `/:id/uphold { note? }`, `/:id/notes { note }`, and `GET /access` →
  `{ canReview }` for the console. States: `received → reviewing → actioned
  | rejected`, `received → rejected`, `actioned → counter_noticed →
  reinstated | upheld`; each transition is a conditional write under the
  claim's row lock (409 `CONTENT_CLAIM_STATE_CONFLICT` naming the state it is
  in). `content_claim_events` is the audit trail — action, actor (no foreign
  key: the trail outlives the account), from/to state, staff's note, details
  — append-only (a trigger refuses an UPDATE).
- **Blocking acts on bytes.** For each chosen target's SHA-256, under the
  content-hash locks every insert of those bytes takes (sorted, one
  transaction): a `blocked_content_hashes (sha256, claim_id)` row, EVERY live
  row holding them — any owner's, `active` or `trash` — set `blocked`
  (`trashed_at` remembers trash), `file.blocked` queued for the owning and
  every referencing application (D9), an email for each owning ACCOUNT, and
  the claimant's "acted on" email the first time. After commit each row
  leaves serving through the stage-2 machinery (`leaveServing`: off
  `public/`, CloudFront invalidated, `/<id>` too); the sweep's
  `unpublishTrashed` step now also retries a `blocked` row left on `public/`,
  and renditions are now spelled by SERVED status like the original (before,
  by visibility alone, so one generated for a trashed public file landed on
  the CDN). `blocked` is live: it keeps its per-owner unique, counts toward
  quota, and keeps its bytes from the purge.
- **The bytes stay out, for everyone.** `fileRepository.insertFile` — the
  one insert of every upload, import and owner copy, always under the
  content-hash lock — refuses a listed hash: 451 `CONTENT_BLOCKED`. Each upload
  path also checks before it spends work or writes an object (the streamed
  path deletes its temp object; a promotion or a re-spelling copy happens
  only after the check), and refuses handing back the owner's own existing
  row of those bytes, which is blocked. `POST /assets/init` takes the
  declared SHA-256 as the content's identity, so it is now required to be hex
  (lowercased), and EVERY presigned PUT carries it as the checksum S3
  enforces — before, outside admitted mode, the bytes behind a declared hash
  were never checked, which would have let an uploader store blocked bytes
  under another hash.
- **Reinstating** (`counter_noticed → reinstated`) removes this claim's
  blocklist rows; bytes no OTHER claim still blocks return to `active` (or
  `trash`), are served again (`enterServing`, back under `public/`), and
  `file.unblocked` and the owners' emails are queued. Upheld blocks stand.
- **Evidence.** Bytes an OPEN claim (`received`, `reviewing`, `actioned`,
  `counter_noticed`) names — a resolved target or a blocked hash — are
  evidence: when their last row is deleted by anyone (the owner, an account's
  or application's deletion, the lifecycle's purge), the storage-deletion
  worker keeps the bare object, still deletes a `public/` copy, and defers the
  ledger row (every 6 hours; not a failure) until the claim closes. The
  reviewer previews any target's bytes, whatever the file's status, on a
  five-minute HMAC token bound to the claim, target, file and reviewer (`POST
  /:id/targets/:targetId/preview` → `GET …/content?pt=`, `no-store`, CSP
  `sandbox`, capability re-checked). A blocked file under an open claim is not
  listed as *not in use*; the lifecycle's new `purgeBlocked` step tombstones
  and purges an APPLICATION's blocked file unused for 30 days once no open
  claim holds it (never through trash, which would serve it on restore). An
  account's blocked file is its person's to delete.
- **Emails** (`content_claim_notifications`, an outbox written in the
  transaction of the change; `contentClaimNotification.worker.ts`, every API
  task, `CONTENT_CLAIM_EMAIL_WORKER_ENABLED`, default on; at least once,
  backoff, dead letter after 12): to the claimant — received, actioned,
  rejected (with the reason), counter-noticed (staff's summary), reinstated,
  upheld; to each owning account — blocked (its files listed), reinstated,
  upheld. No address or content is stored: the claimant's address is opened
  and an account's read at send time, so an erased statement or an account
  without email dead-letters the row. Neither party is named to the other;
  replies go to legal@oxy.so with the reference. The blocked email links the
  owner to the website's counter-notice form with the reference filled in
  (`https://oxy.so/transparency/legal/counter-notice/?reference=<ref>`,
  `contentClaim.mail.counterNoticeUrl`), legal@oxy.so the fallback. Rows
  expire after 90 days.
- **Console.** "Content claims" under a Staff group, shown when `/access`
  says so: the queue (state, kind, deadline filters; overdue in red) and a
  claim's page (the statement or its erasure date, targets with file status
  and owner kind, previews, attaching files, every action behind a
  confirmation that says what it does, the trail). The console's CSP admits
  `https://api.oxy.so` for `img-src`/`media-src`, for the previews.
- **SDK.** `@oxy.so/core` 4.18.0: `Asset.status` gains `blocked`, the live
  service views take `AssetLiveStatus`, uploads and imports document 451
  `CONTENT_BLOCKED`; the file manager shows a blocked file as "Removed after
  a legal claim". `@oxy.so/contracts` 4.22.0 carries the claim contract.
- **Not done here (stage 4b).** The API's file cache is per process for five
  minutes, so another task that cached a file just before it was blocked can
  still stream it for that long (the CDN is invalidated at once); the
  cross-task invalidation is stage 4b, with the other 4b items. An owner's
  counter-notice arrives by email and staff record it; there is no form for
  it. (Stage 4b built both.)

### Stage 4b as built (large uploads, adoption, the open items)

Migrations `0175_file_upload_sessions` and `0176_content_claim_counter_notices`
(both pre); the drop of `file_links` is now `0177_drop_file_links` (post). SDKs:
`@oxy.so/contracts` 4.22.0, `@oxy.so/core` 4.18.0, `@oxy.so/services` 11.9.0
(main took contracts 4.18.0 to 4.21.0, core 4.14.0 to 4.17.0, and services
11.7.0 and 11.8.0 meanwhile).

- **Large, any-type uploads.** `POST /assets/service/app/uploads` (`files:app:write`;
  `files:references:write` for `reference`) `{ sha256, size, mime, visibility,
  filename?, metadata?, reference? }` opens a resumable S3 multipart upload and
  answers `201 { uploadId, status: 'uploading', partSize, partCount, expiresAt,
  parts }` — presigned `UploadPart` URLs (at most an hour, or less if the API
  task role's credentials expire sooner; each SIGNS its part's exact
  Content-Length) for the first 100 parts; `POST …/:uploadId/parts
  { partNumbers }` (≤ 100) for more, `GET …/:uploadId` for the state and the
  parts storage holds, `DELETE …/:uploadId` to abort, `POST
  …/:uploadId/complete` to assemble. Parts are at least 8 MiB (whole MiB, ≤
  10,000 parts); a file is at most 8 GiB (413). The account-owned twin is
  `/assets/service/user-media/uploads` with `/service/user-media`'s authority:
  `x-owner-user-id` on EVERY call, `visibility` defaulting to `public`. An
  upload is its uploader's, for its owner: any other caller gets 404.
  - *Verified, not trusted.* S3 cannot enforce a whole-object SHA-256 on a
    multipart upload (full-object checksums are CRCs; a SHA-256 multipart
    checksum hashes the parts' hashes), and dedupe, shared storage and the
    blocklist all trust the hash — so `complete` moves the session to
    `verifying` and the API streams the assembled object back and hashes it.
    Only a match becomes a file (`AssetService.finalizeLargeUpload`, under the
    content-hash lock with the blocklist re-checked): the owner's existing row
    of those bytes (deduplicated), else a row sharing another owner's object in
    the spelling its visibility needs, else the upload's own object. Anything
    else fails the session and deletes its object: 422 `CHECKSUM_MISMATCH` /
    `SIZE_MISMATCH`, 451 `CONTENT_BLOCKED` (blocked while uploading), 410
    `OWNER_GONE` / `EXPIRED` / `ABORTED`. `complete` waits up to
    `LARGE_UPLOAD_COMPLETE_WAIT_MS` (20 s) and otherwise answers `202
    verifying`; `fileUploadSession.worker.ts` (every task,
    `FILE_UPLOAD_WORKER_ENABLED` default on, `FILE_UPLOAD_WORKER_INTERVAL_MS`
    30 s) takes over under a lease sized to read the file at 16 MiB/s (a dead
    verifier's lease expires; five attempts), and aborts `uploading` sessions a
    day after their last part-URL request (a week at most).
  - *Never on the CDN unverified.* Parts assemble at a key of the session's own
    (`content/…/<sha>-<random><ext>`), always in the PRIVATE spelling; a public
    file is copied to `public/` only once verified. `copyFile` now copies an
    object over 5 GiB by `UploadPartCopy` ranges (size-hinted, or after S3
    refuses the single copy), so a large file's visibility can change.
  - *Refused at open, before any byte:* executables, installers and active
    documents — HTML, XHTML, SVG, XML/XSL, scripts, Windows/Unix programs,
    APK/DMG/DEB/RPM/JAR… — by type AND by the name's extension
    (`utils/fileContentPolicy.ts`, 415); blocked bytes (451); a third-party
    application's full plan (413 `STORAGE_QUOTA_EXCEEDED`, D3): with storage
    admission on, the whole file is reserved against its developer's plan at
    the key the row will name, and released when the upload does not become
    that row (`releaseTerminalMultipartReservation` — the multipart upload's
    own terminal state is the proof a single presigned PUT cannot give). Bytes
    the owner already holds answer at once (`uploadId: null`, `completed`,
    `deduplicated`); the same bytes reopened answer the open session (resume).
  - *How a file is served.* Only media a browser renders without running
    anything — raster images, audio, video, PDF, plain text — is inline. The
    large upload stores `Content-Disposition: attachment` on every other
    object (S3 and so CloudFront replay it), and `/assets/:id/stream` sends
    `attachment` plus `Content-Security-Policy: sandbox` for every file that is
    not inline-safe, whichever path stored it (a mail attachment included).
  - *Renditions* as before for images and videos (PDFs keep the placeholder
    thumbnail); an image over 100 MiB gets none (Sharp reads the original into
    memory) and is served as stored.
  - SDK: `OxyServer.assets.uploadAppFileLarge(source, { mime, visibility, … })`
    and `uploadUserMediaLarge(ownerUserId, source, …)` — a `Blob`, bytes or a
    file path; hashed 8 MiB at a time; parts sent `partConcurrency` (4) at a
    time, each retried, an expired URL refreshed; polls `verifying`; calling
    again for the same bytes resumes. `abortAppFileUpload` /
    `abortUserMediaUpload`; `LargeUploadFailedError`.
- **Adopting a file.** `POST /assets/service/app/adopt { fileId, visibility,
  reference? }` (`files:app:write`) gives the calling application its OWN row of
  the bytes a file it can read holds, sharing the stored object (a server-side
  copy only when the key spelling its visibility needs does not exist; with
  admission on and a third-party application, reserved first). Readable is
  `mayApplicationReference`: any owner's active `public`/`unlisted` file, a
  person's private file its OWNER attached to this application (ADR 0021 — a
  creator-less service reference is not that grant), the application's own
  (answered as it is). The copy may not be more visible than the source (400
  `VISIBILITY_WIDER_THAN_SOURCE`); anything else is 404, blocked bytes 451;
  idempotent per (application, bytes). Answer `{ file, outcome: 'adopted' |
  'existing', deduplicated, reference? }`; metadata `adoptedFromFileId`. SDK
  `OxyServer.assets.adoptAppFile`.
- **The owner's reference over an application's twin.**
  `fileRepository.addFileReferences` fills the creator of an EXISTING
  creator-less reference (one an application made with its service token) when
  the call names the file's owning account as creator — one conditional
  `UPDATE … WHERE created_by_user_id IS NULL AND <creator owns the file>`
  under the file-row lock. Only the owner's session (`POST /assets/:id/links`)
  sends a creator; a person's creator is never replaced, and a non-owner named
  as creator changes nothing. Before, Nilo registering its use and then the
  person attaching the same file from inside Nilo left the reference
  creator-less, so `/service/linked-url` never admitted Nilo; both orders now
  end in the same owner-made reference.
- **Profile media references.** `PUT /users/me` keeps the avatar referenced by
  Oxy Accounts — the shape `assets.uploadAvatar` always wrote (application Oxy
  Accounts, entity type `avatar`, entity id the account), created BY the
  account — in the profile write's transaction under the account row lock
  (`profileMediaReferences.service.ts`): exactly the new avatar, only when it
  is the account's own non-deleted file; every other `avatar` reference of the
  account goes (the replaced or cleared one becomes *not in use*, never
  trashed). `users` has no banner or cover column, so the avatar is the only
  profile media. `scripts/reconcile-profile-media-references.ts` (preview by
  default, `--apply`; `--batch-size`, `--after`, `--max-batches`, `--sample`;
  a fixed number of statements per batch; idempotent)
  backfills profiles set before this stage and the other avatar writers (the
  organization directory, account creation), and removes references naming
  accounts that no longer exist.
- **D2 growth observation.** Every lifecycle sweep run, in either mode, measures
  each application owning files (`applicationStorageObservation.ts`, from
  `files` alone): stored files and bytes (live rows plus renditions, as the
  quota counts) and the files and bytes created in the last 24 hours against
  the per-day average of the 7 days before. Anomalous: at least
  `FILE_STORAGE_GROWTH_DAILY_CAP_BYTES` (50 GiB) in a day, or more than
  `FILE_STORAGE_GROWTH_MULTIPLE` (5) times the trailing average and at least
  `FILE_STORAGE_GROWTH_MIN_BYTES` (1 GiB) or `FILE_STORAGE_GROWTH_MIN_FILES`
  (10,000) files. EMF namespace `Oxy/FileStorage`: per application (dimension
  `ApplicationId`, at most `FILE_STORAGE_METRICS_MAX_APPLICATIONS` = 100,
  anomalies first) `StoredBytes`, `StoredFiles`, `BytesAdded24h`,
  `FilesAdded24h`, `TrailingDailyBytes`, `GrowthAnomaly`; one platform line
  (no dimension) `ApplicationsWithFiles`, `TotalStoredBytes`,
  `TotalBytesAdded24h`, `ApplicationGrowthAnomalies`; each anomaly is also an
  ERROR log line `[FileStorage] Application storage growth anomaly` naming the
  application. The alarm lives in oxy-infra (runbook below). The measurement
  rides the sweep's lease and schedule (`FILE_LIFECYCLE_MODE=off` stops it).
- **Applications deleted before D8.** The sweep's first step,
  `deletedApplications`, finds every `deleted` application that still owns a
  live file or holds a reference and, in `enforce`, runs D8's own
  `deleteApplicationContent` on it under its row lock (re-checking `deleted`),
  at most 10 per run, oldest first: every owned file tombstoned without trash
  (blocked and trashed included; evidence still deferred), purge owed, every
  reference removed (an account's file becomes *not in use*), `file.deleted`
  to the other applications using its files. `report` counts and names them
  and changes nothing; idempotent. Metrics `deletedApplicationsDue`,
  `deletedApplicationsActed`, `deletedApplicationsFailed` on
  `Oxy/FileLifecycle`.
- **Account deletion events.** The hard delete, the personal archive and the
  organization archive queue `file.deleted` for every live file the ACCOUNT
  owns (beside `account.deleted`), in `recordAccountStorageDeletion` inside
  their transaction, with stage 3's payload rules (`ownerKind: 'account'`,
  each application's own references only, verified endpoints only, never a
  deleted application — the account's own applications, deleted first in the
  same transaction, get nothing). A refused deletion tells nobody.
- **The file manager's trash.** `GET /assets` is the owner's library (`active`
  and `blocked`) and no longer lists trash; `GET /assets?status=trash` lists
  it, most recently trashed first. `POST /assets/:id/restore` of a file not in
  trash is 409 `FILE_NOT_IN_TRASH` (it was a 500). `@oxy.so/services`: "delete"
  moves to trash (`oxy.assets.trash`), saying it can be restored; a `FileTrash`
  route lists the trash, restores, and deletes permanently behind a
  confirmation (asking again when applications still use the file); a blocked
  file, which cannot be trashed, is still deleted for good. Every string in
  all eleven locales. Core: `assets.list({ status: 'trash' })`,
  `FileMetadata.trashedAt`.
- **Cross-task file cache.** `fileCache.invalidate` / `invalidateMany` drop
  the local copy and publish the ids on Redis (`oxy:file-cache:invalidate`,
  `{ v: 1, origin, fileIds }`), the `userCache` pattern; every task's
  subscriber drops a peer's ids locally only. Every status and visibility
  transition ends there after its commit (`cacheFile`, `enterServing`,
  `leaveServing`, `tombstoneAndOwePurge`, application and account deletion,
  and the repository writers that own their transaction);
  `fileCacheWriters.census.test.ts` fails on a new `files` writer until it is
  reviewed. A read in flight across an invalidation is answered but not cached
  (`setIfFresh`). Without Redis it is local, with the five-minute TTL.
- **`@oxy.so/services` peers.** Core is peered `^4.18.0` (the root catalog; the
  exact pin was a leftover of the Oxy One prerelease) and contracts is a caret
  dependency, so a later 4.x minor no longer conflicts with a published
  services or nests a second core; core 5 stays refused.
- **Seed scopes (D11).** The seed grants Nilo `files:references:write`; Mention
  `files:app:write` and `files:references:write`; Moovo `files:read`,
  `files:references:write`, `files:app:write`; Peable and CrowdSource
  `files:read`, `files:references:write`; Syra, Alia and Homiio `files:read`,
  `files:app:write`, `files:app:delete`, `files:references:write`,
  `files:user-media:write`; the Oxy website the first four. Mercaria's and
  GoWay's were already there. Clarity is not a seed application — the native
  product-agent bootstrap reconciles its two applications byte for byte — so
  its backend declares `fileScopes`, which the bootstrap grants as a reviewed
  addition to the row and its live workload binding. Every seeded application
  is `first_party` or `internal`, which `isTrustedApplication` turns into
  internal-tier service tokens; a census pins each adopting application's exact
  `files:*` set and tier.
- **The owner's counter-notice (D10, 17 U.S.C. § 512(g)).** `POST
  /content-claims/counter-notices` (signed in; `contentClaimCounterNoticeSchema`
  in contracts 4.22.0, messages under `contentClaim.counterNotice.errors.*`)
  names the claim by `reference`, `claimId` or `fileIds` and answers only for
  files the caller (or the person operating the session) owns that are
  `blocked` with bytes on that claim's blocklist — anything else is 404, like
  no claim; two claims with none named is 400 `…_AMBIGUOUS`. The statements —
  good-faith belief of mistake or misidentification under penalty of perjury,
  consent to the jurisdiction of the federal district court (or, outside the
  US, any district where Oxy may be found), accepting service of process from
  the claimant, the disclosure to the claimant — must each be `true`, with a
  signature. Under the claim's row lock the claim moves `actioned →
  counter_noticed` (another owner's notice on a counter-noticed claim is
  recorded without a state change; any other state 409; a second notice by the
  same account 409 `…_EXISTS`). `content_claim_counter_notices` seals the
  personal data (`secretBox`, context `content-claim-counter-notice|<id>|<field>`),
  keeps the statement version and the files, and is erased on the claimant's
  clock (three years after the claim closes). The trail records
  `counter_notice_submitted` with the owner as actor; staff read the notices on
  the claim (`counterNotices`) and on the console's claim page. Emails (the
  outbox, recipient `staff` new): the claimant's copy — the notice itself for a
  copyright claim, as § 512(g)(2)(B) requires (with the 10–14 business-day
  window), otherwise only that it is disputed; the owner's confirmation; an
  alert with no personal data to `CONTENT_CLAIM_STAFF_EMAIL` (default
  legal@oxy.so). Ten an hour per network, five a day per account. SDK
  `oxy.contentClaims.submitCounterNotice`.

### Stage 4c as built (consent, streaming, audio, recordings, large imports, SVG)

What Syra, Alia and Homiio still needed to leave their own buckets. It ships
as a second release, after stages 1–4b (#1764). Migration
`0180_file_access_streams_ingests` (pre): three new tables, nothing existing
changes; it sits behind `0177_drop_file_links` (post), which #1764's deploy
already applied, and main's `0178_ecosystem_invitations_and_billing` and
`0179_application_agents_and_app_assertions` (pre). SDKs: `@oxy.so/core`
4.21.0 and `@oxy.so/services` 11.12.0 (#1721 and #1770 took 4.19.0/11.10.0
and 4.20.0/11.11.0 meanwhile); `@oxy.so/contracts` has nothing new and stays
4.24.0.

- **A person's private media from a service.** `POST
  /assets/service/user-media` takes `x-visibility` (`public` default |
  `unlisted` | `private`) like the import and large-upload twins already did;
  a private file is stored in the private spelling and never reaches
  `public/` or the CDN. The streamed service uploads (`/service/user-media`,
  `/service/app`) and the imports admit audio as well as images and video
  (SVG sanitized, below). The answer gains `deduplicated`. SDK:
  `uploadUserMedia(owner, bytes, mime, { visibility })`.
- **Consent for an application to read a person's file** (`file_access_grants`,
  refining D4 and ADR 0021). A person's file is readable through a service
  token (`/service/linked-url`, a play session, adopting or referencing a
  private file) only with that person's consent, which has exactly two
  origins: the application stored the file FOR the person — any
  `/service/user-media` upload, import, large upload or recording, which needs
  the staff-granted act-as scope `files:user-media:write` — and a `granted`
  row (`source = 'upload'`) is written when it is stored (also when the person
  already held the bytes); or the person attached the file to the application
  (an owner-made reference, no row). The owner revokes an application with
  `DELETE /assets/:id/access/:applicationId`: the row becomes `revoked`, which
  beats BOTH origins, ends every play session that application holds for the
  file, and survives the application uploading the same bytes again; the
  person attaching the file to it again (`POST /assets/:id/links`) is a new
  consent and lifts it (`source = 'owner'`). References are kept: they record
  USE, not access. `GET /assets/:id/access` lists `{ applicationId, name,
  icon, via: ('upload' | 'link')[], since }` for the owner (404 for anyone
  else). Both are reviewed own-file operations (`ownAssetAuth`, like trash
  and restore), so a supervised account (ADR 0041) can see and withdraw
  access to its own file: it only narrows who reads it. The predicate is `fileReference.service.applicationReadConsent`
  over the file aggregate, which now carries its grant rows
  (`FileRecord.accessGrants`); every grant write invalidates the file across
  tasks. `files:linked:read` stays self-service: alone it still reaches
  nothing a person did not attach or a privileged act-as did not store
  (`utils/applicationScopes.ts`). The seed adds it to Syra, Alia and Homiio.
  Core: `oxy.assets.listAppAccess` / `revokeAppAccess`; the file manager's
  file details show "Apps with access" with a confirmed Revoke, in all eleven
  locales.
- **Audio renditions** (`variantService.generateAudioVariants`,
  `audioRenditions.ts`), eager through the asset-variants queue for mp3,
  m4a/AAC, ogg/opus, wav and flac: an audio-only HLS ladder of AAC-LC rungs
  `hls_a64` / `hls_a128` / `hls_a256` (48 kHz, at most stereo, cover art
  dropped, 6 s mpegts segments, VOD) — the 64k rung always, a higher one only
  for a lossless source, an unknown bitrate, or at least 0.75× the rung — under
  an `hls_master` with measured `BANDWIDTH`/`AVERAGE-BANDWIDTH` and
  `CODECS="mp4a.40.2"` (the same type as video, so `/service/by-ids`'s
  `hlsReadyAt` works); a `waveform` (`waveform.json`, the audiowaveform JSON
  format, int8, ~2,000 buckets, decoded at 8 kHz mono through a pipe — bounded
  memory); and a 30-second `preview` (AAC 128k fragmented m4a, from
  `previewStartSeconds` clamped so 30 s fit, the whole of a shorter file, a
  2 s fade-out when cut). Optional EBU R128 loudness normalization
  (`loudnorm` I=-16, TP=-1.5, LRA=11) for the ladder, waveform and preview is
  asked per file with `x-audio-options` / `audio: { normalizeLoudness,
  previewStartSeconds }` and stored as the server-owned
  `metadata.audioOptions` (a caller's free-form metadata cannot set it); a
  normalized set lives under `<sha>/ln/`, and a content twin's renditions are
  reused only by a row with the same audio profile. Every ffmpeg pass gets a
  fresh presigned URL, a protocol whitelist and a SIGKILL deadline of
  max(120 s, 2× duration); one rung failing keeps the others, a ladder with
  every rung failed fails the job after committing what encoded. Nothing
  audio is encoded on a request (`ensureVariant` serves only what is ready).
  `metadata.audio` records duration, codec, sample rate, channels, bitrate.
- **Play sessions — per-play, revocable streaming** (`file_play_sessions`,
  `playSession.service.ts`, `hlsStreamServing.ts`). `POST
  /assets/service/streams { fileId, endUserId?, ttlSeconds? (60–43200,
  default 3600), encryption? ('aes-128' default | 'none'), keyAuthorization?
  ('none' default | 'webhook') }` by an application that owns the file or may
  read it (`files:linked:read` for a person's file; 404 otherwise; 409
  `STREAM_NOT_READY` without a ladder) answers `201 { sessionId, fileId, kind,
  status, encryption, keyAuthorization, endUserId, expiresAt, masterUrl,
  renditions: [{ type, url, bandwidth }], previewUrl?, waveformUrl? }` — URLs
  under `/assets/streams/<sessionId>.<secret>/`, shown once (only the
  secret's SHA-256 is stored). `GET`/`DELETE /assets/service/streams/:id`,
  `POST /assets/service/streams/revoke { fileId?, endUserId? }`. Serving
  mirrors the ladder's directory, so a player's relative URIs resolve back
  here and only names the ladder lists are served (`master.m3u8`, its
  renditions, the segments a rendition lists, `key`, `preview.m4a`,
  `waveform.json`). EVERY request re-checks the session (secret, not revoked,
  not expired, application `active`), the file (`active`) and the
  application's consent — anything else is 404 `PLAY_SESSION_INVALID` — so
  `DELETE`, the owner's revocation, the file leaving `active` (trash, block,
  delete) or the application's deletion stops the next segment. A session is
  cached per task for 30 s and the cache rides stage 4b's cross-task
  file-cache channel (`fileCache.onInvalidate`): every revocation ends with
  `fileCache.invalidate(fileId)`, which drops that file's sessions on every
  task. **AES-128**: each session has its own random content key (sealed,
  `play-session-key|<id>`); rendition playlists get `#EXT-X-KEY:METHOD=AES-128,
  URI="key"` before the first segment and segments are AES-128-CBC encrypted
  as they are served (PKCS#7, IV = media sequence number, RFC 8216 §5.2) —
  the stored ladder stays in clear and one ladder serves every session. The
  key is `no-store`. **Key authorization under product control**: with
  `keyAuthorization: 'webhook'` (409 `FILES_WEBHOOK_REQUIRED` without one) the
  key is released only after the application's verified file-events endpoint
  answers a synchronous, signed request — `{ id, type:
  'stream.key_authorization', occurredAt, session: { id, fileId, endUserId,
  expiresAt } }` with `oxy-event-id`, `oxy-event-type`, `oxy-signature` exactly
  as file events — with a 2xx `{ "allow": true }` within 3 s; an allow is
  reused for 60 s per session, anything else (an error, a timeout, a
  non-2xx) is 403 `KEY_AUTHORIZATION_DENIED`, fail closed. The URLs are
  bearer capabilities: CORS `*` without credentials, `Referrer-Policy:
  no-referrer`, `nosniff`. `endUserId` (an Oxy account) is recorded, handed to
  the key-authorization check and is the handle of bulk revocation; it does
  not bind the URLs to a signed-in viewer. Core: `server.assets.streams.create
  / get / revoke / revokeWhere` and `verifyStreamKeyAuthorization(rawBody,
  headers, secret)` in `@oxy.so/core/server`.
- **A rendition allow-list per session** (migration
  `0182_play_session_renditions`, pre: one nullable `text[]` column and its
  CHECK; core 5.3.0). A product that caps quality per listener (Syra's free
  tier and data saver) opens the session with `renditions` — a non-empty
  subset of `hls_a64 | hls_a128 | hls_a256 | hls_360p | hls_720p | hls_1080p`,
  stored distinct in ladder order (`file_play_sessions.renditions`; NULL, the
  default, is the whole ladder and behaves exactly as before). Enforced on the
  serving route, not by omission: the master is rewritten to list only the
  allowed rungs (`restrictedMasterPlaylist`: each `#EXT-X-STREAM-INF` with its
  URI, a tag naming a disallowed URI dropped), and `resolveStreamObject`
  resolves a disallowed rung's playlist, segments and key to nothing (404).
  Such a session's segments are encrypted under a key PER RUNG, HKDF-SHA256 of
  the session's key bound to the rung (`renditionContentKey`), served at
  `<rung>.key` and named by that rung's playlist; the session's own `key` is
  404 for it, so no key it hands out opens another rung. A rung the file lacks
  is simply not served (an allow-list); none of the listed rungs ready is 409
  `STREAM_RENDITIONS_NOT_READY`. The answer's `renditions` are the allowed
  ready rungs and `allowedRenditions` echoes the list (also on `GET`).
  Revocation, consent and key authorization are unchanged.
- **Recording targets — LiveKit egress into Oxy Files** (`file_ingests`,
  `source = 'recording'`; `recordingIngest.ts`, `utils/sigv4.ts`,
  `utils/awsChunked.ts`). `POST /assets/service/app/recording-targets` (or the
  account-owned `/assets/service/user-media/recording-targets` with
  `x-owner-user-id`, private by default) `{ visibility, filename?, metadata?,
  reference?, maxBytes? (≤ 8 GiB), expiresInSeconds? (60–604800, default a
  day), audio? }` answers `201 { targetId, status: 'awaiting_upload',
  expiresAt, filepath, s3: { accessKey, secret, region, endpoint, bucket,
  forcePathStyle }, livekit: { filepath, s3: { access_key, secret, region,
  endpoint, bucket, force_path_style } } }` — `livekit` is exactly an
  `EncodedFileOutput`'s `filepath` and `S3Upload` (LiveKit's `livekit/storage`
  speaks the AWS SDK for Go v2 upload manager: `PutObject` below 5 MiB,
  `CreateMultipartUpload` / `UploadPart` / `CompleteMultipartUpload` above;
  with a custom endpoint it computes checksums only when required, and it
  uploads its JSON manifest beside the file after it). The endpoint is Oxy's
  own S3-compatible ingest, `/assets/recording-ingest`, path-style: SigV4
  (header-signed, any region, ±15 min) against the target's secret (sealed,
  `file-ingest-secret|<id>`; the access key is the target id); a hex,
  `UNSIGNED-PAYLOAD` or `STREAMING-UNSIGNED-PAYLOAD-TRAILER` (aws-chunked)
  payload, a hex hash verified against the body; signed streaming chunks are
  `NotImplemented`. Only the target's prefix, ONE recording (audio or video,
  from its type or extension) and side objects of at most 1 MiB, which are
  discarded; only uploads — any other call answers S3's XML error (`AccessDenied`,
  `InvalidAccessKeyId` for an unknown, failed, aborted or expired target or a
  suspended/deleted application, `SignatureDoesNotMatch`, `EntityTooLarge`,
  `NotImplemented`…). Bytes stream straight to a private staging key (a part
  to the backing multipart upload's part, `PutObject` hashed on the way);
  once the object is complete Oxy hashes it (multipart) and finalizes it
  through `finalizeLargeUpload` — dedupe, blocklist, a metered owner's plan
  (`insertFile`), the public copy only after verification — with the asked-for
  reference and, for a person, the creator's access grant. `GET …/:targetId`,
  `POST …/:targetId/complete` (200 with the file, 202 `verifying`, 409
  `RECORDING_NOT_RECEIVED`, a failed target's own error), `DELETE` to abort.
  The endpoint is exempt from the per-address browser limiters and carries
  its own (20,000 per address and 5,000 per target per 15 min) and the
  upload's 5-minute request timeout; no global body parser reads it. Not STS
  credentials: a LiveKit egress uploads a file output when the recording ENDS,
  hours after the target was made, and an API task can only mint chained-role
  credentials that live one hour. Core: `createAppRecordingTarget`,
  `createUserRecordingTarget`, `getRecordingTarget`, `completeRecordingTarget`
  (polls `verifying`), `abortRecordingTarget`.
- **Large imports by URL** (`file_ingests`, `source = 'import'`). A source
  that declares more than 40 MiB (up to 8 GiB; above that 413 before a byte
  is read), or audio/video that declares no size, is not stored in the
  request: the import routes answer `202 { importId, status: 'importing',
  source: { host } }` (a batch item `{ ok: true, pending: true, importId, … }`)
  and the already-open response is streamed in the background — the same
  SSRF-safe, https-only, credential-less fetch — to a private staging object
  by S3 multipart, hashed on the way, at most an hour in all
  (`LARGE_IMPORT_TOTAL_TIMEOUT_MS`) and a minute without bytes, and exactly the
  declared length; then finalized like a recording, with the reference, the
  grant and the `file_sources` row (once-per-URL memory, URL sealed). `GET
  /assets/service/{app,user-media}/imports/:importId` → `{ importId, status:
  'importing' | 'verifying' | 'completed' | 'failed', source, file?, outcome,
  deduplicated, reference?, error? }`. A fetcher that died (its task, a
  transient error) is resumed by the upload worker, which fetches the source
  again under a lease, five attempts at most. SDK `importAppFile`,
  `importUserMedia`, `importAppFiles` poll a pending import and resolve to the
  usual import result.
- **The ingest worker** is the large-upload worker
  (`fileUploadSession.worker.ts`, `FILE_UPLOAD_WORKER_ENABLED`): each tick it
  also verifies what is due, resumes stalled imports and aborts expired
  targets and imports (deleting their staging objects and aborting their
  multipart uploads). Finished ingests are kept a week (`db/expiry.ts`).
- **Safe SVG** (the coordinator's item 9). `image/svg+xml` is accepted on every
  path that reads the bytes — the streamed service uploads, `/assets/upload`,
  the imports, the cache and federation, stickers, and the multipart service
  upload (≤ 5 MiB, sanitized after the declared hash verifies) — and stored
  ONLY as its sanitized document (`utils/svgSanitizer.ts`, DOMPurify 3.4.16
  over jsdom): ≤ 5 MiB, UTF-8 only (svgz refused), DOCTYPE, entities,
  processing instructions and comments removed before parsing (no entity is
  ever expanded), a well-formed XML document with an SVG-namespace root or 415
  `INVALID_SVG`; only SVG-namespace elements (foreignObject and every other
  namespace go with their subtree); DOMPurify's svg + svgFilters allow-list;
  `href`/`xlink:href` only as `#id`; no `on*`, `xml:base`, or animation that
  targets href, a handler or style; in CSS (style elements and attributes,
  escapes resolved) no `@import`, every non-fragment `url()` and image
  function becomes `none`, no `expression(`, `javascript:`, `-moz-binding`,
  `behavior:`. Deterministic and idempotent, so the stored hash is the
  SANITIZED bytes' and dedupes on them; the original's hash is
  `metadata.svg.originalSha256` (server-owned, a caller's copy is dropped).
  Served inline with `Content-Type: image/svg+xml`, `Content-Security-Policy:
  default-src 'none'; style-src 'unsafe-inline'; sandbox` and `nosniff` (an
  `<img>` never runs script; a direct navigation is a sandboxed, fetch-less
  document); an SVG Oxy did not sanitize (a mail attachment, kept byte for
  byte) stays a sandboxed download. Raster renditions (the webp ladder) are
  rendered from the sanitized SVG at the density that draws it at the
  rendition's width (≤ 2,400 dpi, ≤ 64 M pixels). `POST /assets/init` refuses
  SVG (415 `SVG_UPLOAD_REQUIRES_SANITIZATION`): its presigned PUT stores
  bytes the API never reads; the SDK's `uploadLarge` sends an SVG through
  `upload()` instead.
- **Application deletion (D8)** also revokes the application's play sessions
  and expires the imports and recording targets it created, in the same
  transaction.
- **Rate limits.** `/assets/streams/*` and `/assets/recording-ingest/*` are
  capability URLs paced by machines (a player fetches a segment every few
  seconds; many listeners share an address): they skip `rl:general` and the
  slowDown penalty (`isCapabilityUrlPath`) and carry their own limiters
  instead — the stream objects 60,000 per address per 15 min and 600 per
  session per minute.

### Required changes in other repositories (stage 4c)

- **Syra** (TODO(oxy-4b)): podcast and music audio into Oxy Files — the
  catalogue's as Syra application files, a person's uploads with
  `uploadUserMedia(owner, …, { visibility: 'private' })` or
  `importUserMedia` for an enclosure (large ones are imported in the
  background; the SDK waits); playback through `server.assets.streams.create`
  (AES-128, `endUserId` the listener, `keyAuthorization: 'webhook'` where a
  play needs Syra's entitlement check, answering `stream.key_authorization`
  on its file-events endpoint after `verifyStreamKeyAuthorization`;
  `renditions: ['hls_a64', 'hls_a128']` for a listener capped below 256 kb/s,
  core 5.3.0); the
  waveform and preview URLs for its UI; `revokeWhere({ endUserId })` when a
  subscription ends.
- **Alia**: a person's chat attachments with `uploadUserMedia(…, { visibility:
  'private' })` and read back with `linkedDownloadUrls` (the seed now grants
  `files:linked:read`); LiveKit room recordings into
  `createUserRecordingTarget` (or `createAppRecordingTarget`) — pass
  `target.livekit` as the egress `EncodedFileOutput`'s `filepath` and `s3`, then
  `completeRecordingTarget`.
- **Homiio**: private documents a person uploads, read back with
  `linkedDownloadUrls` (`files:linked:read` in the seed).
- **Every product with a file-events endpoint** that opens sessions with key
  authorization answers `stream.key_authorization` with `{ "allow": … }`
  within 3 s (and ignores the type otherwise).
- **The website and Clarity** may now upload SVG logos, icons and favicons;
  the stored file is the sanitized document.

### Required changes in other repositories (stage 4b)

- **Mercaria** (digital deliverables) and **Mention / CrowdSource** (evidence)
  switch to `OxyServer.assets.adoptAppFile` where they keep a durable copy of a
  person's file; products storing non-media or files over 40 MiB use
  `uploadAppFileLarge` / `uploadUserMediaLarge`.
- **Apps calling `oxy.assets.list()`** that relied on seeing trashed files pass
  `status: 'trash'`.
- **Products with a file-events endpoint** expect `file.deleted` with
  `ownerKind: 'account'` when an account is deleted or archived.
- **The website** adds the counter-notice page: it posts through
  `oxy.contentClaims.submitCounterNotice`, validates with
  `contentClaimCounterNoticeSchema`, shows `COUNTER_NOTICE_STATEMENTS` word for
  word and translates `contentClaim.counterNotice.errors.*`; the
  `content_blocked` email then links to it.
- **oxy-infra** (OxyHQ/oxy-infra#316): the growth alarm, and a viewer-response
  CloudFront Function on the four S3-backed behaviours of `cloud.oxy.so`
  (`*.m3u8`, `/content/*`, `/variants/*`, `/oxy-website/*` — the default
  behaviour only serves the API's redirects and 404s) that sends, on a 2xx
  whose Content-Type is not inline-safe (image/* except SVG, audio/*, video/*,
  HLS playlists, application/pdf, text/plain), `Content-Disposition:
  attachment` (an existing `attachment; filename=…` is kept) and
  `Content-Security-Policy: sandbox; default-src 'none'`, serves a sanitized
  SVG inline under its own CSP (stage 4c), and leaves 304s untouched — the CDN
  half of the serving rule above, for objects stored before stage 4b or by
  paths that do not set the disposition (runbook below).

### Required changes in other repositories (stage 4a)

- **The website** (OxyHQ/website#173): nothing to change for the contract —
  its client already matches. When `@oxy.so/contracts` 4.22.0 is published it
  can replace its local schema with `contentClaimSubmissionSchema` (same keys)
  and import `CONTENT_CLAIM_LIMITS`, `CONTENT_CLAIM_KINDS` and
  `CLAIMANT_RELATIONSHIPS` from `@oxy.so/contracts/client`.
- **Every product that registered a file-events endpoint** handles
  `file.blocked` (hide or replace what it shows; the file is not served) and
  `file.unblocked`. A product uploading user content handles 451
  `CONTENT_BLOCKED`.
- **Operations:** grant `content:claims` (with `is_staff`) to the people who
  review claims; make sure legal@oxy.so reaches them.

### Required changes in other repositories (stage 3)

- **Every product that imports by URL** (Mercaria's catalogue importer and
  connectors, Moovo, Mention's upload-from-URL, Homiio, Syra, the
  website) can drop its own fetcher for `OxyServer.assets.importAppFile` /
  `importAppFiles` (application-owned) or `importUserMedia` (a person's),
  passing `reference` so the file is used from the start.
- **A product that wants to react to takedowns or deletions** registers a
  file-events endpoint (console → Webhooks → File events, or
  `oxy.apps.setFilesWebhook`), stores the secret, verifies with
  `verifyFileEventSignature`, and answers the challenge.
- **Callers of `oxy.apps.delete`** pass `{ confirmName }` (`@oxy.so/core`
  4.18.0); the console does.

### Required changes in other repositories (stage 2)

- **Every product that registers references** (Mercaria, GoWay first) runs
  `OxyServer.assets.references.reconcile` once per entity type before the
  sweep is switched to `enforce`, and then on a schedule: an application file
  its product uses but never referenced reads as unused and would be trashed
  24 hours after enforcement starts. The seed now grants GoWay
  `files:references:write`; run `seed:oxy-applications` for it to take effect.
- **A product that showed a trashed file** (a link removed, the file kept
  being displayed) now gets a 404 / placeholder for it: trash is not served.
- **SDK consumers** take `@oxy.so/core` 4.18.0 for `references.reconcile`,
  `Asset.inUse` and `assets.list({ inUse })`; nothing else changes shape.

## Release runbook

Two releases. Stages 1–4b shipped in #1764 (`d2cb538bd`): its deploy
applied `0170`–`0176` before the rollout and `0177_drop_file_links` after it,
and `@oxy.so/contracts` 4.22.0, `@oxy.so/core` 4.18.0 and `@oxy.so/services`
11.9.0 are published. Stage 4c is the second release: steps 1 and 4 are done
for 1–4b and step 1 has one new migration; every other step names what 4c
adds. In order; each step names how to know it worked before the next.

1. **Pre migrations** (`deploy-aws.yml` applies phase `pre` before its
   rollout; `run-postgres-migrations.yml` by hand). Stages 1–4b (done):
   `0170_application_owned_files` … `0176_content_claim_counter_notices`.
   Stage 4c: `0180_file_access_streams_ingests` (after main's `0178` and `0179`). The `pre` phase
   refuses to apply it while `0177_drop_file_links` (post) is still pending —
   the ledger is a high-water mark — so first confirm `0177` is applied. For
   1–4b, first run `bun run packages/api/scripts/file-references-preflight.ts`
   against production (read-only): every legacy `file_links.app` value must
   resolve, or `0171` fails by design. For a large `files`, build the indexes
   `0170` and `0174` create `CONCURRENTLY` out of band first (their headers
   give the statements; the migrations skip an index that already exists and
   is valid). *Verify:* for 1–4b the migrator reported the seven applied and
   `select count(*) from file_references` equalled the `file_links` rows it
   copied; for 4c it reports `0180` applied, and `file_access_grants`,
   `file_play_sessions` and `file_ingests` exist and are empty.
2. **IAM and the bucket** (oxy-infra, before the API deploys): the `oxy-api`
   task role needs `s3:ListMultipartUploadParts` and `s3:AbortMultipartUpload`
   on the media bucket (the large upload's resume and abort, and the recording
   ingest's completion and abort; `UploadPart` and `CreateMultipartUpload` are
   `s3:PutObject`, which it holds). The bucket keeps its lifecycle rule
   `AbortIncompleteMultipartUpload` after 10 days — the backstop for a
   multipart upload no worker aborted. *Verify:* the role's policy lists both
   actions; the lifecycle rule is on the bucket.
3. **API** (`deploy-aws.yml`). The image serves both tables during the rollout
   (the `file_links` mirror trigger); the post migration `0177_drop_file_links`
   runs after the rollout completes (1–4b; 4c's release has no post
   migration). New env vars all have defaults:
   `FILE_LIFECYCLE_MODE` (`report`), `FILE_UPLOAD_WORKER_ENABLED` (also runs
   the stage-4c ingests), `LARGE_UPLOAD_COMPLETE_WAIT_MS` (also a recording's
   `complete`), `LARGE_IMPORT_TOTAL_TIMEOUT_MS` (an hour), `FILE_STORAGE_GROWTH_*`,
   `FILE_STORAGE_METRICS_MAX_APPLICATIONS`, `CONTENT_CLAIM_STAFF_EMAIL`
   (`legal@oxy.so`). Every task needs `REDIS_URL` for the cross-task
   file-cache channel (it already needs it for the user cache): play-session
   revocation rides it too. The asset-variant worker image needs nothing new
   (ffmpeg already renders video; audio uses the same binary). *Verify:* `GET
   /assets/admin/lifecycle/sweeps` (staff) shows a `report` run within the
   hour with a `deletedApplications` step; the log shows `[FileUploads] Worker
   started`; CloudWatch has `Oxy/FileStorage` datapoints;
   `POST /assets/recording-ingest/x/y` unsigned answers an S3 XML
   `MissingSecurityHeader`.
4. **Post migration** `0177_drop_file_links` (phase `post`) once every task
   runs the new image — done with 1–4b. *Verify:* `file_links` is gone.
5. **Seed**: `DRY_RUN=1 bun run --cwd packages/api seed:oxy-applications`, read
   the plan, then without `DRY_RUN` — the file scopes of D11 for every adopting
   product, and `files:linked:read` for Syra, Alia and Homiio (stage 4c). Then
   the native product-agent bootstrap for Clarity (dry-run, review
   `planSha256`, apply), which grants its backend the file scopes. Re-bind the
   workload identities that must reach new scopes (Homiio's `oxy-homiio-task`;
   Alia's if it authenticates by workload). *Verify:* `GET /applications/:id`
   of each lists the scopes; a service token minted for each carries them.
6. **Grants**: give `content:claims` (with `is_staff`) to the people who review
   claims; make sure `legal@oxy.so` (or `CONTENT_CLAIM_STAFF_EMAIL`) reaches
   them. *Verify:* the console shows "Content claims" to them and
   `GET /content-claims/access` answers `{ canReview: true }`.
7. **Publish the SDKs** with `release-packages.yml`, in dependency order,
   from `main`'s head. 1–4b (done): `@oxy.so/contracts` 4.22.0, `@oxy.so/core`
   4.18.0, `@oxy.so/services` 11.9.0. 4c: `@oxy.so/core` 4.21.0, then
   `@oxy.so/services` 11.12.0 (contracts is unchanged at 4.24.0). Re-check npm first,
   and open PRs that claim the same numbers: if a version was taken meanwhile, bump to the next
   free one — the `version` line of each package's `package.json`, the heading
   of each `CHANGELOG.md`, core's `@oxy.so/contracts` dependency
   (`workspace:<contracts version>`) and the root catalog's `@oxy.so/core`
   range (services' peer floor), one line each; `bun install` to refresh
   `bun.lock`. *Verify:* `npm view @oxy.so/core@4.21.0 version` etc.
8. **The CDN's content types and headers** (oxy-infra): first run
   `scripts/operations/oxy-website-media-content-types.py` (dry run, review,
   then `--apply`) so the website's media objects carry real Content-Types —
   the function below decides by them. Then publish the CloudFront Function
   and associate it, event `viewer-response`, with the four S3-backed
   behaviours of the `cloud.oxy.so` distribution — `*.m3u8`, `/content/*`,
   `/variants/*`, `/oxy-website/*` (the default behaviour only serves the
   API's redirects and 404s) — and add the growth alarm (both below). Stage
   4c's part — the sanitized-SVG branch — is OxyHQ/oxy-infra#316.
   *Verify:* below the code.
9. **Product PRs** (each its own repository): Mercaria (store and catalogue
   media ownership, references, `adoptAppFile` for digital deliverables,
   `importAppFile` for the importer, `file.blocked` handling); GoWay (claim
   withdrawal through `assets.references.remove`); Mention (GIF library as
   Mention files, post-media references, `adoptAppFile` for evidence); Moovo,
   Nilo, Peable, CrowdSource (references); the own-bucket products (Syra,
   Homiio, the website, Alia, Clarity) move into Oxy Files one at a time with
   a verified copy and a read-only soak — Syra, Alia and Homiio with the
   stage-4c surfaces (private person media, read-back, play sessions,
   recording targets, large imports); the website's counter-notice page.
10. **Webhooks and secrets**: each product that wants file events (or key
    authorization for play sessions) registers its endpoint (console →
    Webhooks → File events, or `oxy.apps.setFilesWebhook`), answers the
    challenge, and stores the secret in its own secret store (SSM); it
    verifies with `verifyFileEventSignature` (file events) and
    `verifyStreamKeyAuthorization` (`stream.key_authorization`). *Verify:*
    `GET /applications/:id/files-webhook` shows `verifiedAt`.
11. **Backfills — dry run, then apply**:
    - `bun run packages/api/scripts/reconcile-profile-media-references.ts`
      (preview), then `--apply`; a second `--apply` reports 0 added, 0 removed,
      0 orphans. In production dispatch
      `.github/workflows/reconcile-profile-media-references.yml` from `main`
      (`mode=report`, then `apply`, then `report` again): it runs inside the
      VPC as an ECS one-shot — over the SSM tunnel the pass takes hours.
    - Every product runs `OxyServer.assets.references.reconcile(entityType,
      items, { dryRun: true })` per entity type, reviews `{ added, removed,
      refused }`, then runs it for real, and schedules it (nightly).
12. **The lifecycle's report week**: leave `FILE_LIFECYCLE_MODE=report` for a
    week and review `GET /assets/admin/lifecycle/sweeps` daily: `trash.due` and
    `purge.due` are applications' files nobody references (spot-check samples
    with the owning product); `deletedApplications` names only applications
    that really are deleted (expect mostly references; if a live product still
    needs one of their files, move it before enforcing); `staleUploads.withObject`
    is explained; nothing jumps without a cause.
13. **Enforce**: add `"FILE_LIFECYCLE_MODE":"enforce"` to `TASK_ENV_OVERRIDES_JSON`
    in this repository's `.github/workflows/deploy-aws.yml` and deploy — a
    release is rendered from the RUNNING task revision, so a change to the
    Terraform task definition does not reach production; this override is the
    mechanism. `deletedApplications.due` falls to 0 within ceil(due / 10)
    hourly runs; the back-filled backlog is worked off 200 files per step per
    hour. To stop at once, set `report` (or `off`) there and deploy again:
    nothing is purged before 30 days in trash, and a reference or a re-upload
    restores it.

**oxy-infra** (`terraform-uswest2/alerts.tf`, beside
`oxy_asset_variant_permanent_failures`):

```hcl
resource "aws_cloudwatch_metric_alarm" "oxy_file_storage_growth_anomaly" {
  alarm_name          = "${var.prefix}-file-storage-growth-anomaly"
  alarm_description   = "An application's file storage grew anomalously in the last 24 hours (ADR 0043 D2). The API's ERROR log '[FileStorage] Application storage growth anomaly' names it; per-application detail is Oxy/FileStorage by ApplicationId."
  namespace           = "Oxy/FileStorage"
  metric_name         = "ApplicationGrowthAnomalies"
  statistic           = "Maximum"
  period              = 3600
  evaluation_periods  = 2
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching" # the sweep can be off; absence is not growth
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
```

and the CloudFront Function (viewer-response, on the four S3-backed
behaviours named in step 8):

```js
function handler(event) {
  var response = event.response;
  var status = parseInt(response.statusCode, 10);
  // A 304 carries no body and its headers revalidate a cached 200: untouched.
  if (status === 304) return response;
  var type = ((response.headers['content-type'] || {}).value || '').split(';')[0].trim().toLowerCase();
  if (type === 'image/svg+xml') {
    // Oxy stores SVG only sanitized (ADR 0043 stage 4c): inline for <img>; a
    // direct navigation is a sandboxed, scriptless, fetch-less document.
    delete response.headers['content-disposition'];
    response.headers['content-security-policy'] = { value: "default-src 'none'; style-src 'unsafe-inline'; sandbox" };
  } else {
    var inline = type.indexOf('image/svg') !== 0 && (
      type.indexOf('image/') === 0 || type.indexOf('video/') === 0 ||
      type.indexOf('audio/') === 0 || type === 'application/pdf' || type === 'text/plain' ||
      type === 'application/vnd.apple.mpegurl' || type === 'application/x-mpegurl');
    if (!inline && status >= 200 && status < 300) {
      var disposition = ((response.headers['content-disposition'] || {}).value || '').toLowerCase();
      if (disposition.indexOf('attachment') !== 0) {
        response.headers['content-disposition'] = { value: 'attachment' };
      }
      response.headers['content-security-policy'] = { value: "sandbox; default-src 'none'" };
    }
  }
  response.headers['x-content-type-options'] = { value: 'nosniff' };
  return response;
}
```

*Verify:* an image on `cloud.oxy.so` has no `content-disposition` (or
`inline`: a large upload stores `inline` on media); a public zip uploaded with
`uploadAppFileLarge` answers `content-disposition: attachment`; a public SVG
uploaded through `/assets/service/app` answers `content-type: image/svg+xml`,
no `content-disposition`, the SVG CSP above and `nosniff`; a public
`hls_master.m3u8` has no `content-disposition`; a conditional request
answering 304 carries none of these headers; the alarm is `OK`.

**Verification after release** (production, with a staff session and a test
application holding the new scopes):

- `uploadAppFileLarge` of a 50 MiB zip: `completed`; its `/assets/:id/stream`
  is an attachment; a second call answers `deduplicated` without uploading;
  declaring a wrong `sha256` ends in 422 `CHECKSUM_MISMATCH` and leaves no file.
- `adoptAppFile` of a public file: a new application-owned file with the same
  `sha256`, no new object in the bucket.
- A person's `PUT /users/me` with a new avatar: the old avatar shows *not in
  use* in their file manager, the new one does not.
- The file manager: delete → the file is in Trash → restore → it is back.
- A test claim (staff) actioned against a test file: the owner submits a
  counter-notice; the claim is `counter_noticed`; the trail shows
  `counter_notice_submitted`; the staff alert and the owner's confirmation
  arrive.
- After blocking a file, `/assets/:id/stream` answers 404 from every task at
  once (the cache channel), not after five minutes.
- Stage 4c, with a test person and the test application holding
  `files:user-media:write` and `files:linked:read`:
  - `uploadUserMedia(person, mp3, 'audio/mpeg', { visibility: 'private' })`:
    the object key has no `public/`; within minutes the file has `hls_master`,
    `hls_a64`, `waveform` and `preview` variants; `linkedDownloadUrls([id])`
    answers one URL for the test application and none for another.
  - The person's file manager lists the test application under "Apps with
    access" ("Stored this file for you"); Revoke → `linkedDownloadUrls`
    answers none, and a play session opened before stops (its next segment
    404s).
  - `streams.create(id)` → `masterUrl` plays in Safari and hls.js (AES-128);
    `streams.revoke` → the next segment is 404 on every task.
  - A LiveKit room composite egress with `file: { filepath: target.livekit.filepath,
    s3: target.livekit.s3 }` from `createAppRecordingTarget` → after the egress
    ends, `completeRecordingTarget` answers the recording as a file with the
    right `sha256` and size; the target's credentials then refuse a second
    recording.
  - `importUserMedia(person, <a 100 MiB podcast enclosure>)` → resolves (the SDK
    polls the `202`) with the file; a second call answers `existing` without
    fetching.
  - An SVG with `<script>` uploaded with `uploadAppFile`: the stored bytes have
    no script; its `stream` answers `image/svg+xml` inline with the SVG CSP;
    `?variant=w320` is a webp.

## Alternatives rejected

- **A system namespace per product.** A schema change per product and nothing
  tying the namespace to the application that writes it.
- **A service account per application.** Precisely "a file hanging off an
  arbitrary account": it can be signed in to, blocked, archived and deleted.
- **Metering Oxy's own applications against the `oxy` account.** Treats the
  platform as its own customer; rejected by the owner (D2).
- **Deleting a person's unused files after a grace period.** A person's file is
  theirs; Oxy informs, the person decides (D5).
- **30-day trash when a developer deletes an application.** The developer asked
  for deletion; keeping their content would be neither expected nor ethical (D8).

## Related

- `docs/engineering/per-owner-asset-rows.md`, `docs/identity/account-storage-deletion.md`
- ADR 0007 (billing principal), ADR 0021 (service read of linked files)
- OxyHQ/oxy#1284 (trashed public files still served)
