# ADR 0041 — Who owns a file, who uses it, and when it goes away

- Status: proposed (design agreed with the owner of Oxy on 2026-10-16; stages
  1 and 2 of the rollout are implemented on this branch)
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
   federation cache, exempted from eviction by convention; Syra, Homiio, GWJ, the
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
Mercaria, Move, Mention, Homiio, Syra, GWJ and the website, and ends re-uploads on
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
   artwork, and Alia's show covers move to Alia), Homiio, GWJ, the website, Alia
   (skill bundles), Clarity (crawler image cache as Clarity-owned files under D5's
   collection). Allo's end-to-end-encrypted chat blobs stay where they are: they
   are ciphertext with a 7-day contract, not media.

### Stage 1 as built (D2, D3, D4, D11; D12 earlier)

- **Metering.** `storageAccountForOwner` attributes an application's file to
  `applications.owner_account_id` only when the application is `third_party`,
  read live (a transfer or reclassification moves the bytes at once); Oxy's
  own applications attribute to no one. Per-application stored bytes are
  `applicationStoredBytes` and `GET /applications/:appId/storage`
  (`usage:read`); the growth alert of D2 is not built yet.
- **Scopes.** `files:references:write` joins `files:app:write` and
  `files:app:delete`. `isPrivilegedScopeForApplicationType` makes the three
  staff-only on `first_party`/`internal`/`system` and self-service on
  `third_party`, on create, update and credential creation; a `third_party`
  application may hold a SERVICE credential (and mint a token) carrying only
  these and the payments pair. Type-blind readers of the privileged set (the
  legacy scopeless-credential fallback, workload bindings) still treat them as
  privileged. The routes re-check live only that the application is `active`.
- **`file_references`.** Migration `0168_file_references` (pre) creates the
  table, copies every `file_links` row with its `app` resolved by
  `oxy_file_link_application_id` — `goway` → GoWay, `mercaria` → Mercaria,
  `nilo` → Nilo, `oxy-mail` → Oxy Inbox, `profiles` → Oxy Accounts, or an
  application id itself (`src/utils/legacyFileLinkApplications.ts`, held equal
  by a test) — and FAILS naming every value that resolves to no single active
  application. `scripts/file-references-preflight.ts` lists the values a
  database holds before deploying. A trigger mirrors the previous image's
  `file_links` writes until `0170_drop_file_links` (post; numbered 0168 until
  stage 2 put its `pre` migration in front of it, so one release can carry
  both stages) drops the table.
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

- **`unreferenced_since`, `trashed_at`** (`0169_file_lifecycle`, pre). The
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
  `@oxy.so/core` 4.13.0 (4.12.0 was published from `main` first).
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

### Required changes in other repositories (stage 2)

- **Every product that registers references** (Mercaria, GoWay first) runs
  `OxyServer.assets.references.reconcile` once per entity type before the
  sweep is switched to `enforce`, and then on a schedule: an application file
  its product uses but never referenced reads as unused and would be trashed
  24 hours after enforcement starts. The seed now grants GoWay
  `files:references:write`; run `seed:oxy-applications` for it to take effect.
- **A product that showed a trashed file** (a link removed, the file kept
  being displayed) now gets a 404 / placeholder for it: trash is not served.
- **SDK consumers** take `@oxy.so/core` 4.13.0 for `references.reconcile`,
  `Asset.inUse` and `assets.list({ inUse })`; nothing else changes shape.

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
