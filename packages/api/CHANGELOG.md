# Changelog: `@oxy.so/api`

## Unreleased

### Fixed (every upstream body read has a deadline)

Bodies fetched with `safeFetch` were read by nine hand-rolled readers that
capped the bytes but not the time; `safeFetch`'s deadline ends at the response
headers, so a server that sent its headers and stalled could hold a read open
(the domain-proof `/.well-known/oxy-domain` check passed no other deadline at
all). Every read now goes through `@oxy.so/core/server`'s `readResponseBody` /
`readResponseJson` with an explicit whole-body `timeoutMs`: federation JSON
(WebFinger, actors, Bluesky profiles) 10 s, federated avatars and repair
downloads 15 s, the email image proxy, Instagram Graph, the Meta profile proof
and the files-webhook challenge 10 s, the domain proof 5 s, play-session key
authorization 3 s, linked accounts 15 s. A federated avatar whose body stalls
or breaks off is now a transient transport failure (retried), no longer a
permanent `too_large`. The unused `utils/boundedBody.ts` is gone.

### Changed (a multipart upload is at most 90 MiB, refused as JSON 413 `USE_PRESIGNED_UPLOAD`)

`POST /assets/upload` and `POST /assets/:id/upload-direct` buffered a file of
any size in memory. They now take at most 90 MiB
(`ASSET_MULTIPART_FILE_MAX_BYTES`): over it, 413 `USE_PRESIGNED_UPLOAD` with
`details.maxBytes`, telling the client to upload by `/assets/init`, a
presigned PUT and `/assets/complete`. The proxy api.oxy.so moves behind
refuses any body over 100 MB with an HTML 413 of its own; this answers first,
in Oxy's shape. `@oxy.so/core`'s `assets.upload` already sends nothing over
64 MiB this way. No first-party caller sends more (ALB logs, 14 days: no
end-user request over 50 MB). Multer's other refusals (an unexpected field)
are 400 instead of 500.

### Changed (`/assets/complete` answers every field `/assets/upload` does)

Its `file` now also carries `ext`, `visibility` and `metadata`, so a client
maps a presigned upload to the same `UploadedAsset` a multipart one returns.
Additive.

### Fixed (an idle `/v1/realtime` session outlives the proxies)

The edge never pinged a realtime customer, while a session may sit idle for
its `idleTimeoutMs` (two minutes by default): longer than the load balancer's
60 s idle timeout and the CDN proxy's 100 s, so an idle session's socket was
cut under it. The edge now pings every customer every 25 s from the upgrade
on (`REALTIME_HEARTBEAT_INTERVAL_MS`) and terminates one that left the
previous ping unanswered; its session detaches as for any lost customer.

### Changed (no reconciliation session's items are ever one delete)

A commit and a release used to delete the session's items in one statement:
for Homiio's ~2 million listing photos, a single 2M-row delete on the shared
database. They now only end the session; its terminal status is all
`sweepEndedReconciliations` needs, and the large-upload worker deletes the
items in bounded batches, as it already did for sessions that expired open.
Responses are unchanged.

### Fixed (reference reconciliation items outlived their sessions)

A reconciliation session that ended without deleting its items — one that
expired `open` and was retired by the next `begin`, or by nobody — kept them
until the expiry sweep removed the session a day later, and then in ONE
cascading statement. Production held 4,475,000 such items (~1.5 GB) of 120
`abandoned` sessions on 2026-10-20. The large-upload worker now retires every
session that expired `open` and deletes the items of every ended session
(`sweepEndedReconciliations`): two statements of 5,000 a pass on each task,
through the items' primary key in its own order (without the `ORDER BY` the
planner scanned the whole table), `SKIP LOCKED`, 15 s statement timeout.
`open` and `committing` sessions are never touched.

### Fixed (the asset-variant queue holds a bounded window — migration `0193`, pre)

Every upload added a rendition job to BullMQ, so a bulk import made the queue the
whole backlog: on 2026-10-20 398,416 jobs (~380 MB) filled the 384 MB
noeviction node, every Redis write failed (workers could not even complete a
job), and the worker loop logged ~1,600 errors a second. The backlog now lives
in Postgres (`file_rendition_requests`, one row per file awaiting renditions,
settled by the job that builds it — only while it is still the newest request).
An upload adds its job directly only while the queue is under 2,000; the worker
fleet's scheduler (one pass at a time, advisory lock) tops it up to 1,000 from
the oldest requests at a lower priority, leases them for 30 minutes (a job lost
with Redis is found again), and takes any job beyond the bound back into the
table — which drains the existing backlog with no manual step. Completed and
failed jobs are no longer kept in Redis. The worker pauses on a Redis error and
resumes after a bounded exponential backoff (BullMQ retries a failing script
with no delay), and every error stream is logged as a once-a-minute summary.
`QueueDepth` is the queue's real depth (waiting, prioritized, delayed);
`OldestWaitingJobAgeSeconds` is the oldest request's age, wherever it waits;
`PendingRenditionRequests` is new.

### Fixed (the application storage observation — migration `0192`, pre)

The lifecycle sweep's storage observation (ADR 0043 D2) read every live
application file's heap row and ran a correlated sum over `file_variants` per
row; on production (2.19M application files, 7.5M renditions) one run took over
two hours. It also ran after its run was marked completed, outside the lease,
so the next hour's run started another — three at once on the shared database,
slowing every Oxy product. Now it reads only indexes that carry `size`
(`files_application_live_bytes_idx`, and `size` added to
`file_variants_file_id_type_idx` and `files_owner_application_id_created_at_idx`
— built `CONCURRENTLY` out of band; the migration swaps them in), runs inside
the run's lease, and each statement is cancelled after 4 minutes. Measured on
production: "stored" 13 s, "added" 4 ms for an hour's window.
`applicationStoredBytes` (`GET /applications/:appId/storage`) uses the same index-only form;
its response is unchanged.

### Added (`POST /apps/invitations/email`, scope `invitations:email` — migrations `0186`, `0187`)

An application can have Oxy send ONE fixed-template invitation email for it —
"{inviter} invited you to {resource} on {application}", with a single link — to
an address that may hold no Oxy account. Service tokens only, and the new
`invitations:email` scope is privileged (staff grant it per application; the
seed grants it to Nilo). Oxy reads the inviter's name from `inviterUserId`; the
link must be https on one of the application's registered redirect origins; the
resource name is plain text (≤ 100 characters, no link-shaped text, no control
or bidi characters) and escaped. `Idempotency-Key` is required and scoped to
the application. The suppression list applies, and three durable budgets: one
invitation per recipient per application an hour, fifty per inviter per
application a day, a thousand per application a day (429 with `Retry-After`).
English and Spanish (`locale`), styled from the Bloom email tokens.

`application_invitation_emails` (`0187`, pre) is the claim, the budget ledger
and the delivery state in one row; the message is rendered at delivery and not
stored, and rows are swept after thirty days. Delivered by the request that
accepted it, retried and adopted by the email maintenance pass on the ladder a
user's mail uses. `0186` (pre) only widens the three scope CHECKs.

### Removed (the retired deployment approval columns, migration `0184`)

`inference_deployments.scoped_execution` and `private_auto_source_approval` are
dropped, after the image stops reading them (`post`). The two disabled
2026-10-05 Jev rows that still carried them go first, with their current
routing scorecards; `inference_deployments_revision_provider_scope_key` is now
a plain unique key, and the Private Auto key and check are gone.

### Changed (`@kaana.ai/contracts` 7.0.0)

Oxy now reads Kaana with the contract Kaana itself runs (7.0.0, up from
4.4.1). The authorization request no longer carries `canonicalInputSha256`
(it is refused as an unknown member by the schema), so the grant's
`source-approval-not-granted` refusal is deleted with it.

### Removed (the old edge's decisions route)

`POST /v1/decisions` is gone. It had refused every request
(`decisions-served-by-kaana`) since decisions became a `kaana.ai/v1` grant
operation (oxy#1809), and no caller was left: zero requests in the 24 hours
before removal. The edge's decisions-only branches (completion check, retry
suppression, input budget, output-price rule) went with it.

### Changed (a reconciliation session holds up to 5,000,000 pairs — ADR 0043 D6)

A session held at most 500,000 pairs while its commit had to finish inside a
request. Since migration `0183` the commit runs under a lease however long it
takes, so the cap is 5,000,000: an entity type of a few million uses (Homiio's
~2 million listing photos) reconciles as one session instead of answering 413.

### Fixed (a dry-run reconciliation releases its session — ADR 0043 D6)

A dry-run commit left its session open for an hour, so every SDK's next
reconciliation of that entity type was refused with 409
`RECONCILIATION_IN_PROGRESS` (68 such sessions were open in production). It now
releases the session (`abandoned`, its items deleted) once it has its counts;
the real run is a new session, as every SDK already sends.

### Changed (a reference reconciliation's commit runs under a lease — ADR 0043 D6)

Migration `0183_reconcile_commit_lease` (pre). A commit of a large inventory
outlasted the load balancer's 60 seconds; it now runs under a lease renewed
after every batch. `POST …/reconcile/:sessionId/commit` takes `{ background:
true }` and answers 202 while the commit runs; `GET …/reconcile/:sessionId`
reads its `status`, `result` and `error`. A commit whose task dies is resumed by
the large-upload worker. Without `background` the request waits, as before. A
page, and `POST`/`DELETE /assets/service/references`, accept a `fileId` up to
256 characters (it was 64), so an id that names no file is that pair's answer
(`refused`, `not_found`) instead of failing the whole page or batch with 400.

### Added (ADR 0043 — who owns a file, who uses it, and when it goes away)

The whole of `docs/adr/0043-application-owned-files.md` (stages 1–4c; its
"Release runbook" gives the deploy order). Migrations `0170`–`0176` (pre),
`0177_drop_file_links` (post) and, for stage 4c,
`0180_file_access_streams_ingests` (pre).

- An application can own files (`/assets/service/app`, `files:app:*`);
  third-party applications' files count toward their developer's plan.
- `file_references` replaces `file_links`: applications register and reconcile
  their own uses (`/assets/service/references`, `…/reconcile`).
- The lifecycle sweep (report → enforce) collects applications' unused files;
  only `active` files are served; owners' trash (`POST /assets/:id/trash`,
  `GET /assets?status=trash`).
- Import by URL (`/assets/service/app/import`, `/service/user-media/import`),
  application deletion by typed name (D8), file events to a verified endpoint
  (D9).
- Content claims and the takedown (`/content-claims`, blocked bytes refused
  everywhere with 451), the owner's counter-notice
  (`POST /content-claims/counter-notices`).
- Large, any-type, resumable uploads verified by hash
  (`/assets/service/{app,user-media}/uploads`), adoption
  (`POST /assets/service/app/adopt`), non-media served as sandboxed
  attachments, profile avatars referenced, per-application storage growth
  metrics, cross-task file-cache invalidation over Redis.
- Stage 4c: private person-owned media from a service (`x-visibility` on
  `/assets/service/user-media`); a person's revocable consent for an
  application to read their file (`file_access_grants`; `GET`/`DELETE
  /assets/:id/access…`), which `/service/linked-url` now honours; audio
  renditions (an AAC HLS ladder, waveform peaks, a 30-second preview, optional
  loudness normalization); per-play, revocable play sessions with on-the-fly
  AES-128 and product key authorization (`/assets/service/streams`,
  `/assets/streams/…`); recording targets a LiveKit egress uploads into
  (`/assets/service/{app,user-media}/recording-targets`, the SigV4
  `/assets/recording-ingest`); large imports by URL in the background (`202`,
  `…/imports/:importId`); SVG accepted only as its sanitized document and
  served inline under a sandboxing CSP.
- A play session's rendition allow-list (migration
  `0182_play_session_renditions`, pre): `POST /assets/service/streams {
  renditions: ['hls_a64', 'hls_a128'] }` lists only those rungs in the master
  and answers 404 for any other rung's playlist, segment or key, with a key per
  allowed rung; 409 `STREAM_RENDITIONS_NOT_READY` when none is ready. Without
  it, the whole ladder as before.
- The blocked-content email links the owner to the website's counter-notice
  form with the reference filled in
  (`https://oxy.so/transparency/legal/counter-notice/?reference=…`), with
  legal@oxy.so kept as the fallback.

### Added (a service asks whether a person may act for an account)

- `GET /internal/accounts/:accountId/access/:userId` → always 200
  `{ accountId, kind, access: { role, permissions, status, source } | null }`:
  the effective access `accountService` resolves for every other membership
  check (direct, inherited, a personal account's own owner), `null` for no
  active membership, an archived, unknown or unclaimed directory account.
  Behind `/internal`'s service-token and trust gates plus the new privileged
  scope `accounts:membership:read`; 600/minute per calling application; each
  answer logged with caller, account and outcome, never the person. It is how
  Mention and Oxy Move publish to a channel (which nobody may act AS) on a
  member's behalf with no session of theirs.
- Migration `0166` (deploy phase `pre`) widens the three scope CHECKs by that
  one value. It grants nothing.

### Fixed (an embeddings batch is held to the context per input, not in total)

- `POST /internal/kaana/v1/authorizations` for `embeddings` compared the batch's
  TOTAL estimate with the route's context window, so Clarity's 128 chunks of
  2,000 characters (64,128 estimated tokens) were refused
  `context_length_exceeded` by a 32,000-token model that embeds each chunk on
  its own. The route is now held to the smallest the largest input can be (the
  batch's mean; exact for one input). The total still answers to the pilot's
  `maxInputTokens` and prices the request.
- `inference.grant.refused` names `reason: 'route-context'` or `'route-output'`
  when no route fits, where it named none.

### Changed (the public app record is cacheable)

- `GET /auth/oauth/client/:clientId` answers `Cache-Control: public, max-age=60`
  on a 200, the dynamic origin registry's own refresh interval. Every Oxy app reads
  it on each cold boot; a reload now reuses it. A 404 stays uncached.

### Added (a bot account carries a 3D avatar character)

- `users.character` (nullable `jsonb`, migration `0159`, deploy phase `pre`) and
  `users_character_kind_check`: only a `bot` row may carry one. The "every bot
  has one" constraint follows the backfill of bots minted before the column.
- `POST /accounts` with `kind: 'bot'` stores the `character` it is given or, when
  none, `avatarCharacterFor(username)`; any other kind refuses one (400).
  `PATCH /accounts/:id` replaces it (`account:update`, as for every field).
- `character` rides the user DTOs for `kind: 'bot'` only (`userIdentityFields` is
  the one definer; personal payloads do not grow): `formatUserResponse`,
  `UserService.formatUserResponse` and the recommendation rows.

### Changed

- `isAgent` on recommendation rows is `kind === 'bot'` (`deriveIsAgent`), where it
  was `type === 'agent'` and so was never true for the bots Alia mints. `type:
  'agent'` still means a remote/automation actor resolved by `PUT /users/resolve`.

### Fixed (a send's Idempotency-Key, and a delivery the relay took)

- `POST /email/messages` refuses an `Idempotency-Key` reused for a DIFFERENT
  message (recipients, subject, body, the parent it replies to, attachments)
  with `422 VALIDATION_ERROR`, `details: { reason: "idempotency_key_reused",
  id, messageId, deliveryState, scheduledAt }` — the send the key already made
  and where it stands (`scheduled` with its time, `sending`, `retrying`,
  `sent`, `failed`, `cancelled`, or `unknown` for one from before deliveries
  were recorded), so a client that restored the key after a crash tells the
  user the truth rather than assuming it left. A repeat of a send that was
  cancelled is refused the same way, never answered 202. It
  used to answer with the first send's acceptance and then delete the second
  request's draft, losing it. A repeat of the same message still answers with
  the first send, and the draft is deleted only once the message is filed in
  Sent. Only what the client chose is compared, normalised as the Sent row
  stores it: threading is the `inReplyTo` it named, never the `References`
  derived from that parent (a retry after the parent changed or was deleted is
  still a retry), and a read-receipt request is not part of it.
- A `scheduledAt` send under a key takes the same outbox claim, in the
  transaction that files it: a double press of Schedule, or Schedule racing
  Send now, files and sends ONE message (both used to file a row and both went
  out under the same Message-ID). The claim waits, invisible to the outbox
  worker, until the send falls due. It is the message's, not the outbox's:
  `GET /email/outbox` does not list it and its retry and cancel routes (and
  the Alia tools over them) refuse it. A scheduled message is cancelled by
  taking it out of Sent or deleting it, and every path that does so — delete,
  move, bulk move, snooze, blocking its sender (Sent mail moves to Junk),
  deleting the folder it is in, deleting the account's mail — cancels its
  claim in the same transaction through one helper (`unscheduleMessages`),
  and only if it is still scheduled under the row lock: a message the due job
  sent meanwhile stays sent, never marked cancelled. One that stays is unscheduled and its
  delivery reads `failed`/`cancelled`, so restoring it sends nothing; the due
  job also sends only what is still in Sent, and a retry of a cancelled
  scheduled message is refused as cancelled (`409`), not "already being
  delivered". Rows scheduled before this are compared with their Sent row,
  and read `cancelled` once unscheduled. There is deliberately no unique index on
  `messages(user_id, message_id)`: the claim makes a send leave once, and the
  index would refuse inbound mail delivered twice (`docs/EMAIL.md`).
- The parent a reply threads under is the earliest of the user's copies of it,
  not whichever an unordered `limit 1` returned.
- A repeat waits at most 5 s on the first request's claim and then answers
  `503 SERVICE_UNAVAILABLE` (`details.retryable: true`); the client retries
  with the same key. The claim's transaction also ends its own session after
  15 s idle, so a first request whose task stopped answering frees its claim
  instead of holding a pooled connection on every repeat until keepalive.
- A delivery the relay accepted is marked `sent` before anything else is
  recorded. A send claimed before Sent copies were filed first, whose Sent copy
  then did not fit the quota, was never marked and went out again every time
  the outbox worker re-adopted it (about every 10 minutes).
- The outbox worker adopts an abandoned delivery only while it has attempts
  left; one without is settled as `failed` (`retries_exhausted`) rather than
  re-sent without end.

### Fixed (a repeated send always names its Sent row)

- `POST /email/messages` claims the send and files its Sent copy in ONE
  transaction. A repeat of the same `Idempotency-Key` that raced the first
  used to answer 202 with `id: null` while the first was still filing, and was
  told the message was accepted even when the first was then refused (a full
  mailbox) and nothing was filed or sent — after which the controller deleted
  the draft. The repeat now waits on the claim: it answers with the filed row,
  or, if the first was refused, makes the attempt itself.

### Changed (Kaana owns provider keys and routing, ADR 0038)

- A provider's synced routes are funded at the best tier AVAILABLE among all
  its enabled Kaana keys: any available promotional grant keeps them
  `promotional_credit`, because Kaana walks the provider's key pool cheapest
  first. A second key no longer collapses the provider into `standard_payg`.
- A route the Pro/Ultra promotional lane admits (ADR 0037) is signed with
  `maxFundingTier: "credit"` (contract set 3.8.0), so Kaana never serves it on
  a paid key; a usage report naming a dearer tier logs
  `inference.edge.funding_ceiling_breached`.

### Changed (a sent message shows whether it left)

- `POST /email/messages` files the message in Sent and answers 202 **before**
  it talks to a relay; delivery follows on the same task, under the outbox
  claim's lease, and the outbox worker retries or adopts it. The answer adds
  `id` (the Sent row) and `delivery`; `message` is `Message accepted for
  delivery`. `queued` stays for older clients and is true only when an earlier
  attempt under the same key already failed. A server with no relay at all
  still answers 503 before filing anything.
- Every message read carries `delivery` (`sending`, `retrying`, `sent`,
  `failed`, with `attempts`, `nextAttemptAt`, the relay's `error` and a typed
  `errorCode`) on a message the user sent; received mail has none. It is the
  message's `email_outbox` row, linked by `message_row_id` (migration 0157 adds
  `error_code` and an index). Each change emits `email:changed` with reason
  `delivery`.
- `POST /email/messages/:messageId/delivery/retry` delivers a failed message
  again with a fresh budget, refusing (400) a recipient suppressed since.
- An SES permanent bounce marks the sender's Sent copy `failed` / `bounced`.
- A scheduled send is handed to the outbox when it falls due, so it is tracked
  and retried like any other instead of re-sent every minute.

### Changed (Inbox mail integrity)

- **Breaking for clients sending a row id:** `POST /email/messages` and
  `POST /email/drafts` answer 400 unless `inReplyTo` and every `references`
  entry is an RFC 5322 Message-ID (`<id@host>`). `sendMessageForUser` enforces
  the same for Alia tickets and MCP. When the sender holds the parent, the
  server derives `References` from the parent's chain.
- `Idempotency-Key` sends take a durable claim (an `email_outbox` row) before
  the relay is contacted, so a retry of the same key on any task returns the
  first outcome instead of sending again. `queued: true` now also covers "the
  first attempt is still in flight".
- Inbound mail from all three paths goes through `parseInboundMime`: the AMP
  (`text/x-amp-html`) and Apple Watch alternative bodies are no longer stored as
  an attachment named "attachment".
- Every user message carries `X-Oxy-Sent-Id`; the relay-assigned Message-ID
  (SES) is kept as `messages.relay_message_id` and threads replies; a user's own
  message coming back is linked by `messages.sent_copy_of` and shown once in its
  conversation (migration 0121, pre).
- One-off operations: `src/scripts/purge-alternative-body-attachments.ts` and
  `src/scripts/repair-reply-row-id-threading.ts`, each `--dry-run` / `--apply`.

### Added

- Instagram Graph fallback: `*@instagram.com` handles whose kilogram bridge
  resolution fails (429, timeout, refusal) resolve through Meta Graph API
  Business Discovery as protocol `instagram-graph`, actor
  `instagram-graph:<igUserId>`; `POST /federation/identities/resolve` accepts
  `protocol: 'instagram-graph'` for Instagram handles (400 otherwise). Runs
  whenever `META_GRAPH_ACCESS_TOKEN` and a numeric `META_IG_BUSINESS_ACCOUNT_ID`
  are set and is inert otherwise; there is no enable switch, and the Graph API
  version is pinned in code (`v23.0`). See `docs/identity/external-identities.md`.

### Changed

- URL slash trimming (`nodeRegistry`, `mcpOAuth`, `config/cdn`) no longer uses
  `/\/+$/`, which backtracks polynomially on a long run of slashes
  (`utils/slashes.ts`).

### Removed

- **Breaking:** the last staff hands on people's standing —
  `POST /reputation/moderation/incidents/:incidentId/reconcile`,
  `GET /reputation/moderation/incidents/:incidentId/effects` and
  `POST /civic/personhood/:userId/recompute`, and the staff view of another
  person's `GET /reputation/moderation/standing/:userId` (now the subject's
  alone). Personhood already recomputes on every vouch, attestation and audit
  outcome. Moderation needs no reconciliation at all: applying a newer
  revision reverses the one it supersedes in the same transaction, and an
  appeal reverses a consequence (strike, compensating entry, effect) in one
  transaction, so no half-applied state can exist to repair.
- **Breaking:** reputation staff routes — `POST /reputation/rules`,
  `POST /reputation/transactions/:id/reverse`, `POST /reputation/transactions/:id/void`,
  `POST /reputation/:userId/recalculate`, `GET /reputation/disputes`,
  `POST /reputation/disputes/:id/resolve` — and disputes (`POST /reputation/disputes`,
  `GET /reputation/:userId/disputes`). Staff get no special view of a balance,
  a ledger or influence weights. `POST /reputation/award` takes a service token only.
- Reputation rules are code (`src/services/reputationRules.ts`, versioned);
  `GET /reputation/rules` returns `{ version, rules }`. Migration
  `0119_reputation_rules_in_code` (post-deploy) drops `reputation_rules` and
  `reputation_disputes`.
- `GET /auth/lookup/:username`, `GET /accounts/:id/children`,
  `GET /users/me/data` (use `GET /users/me/export`) and the
  `/accounts/service/channels*` provisioning routes with their
  `accounts:provision` scope.

### Fixed

- A reversed confirmed report no longer counts toward report accuracy through
  its compensating entry.

## 2.0.0

### Licence: this package moves to the Breathe License 1.0

**Breaking, and a genuine narrowing rather than paperwork.** `@oxy.so/api` is now
licensed under the Breathe License 1.0, identifier `LicenseRef-Breathe-1.0`. The
code, the API surface and the behaviour are unchanged in this release; it exists
to carry the licence change.

What changes for you:

- **Non commercial use stays free**, perpetually and irrevocably while you comply.
- **Commercial use now requires a paid licence.** The trigger is revenue, and it
  includes purely internal use inside a business that earns revenue.
- **If you deploy it, you publish the corresponding source.** That binds everyone,
  including paying customers, and cannot be bought out of.
- **Attribution is required of everyone** and cannot be waived.
- **Cooperatives, nonprofits, educational institutions, public bodies and worker
  owned businesses pay no fee.**

This is **source available, not open source**. It fails clause 6 of the Open
Source Definition because commercial use is conditional on payment. Automated
licence scanners report it as unknown, and GitHub shows it as "Other".

**Nothing here is retroactive, and it could not be.** `@oxy.so/api@1.0.3` was published
under MIT and stays MIT forever for anyone who has it. They may keep
using it, commercially, at no charge, indefinitely, and may fork it. A licence
change binds future versions only.

### `@oxy.so/db` had to move too

The Breathe License is **not compatible with the GPL or the AGPL**, in either
direction. `@oxy.so/api` imports `@oxy.so/db` in process, and `@oxy.so/db` was
`AGPL-3.0-only`, so relicensing this package alone would have produced a
combination distributable under neither licence. Oxy owns both, so this is a
decision rather than a negotiation, but it IS a decision the migration plan
never made: `@oxy.so/db` postdates that analysis and sits in no layer.

### `NOTICE` now carries real third party obligations

Attribution binds everyone under this licence, so `NOTICE` matters here in a way
it did not before. It records the bundled **GPL-3.0-or-later ffmpeg** binary (an
`optionalDependency` invoked as a separate process, which is aggregation rather
than linking, plus the source offer the GPL requires), the
**LGPL-3.0-or-later** native imaging library sharp loads, with its relinking
statement, and the elections on `node-forge`, `jszip` and `@zone-eu/mailsplit`,
where the alternative in each case is a GPL licence this package cannot accept.

**The standing rule that follows:** if anyone ever links ffmpeg, or any other GPL
library, INTO this process, the combination becomes a GPL derivative and this
package can no longer be distributed under these terms at all.

The major is bumped rather than the change being slipped into a patch. A licence
narrowing must never reach anyone through a routine install.

### Added

- A `LICENSE` carrying the full Breathe License text with its Parameters filled
  in, and a `NOTICE`.

### Still outstanding

- The Licensor's jurisdiction of incorporation, registration number and the
  governing law are **visible placeholders**. They are not guesses, and must be
  filled in before the commercial arm can invoice.
