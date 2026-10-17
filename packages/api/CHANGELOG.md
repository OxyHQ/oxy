# Changelog: `@oxy.so/api`

## Unreleased

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
