# Changelog — `@oxy.so/core`

## 6.11.1

### Changed

- Pins `@oxy.so/contracts` 5.6.0 (the client entry now carries the profile-colour
  gate table `@oxy.so/services` 12.9.0 reads). No API change.

## 6.11.0

### Added

- `follow.errors.{read,mode,offline,signedOut,forbidden,notFound,rateLimited}`
  in all 11 locales, beside the existing `follow.errors.update`: the words
  `@oxy.so/services` 12.8.0 gives each follow error code, so a failed follow no
  longer toasts English (or the server's English message) in every language.

## 6.10.0

### Added

- `users.moderators(communityId)`: a community's moderators (its active
  members), public like the community — `GET /users/:id/moderators`, 404 for any
  other kind. Cached 5 minutes.

### Changed

- `@oxy.so/contracts` 5.5.0: `accounts.create` takes `kind: 'community'`.

## 6.9.3

### Fixed

- 6.9.2 allowed the wrong host. The Oxy API signs virtual-hosted part URLs —
  `https://oxy-files.fa4392797e57d4e63ceaaf7b1dc687ed.r2.cloudflarestorage.com/…`,
  the bucket as the first label — and a CSP host-source matches one host
  exactly, so 6.9.2's bare account host admitted no URL the API ever signs:
  measured from a real Chromium page on mention.earth carrying 6.9.2's policy,
  the PUT was still refused. The baseline now names the bucket host, exported as
  `OXY_FILES_UPLOAD_ORIGIN`; an Oxy API test signs a real part URL with
  production's endpoint and bucket and requires its origin to equal it.

## 6.9.2

### Fixed

- Large uploads from a web page failed before sending a byte on every Oxy origin
  whose Content-Security-Policy comes from `buildOxyCspDirectives` (mention.earth,
  accounts, auth, console and inbox, among others): `assets.upload` over 64 MiB
  and `assets.uploadLarge` PUT their parts straight to the Oxy Files bucket
  (ADR 0047), and `connect-src` did not allow its host. The baseline's
  `connect-src` now carries
  `https://fa4392797e57d4e63ceaaf7b1dc687ed.r2.cloudflarestorage.com`, R2's S3
  endpoint for the bucket (the only host that serves its S3 API). An app picks it
  up by moving to 6.9.2 and redeploying the page that sends its CSP.

## 6.9.1

### Fixed

- 6.9.0 crashed every backend running on Bun the first time its session-revocation
  feed connected: `TypeError: undefined is not an object (evaluating
  'this.ws._socket.unref')`. The feed passed Socket.IO's `autoUnref`, which
  engine.io-client implements by calling the `ws` package's private
  `ws._socket.unref()`; under Bun, `ws` is Bun's WebSocket and has no `_socket`.
  `autoUnref` is now used only where it works (Node); under Bun the feed is an
  ordinary connection, opened only by a serving process's auth middleware and
  closed by `OxyServer.dispose()`. `AUTO_UNREF_SUPPORTED` says which applies.
  A Bun test (`bun run test:bun`) opens the real feed against a real Socket.IO
  server in CI; it fails on 6.9.0 with the production error. Do not run 6.9.0.

## 6.9.0

Security fix. Needs `@oxy.so/contracts` 5.4.0, the release carrying
`sessionRevocation.ts` (`oxySessionRevocationEventSchema`, the
`/service-events` names) and an Oxy API serving `/service-events`.

### The session-validation cache, stated plainly

Since 6.2.0 (the entry below is filed under 6.1.0, which never had it),
`middleware.auth()` and `middleware.socket()` reuse a successful
`GET /session/validate-header/:id` answer on the process for
`sessionValidationCacheTtlMs` (default 30 s), per session and SHA-256 of the
bearer, never past the token's `exp`. Through 6.8.0 nothing told that cache a
session had been revoked unless the app wired `oxy:user:invalidate` itself —
and that broadcast never carried logouts at all — so on every backend a
signed-out, signed-out-everywhere, removed-device, deleted or archived session
kept validating for up to 30 s per process.

### Fixed

- The cache is used ONLY while `OxyServer`'s own revocation feed from Oxy is
  live. `OxyServer` opens it by itself, the first time the auth middleware
  would use the cache: a Socket.IO connection to `/service-events` on the API
  origin, authenticated with the service token it already mints (`serviceAuth`
  or workload identity). No app wiring, no Redis client. The feed is live while
  connected and a heartbeat arrived within 12 s; Oxy sends heartbeats only
  while it can still hear revocations.
- Not live — never connected yet, disconnected, heartbeat late, or no service
  token at all (a test, a local checkout) — every request asks Oxy and nothing
  is stored. Every interruption drops every entry, and an answer in flight
  across one is not stored.
- Oxy announces every session it ends: logout, sign-out everywhere, device
  removal, an account switched away from, an operator or admin revocation, a
  credential change that ends sessions, supervision enrollment, agent-key
  revocation, account deletion and archive. The announced session's entries (or
  every entry of the account, whose cached identity is swept too) are dropped
  at once, and nothing for it is stored for the TTL after, so a late answer
  from an API task that had not heard yet cannot re-cache it.
- A delegated session's answer (an operator acting as another account) is no
  longer cached at all: Oxy re-checks a delegate's authority lazily, so there is
  no moment at which to announce its loss.
- The feed's connection is unref'd and reconnects by itself with a fresh token;
  `OxyServer.dispose()` closes it. Oxy admits only internal-tier service tokens;
  any other backend never caches.

Unchanged: `auth({ freshSession: true })`, `session.validate(id, { fresh: true })`,
`sessionValidationCacheTtlMs: 0`, `invalidateSessionValidations()` and
`createOxyUserInvalidationHandler({ oxy })`.

### Added

- `ServerSessionApi.applyRevocation(event)`.

## 6.8.0

### Added

- `readResponseBody(response, { maxBytes, timeoutMs })` and
  `readResponseJson` in `@oxy.so/core/server`: the body half of `safeFetch`.
  `safeFetch`'s `headersTimeoutMs` ends at the response headers, so a server
  that sent its headers and then stalled held a plain `'data'`/`'end'` reader
  forever. These cap the bytes and give the whole body one deadline, destroy
  the stream past either, settle exactly once with their timer cleared and
  listeners removed, and never reject: the answer is `ok`, `too_large`,
  `timeout` or `error` (plus `invalid_json`). Both limits are required.
- `withDeadline(work, { timeoutMs, signal? })` in `@oxy.so/core/server`: wait
  for work that can only be abandoned (a DNS lookup, a read-only fetch) no
  longer than a deadline; answers `ok`, `timeout` or `aborted`, rethrows the
  work's rejection, and clears its timer and abort listener on every path.

### Fixed

- `safeFetch`'s DNS lookup had no deadline: `getaddrinfo` is reached by no
  socket timeout and no `AbortSignal`, so an unanswered lookup held the request
  past every deadline its caller set. `assertSafePublicUrl` now waits at most
  `lookupTimeoutMs` (default `DNS_LOOKUP_TIMEOUT_MS`, 8 s, exported) and no
  longer than an optional `signal`; `safeFetch` passes its `headersTimeoutMs`
  and `signal`. A lookup that ran out is `{ ok: false, incomplete: true }`, and
  `safeFetch` throws `UpstreamError` for it, not `SsrfRejection`: unknown is
  not refused.

## 6.7.0

### Changed

- A file over `ASSET_MULTIPART_UPLOAD_MAX_BYTES` (and every `uploadLarge`) is
  now a presigned **multipart** upload straight to storage (Oxy API
  `POST /assets/uploads`, ADR 0047), up to 8 GiB, instead of one presigned PUT:
  8 MiB+ parts in parallel (`partConcurrency`, default 4), each retried with
  backoff (`partAttempts`, default 6), a fresh URL when storage refuses an
  expired one, and Oxy verifies the assembled file's SHA-256. `onProgress`
  reports `hash`, `upload` and the new `verify` phase. When a part keeps
  failing it throws `DirectUploadInterruptedError` (`uploadId`); calling again
  with the same file resumes and sends only the missing parts. `signal` stops
  it; `assets.abortUpload(uploadId)` discards it. Parts go through
  `XMLHttpRequest` wherever it exists (React Native sends slices of the native
  Blob). Needs the API with `POST /assets/uploads`.

### Added

- `MAX_UPLOAD_BYTES`, `DirectUploadInterruptedError`, `DirectUploadProgress`.

## 6.6.0

### Changed

- `oxy.assets.upload` never sends a request body the API's proxy refuses
  (100 MB), for any file size, on the web and on React Native. A file over
  `ASSET_MULTIPART_UPLOAD_MAX_BYTES` (64 MiB, exported) goes straight to
  storage — hash, `/assets/init`, presigned PUT, `/assets/complete` — and is
  answered in the same `{ file: UploadedAsset }` shape, `onProgress(100)` at
  the end as before. An SVG of any size stays on the API path, which
  sanitizes it. Needs the API's `/assets/complete` that answers `ext`,
  `visibility` and `metadata`.
- On React Native a descriptor without a `size` is read once into a native
  Blob (through RN's `XMLHttpRequest`, never Expo's `fetch`, which copies the
  bytes into the JS heap) to learn its size; a small one still goes into the
  multipart body as-is, and a uri RN cannot read that way goes multipart as
  before. Pass `size` when it is known to skip the read.
- `oxy.assets.uploadLarge` works on React Native: its hashing reads RN Blobs
  through `FileReader.readAsArrayBuffer` (RN's Blob has no `arrayBuffer`),
  8 MiB at a time, and the PUT goes through `XMLHttpRequest` wherever it
  exists, so React Native reports bytes sent too. The PUT names the signed
  `Content-Type` explicitly.
- `completeUpload` is bounded like an upload (10 minutes), not by the 5 s
  JSON default: a public file's bytes are copied under the public prefix
  before it answers. `CompletedAssetUpload['file']` gains `ext`,
  `visibility` and `metadata`.

## 6.5.0

### Added

- `oxyTrustProxy`, an Express `trust proxy` function for every Oxy backend:
  `app.set('trust proxy', oxyTrustProxy)`. It trusts the socket peer only when
  it is private (the ALB, a sidecar, a local proxy) and the next hop only when
  it is a published Cloudflare edge address, so `req.ip` is the real client
  whether the hostname is DNS-only or proxied by Cloudflare, and a forged
  `X-Forwarded-For` is never believed. `trust proxy = 1` reported Cloudflare's
  edge as the client on a proxied hostname, collapsing every rate limit and
  auth throttle onto a handful of addresses.
- `resolveClientIp(req)`, the same rule for a raw `IncomingMessage` (a `ws`
  upgrade, a socket.io handshake's `socket.request`).
- `isCloudflareAddress`, `isPrivateProxyAddress`, `CLOUDFLARE_IPV4_RANGES`,
  `CLOUDFLARE_IPV6_RANGES`.

## 6.4.0

### Added

- Locale strings `follow.*` in every locale: the follow buttons' words per
  verb (`follow.verbs.{follow,subscribe,join,watch}.{idle,active}`), their
  accessibility lines (`undo`, `undoNamed`, `checking`, `checkingNamed`),
  `follow.pending`, `follow.disabled`, `follow.named` (a label beside a
  handle) and the "Follow all" button's `follow.all.*`.
- The follow menu's words: `follow.verbs.<verb>.everywhere` ("Leave
  everywhere"), `follow.menu.*` (timed choice and its toast, show / don't show
  in an app, "this app", the options button's name and hint),
  `follow.durations.*` (the default timed-follow durations) and
  `follow.errors.update`.

## 6.3.0

Needs `@oxy.so/contracts` 5.3.0.

### Changed

- `NotificationActor.name` is the canonical `UserNameResponse`
  (`displayName`, `first`, `last`, `full`, each optional) instead of a required
  `{ first, last }` pair: an organization, channel or community actor is named
  by its title in `name.displayName`. Code that read `name.first` as a string
  must handle `undefined` and should render `name.displayName`.

### Added

- `isValidAccountName(value, kind)`: the one kind-aware name check, for the
  API and clients. A `personal` account is held to `isValidDisplayName` (no
  digits) and `MAX_DISPLAY_NAME_LENGTH`; every other kind to the plain-text
  title policy ("Studio 54", "Blink-182") and its 300-character cap.
- `accountNameMaxLength(kind)`, `accountNameInvalidMessage(kind)`,
  `accountNameInvalidKey(kind)` (the locale-key leaf) and
  `ACCOUNT_TITLE_INVALID_MESSAGE`.
- Locale strings `accounts.kinds.community` and `invalidTitle` under
  `accounts.create.displayName`, `accounts.settings.displayName` and
  `editProfile.items.displayName` (en-US, es-ES).

## 6.2.1

### Fixed

- `OxyServer.assets.references.reconcile` no longer fails a whole inventory on
  one refused page. Pages go at most 200 a minute (Oxy allows an application
  240), and every request of the session — begin, page, commit, status, release
  — waits out a 429 for the `retryAfterSeconds` Oxy names (else a doubling
  fallback, at most 60 s, eight times) before sending again. A refused request
  never ran, so sending it again is safe. Before, the first 429 failed the
  inventory and the release that followed was refused too, which left the
  session open and the entity type blocked until it expired. An application's
  own pacing of the inventory is no longer needed (and does no harm).

## 6.2.0

### Added

- `User.reputationTotal`: the public reputation total, on single-profile reads
  (`/profiles/username/:username`, `/profiles/resolve`). A profile screen reads
  it with `_count` instead of calling `oxy.reputation.balance(userId)` after the
  profile loads. Served by the Oxy API from this release on; older APIs omit it.

## 6.1.0

Needs `@oxy.so/contracts` 5.1.0 and the Oxy API with migration
`0185_email_change_and_reauth`.

### Added

- `oxy.auth.email.startChange(email)`, `oxy.auth.email.change({ email,
  verificationId, code, reauth })` and `oxy.auth.email.remove(reauth)`: add,
  change or remove the signed-in account's email.
- `oxy.auth.password.remove(reauth)`: remove the password while the account
  has an email.
- `OxyServerConfig.sessionValidationCacheTtlMs` (default 30 000; `0` disables).
- `auth({ freshSession: true })`: ask Oxy on every request for one route.
- `server.session.validate(id, { fresh: true })` and
  `server.invalidateSessionValidations({ userId?, sessionId? })`.
- `createOxyUserInvalidationHandler({ oxy })` also drops the user's cached
  validations when `oxy` has `invalidateSessionValidations` (an `OxyServer`).
  A host passing its own evictor object forwards it to keep the immediate drop.
- New strings under `signInSecurity` in every locale.

### Changed

- `middleware.auth()` (and `middleware.socket()`) no longer asks Oxy about the
  same bearer on every request. `server.session.validate(id, { accessToken })`
  reuses a successful answer on this process for 30 s, keyed by session and
  SHA-256 of the bearer (never the raw token), and never past the token's
  `exp`. Refusals, failures and the supervised-action lane are never cached;
  concurrent misses share one call. A revoked session keeps working here for at
  most the TTL, and stops at once on the signals core already receives: an
  `oxy:user:invalidate` event for its account or delegated operator, or a
  logout made through this server. Why: on Mention (2026-10-19 logs) `/notifications/unread-count`
  averaged 316 ms of Oxy time, with this call on its critical path.

### Changed

- `oxy.users.deleteMe(text, { reauth })` and `oxy.identity.links.complete`
  accept any `ReauthProof`: an account without an email confirms with its
  password.

## 6.0.0

Needs `@oxy.so/contracts` 5.0.0. Breaking: removes the two `OxyInferenceClient`
methods that only the retired decisions lane used. Decisions are served by
`https://kaana.ai/v1/decisions` through `@kaana.ai/sdk` (`decisions.create`), and
their records by `kaana.generations` (Kaana ADR 0002).

### Removed

- `OxyInferenceClient.decide()`. The Oxy API's `POST /v1/decisions` is deleted
  with this release; it refused every request since oxy#1809.
- `OxyInferenceClient.getGenerationRecordByIdempotencyKey()`. The route,
  `GET /v1/generations/by-idempotency-key`, stays; call it directly if needed.

## 5.4.0

Needs the Oxy API with migration `0183_reconcile_commit_lease`; an older API
refuses the commit with 400. Same `@oxy.so/contracts`.

### Fixed

- `server.assets.references.reconcile` no longer fails a large entity type with
  `HTTP 0 TIMEOUT`: the commit asks Oxy to run in the background and the SDK
  polls the outcome (up to an hour), and each page has a 30-second budget. A
  commit that failed in Oxy rejects with `RECONCILIATION_COMMIT_FAILED`.
- A dry run releases its session. It used to stay open for an hour, so the
  entity type's next reconciliation was refused with 409
  `RECONCILIATION_IN_PROGRESS`.

## 5.3.0

Needs the Oxy API with migration `0182_play_session_renditions` (a rendition
allow-list on play sessions); an older API refuses the new option with 400.
Needs `@oxy.so/protocol` 1.4.0 (as 5.1.0). Same `@oxy.so/contracts`.

### Added

- `server.assets.streams.create(fileId, { renditions })` (ADR 0043 stage 4c):
  limit a play session to some rungs of the ladder, e.g. `['hls_a64',
  'hls_a128']` for a listener capped at 128 kb/s. The master playlist lists
  only those rungs and Oxy refuses (404) any other rung's playlist, segments
  and key for that session on every request; with `aes-128` each allowed rung
  has its own key. A rung the file lacks is not served; none of them ready is
  409 `STREAM_RENDITIONS_NOT_READY`. An empty list is a `RangeError` before any
  request. The `PlaySessionRendition` type names the rungs, and
  `PlaySessionState.allowedRenditions` reports the list (`null`: the whole
  ladder).

## 5.2.0

Needs no API change. Same `@oxy.so/contracts`.

### Removed

- `oxy.accounts.members.invite` and its `InviteAccountMemberInput` type are
  removed. They added a person to an account without asking them, and the API
  has retired the route behind them: `POST /accounts/:id/members` now answers
  410 Gone (`MEMBER_ADD_RETIRED`) whatever SDK version calls it. Invite by email
  with `oxy.accounts.invitations.create(accountId, { email, role, inherit? })`.
  The person gets access only after accepting at
  `accounts.oxy.so/invitation`. Manage pending invitations with
  `invitations.list`, `resend` and `cancel`. `members.list`, `update` and
  `remove` are unchanged.

## 5.1.0

Needs `@oxy.so/protocol` 1.4.0. Same `@oxy.so/contracts`.

### Changed

- The optional `expo-crypto` and `expo-secure-store` peers admit Expo SDK 58
  (`<59.0.0`; they were `<58.0.0`).

## 5.0.0

Needs nothing new from the Oxy API; the routes these methods called are deleted
with this release (oxy ADR 0042). Same `@oxy.so/contracts`.

### Removed

- The present-requester assertion lane (ADR 0025, superseded by ADR 0042):
  `server.agency.mintRequesterAssertion` and `introspectRequesterAssertion`,
  their `RequesterAssertionGrant` / `RequesterAssertionIntrospection` types, and
  everything `@oxy.so/core/server` exported for it — `createOxyRequesterAssertionAuth`,
  `signOxyRequesterAssertion`, `verifyOxyRequesterAssertion`,
  `readOxyRequesterAssertionKeyId`, `oxyRequesterAssertionClaimsSchema`,
  `OxyRequesterAssertionError`, the `OXY_REQUESTER_ASSERTION_*` constants and
  the `OxyRequesterAssertion*` / `OxyRequesterContext` types. A product's agent
  is an ordinary Alia agent: the person present opens it with their own session,
  and it reaches the product through the product's capability catalogue under
  its owner's ceiling. There is no replacement call.
- `createOxyAliaMachineAuth` no longer refuses an `X-Oxy-Requester-Assertion`
  header: nothing reads it any more. It still refuses `X-Oxy-User-Id`.

### Unchanged

- `createOxyJwksKeyResolver` and `OxyJwksKeyResolverOptions` stay exported from
  `@oxy.so/core/server`; they now live in `server/jwks.ts` beside the app
  assertion verifier that uses them.

## 4.21.1

No API or contracts requirement.

### Fixed

- `createEcosystemTraffic` backs off when publishing fails instead of retrying
  every 2 s forever. A workload Oxy refuses (no binding, a revoked credential)
  used to mint and fail a token on every flush and heartbeat — tnp-relay drew
  36 `attested workload has no binding` refusals a minute in oxy-api for four
  days. Now each consecutive failure doubles the wait (2 s up to 10 min, jitter
  between half and all of it), flushes and heartbeats are skipped while
  waiting (the collector keeps aggregating, bounded as before), and the first
  successful publish resets it. `stop()` still flushes and deregisters.
- `onError` is called ONCE when publishing starts failing (it now receives the
  error), not on every attempt; the default logs one line. New `onRecover` is
  called once when it succeeds again (default: one `console.info`).
- New exports: `publishBackoffMs`, `PUBLISH_BACKOFF_BASE_MS`, `PUBLISH_BACKOFF_MAX_MS`.

## 4.21.0

Needs the Oxy API with ADR 0043 stage 4c — private person media and consent
grants, play sessions, audio renditions, recording targets, large imports by
URL and sanitized SVG (migration `0180_file_access_streams_ingests`). Same
`@oxy.so/contracts` (4.24.0). (First prepared as 4.19.0, then 4.20.0, which
#1721 and #1770 took.)

### Changed

- `OxyServer.assets.importAppFile`, `importAppFiles` and `importUserMedia`
  accept sources up to 8 GiB (ADR 0043 stage 4c): Oxy fetches one over 40 MiB
  in the background and the API answers `202 { importId, status, source }`;
  the SDK waits for it (polling `GET /assets/service/{app,user-media}/imports/:importId`,
  2 s backing off to 10 s, `waitMs` default 60 min, `signal` honoured) and
  resolves to the same import result as before. A failed import rejects with
  the `OxyApiError` of its status and code (`details.importId`); a wait that
  runs out rejects with `IMPORT_WAIT_TIMEOUT`. In a batch, such an item is
  waited for and answers like the others (`ok: false` with its error when it
  fails). `FileImportOptions` gains `audio` and `waitMs`.
- Uploads and imports by a service accept audio as well as images and videos,
  and SVG, which Oxy sanitizes and stores sanitized (its `sha256` is the
  sanitized bytes'). `oxy.assets.uploadLarge` sends an `image/svg+xml` Blob
  through `assets.upload` (the API refuses SVG on `/assets/init` with 415
  `SVG_UPLOAD_REQUIRES_SANITIZATION`, since presigned bytes never pass through
  it) and answers in its own shape, `deduplicated: false`.
- `OxyServer.assets.linkedDownloadUrls` also answers a person's file THIS
  application stored for them (a user-media upload, import, large upload or
  recording), unless the person revoked that; nothing changes in its shape.
- `fileEvents.ts`: the signature check is shared with key authorization
  (`verifyOxySignature`, internal); `verifyFileEventSignature` behaves as
  before and refuses a `stream.key_authorization` request.

### Added

- Stage 4c of ADR 0043 on `OxyServer.assets`:
  - **A person's private media from a service**: `uploadUserMedia(ownerUserId,
    bytes, mime, { visibility?, audio?, … })` sends `x-visibility` (default
    `public`); a `private` file never reaches the CDN, and only its person and
    the application that stored it can read it. `uploadAppFile` and
    `uploadUserMedia` send `audio` as `x-audio-options`; imports, large
    uploads and recording targets send it as `audio`.
    `AudioRenditionOptions` (`{ normalizeLoudness?, previewStartSeconds? }`):
    an audio file gets an audio-only HLS ladder (AAC 64k/128k/256k), a
    waveform and a 30-second preview.
  - **Play sessions**: `streams.create(fileId, { endUserId?, ttlSeconds?,
    encryption?, keyAuthorization? })` → `PlaySession` (`{ sessionId,
    masterUrl, renditions, previewUrl?, waveformUrl?, expiresAt, … }`,
    `POST /assets/service/streams`), `streams.get(sessionId)`,
    `streams.revoke(sessionId)` and `streams.revokeWhere({ fileId?,
    endUserId? })`. A session is one file's HLS ladder for at most 12 hours;
    every playlist, segment and key is checked against it, so revoking stops
    playback at the next request. `aes-128` (default) encrypts the segments
    with a key served only inside the session; `keyAuthorization: 'webhook'`
    asks the application's file-events endpoint first. `ttlSeconds` outside
    60–43200 is a `RangeError` before any request. Types `PlaySession`,
    `PlaySessionOptions`.
  - `verifyStreamKeyAuthorization(rawBody, headers, secret, { toleranceSeconds?, now? })`
    → `StreamKeyAuthorizationRequest` (`{ id, type, occurredAt, session: {
    id, fileId, endUserId, expiresAt } }`), with
    `STREAM_KEY_AUTHORIZATION_EVENT_TYPE`, `StreamKeyAuthorizationAnswer`
    (`{ allow }`) and `StreamKeyAuthorizationVerificationError`, from
    `@oxy.so/core/server`: the synchronous `stream.key_authorization` request,
    signed like a file event; answer `{ allow: true }` within 3 s.
  - **Recording targets (LiveKit egress)**: `createAppRecordingTarget({
    visibility, filename?, metadata?, reference?, maxBytes?, expiresInSeconds?,
    audio? })` and `createUserRecordingTarget(ownerUserId, { … })` →
    `CreatedRecordingTarget` (`{ targetId, filepath, s3, livekit, expiresAt }`
    — `livekit` is LiveKit's `EncodedFileOutput` `{ filepath, s3 }` as it is;
    S3-compatible credentials that accept exactly that one object);
    `getRecordingTarget(targetId, { ownerUserId? })`,
    `completeRecordingTarget(targetId, { ownerUserId?, waitMs?, signal? })`
    (waits while Oxy verifies, default 10 min; `RECORDING_WAIT_TIMEOUT`;
    rejects with the target's own error once it failed) and
    `abortRecordingTarget(targetId, { ownerUserId? })`. Types
    `RecordingTarget`, `RecordingTargetOptions`, `RecordingTargetCredentials`,
    `CreatedRecordingTarget`.
  - `getImport(importId, { ownerUserId? })` → `FileImportState`: a background
    import as it stands. `PendingFileImport` is the `202` it answers first.
- `oxy.assets.listAppAccess(fileId)` → `FileApplicationAccess[]` (`{
  applicationId, name, icon, via: ('upload' | 'link')[], since }`) and
  `oxy.assets.revokeAppAccess(fileId, applicationId)` →
  `FileApplicationAccessRevocation` (`{ fileId, applicationId, revoked,
  streamsRevoked }`): the applications that can read one of the signed-in
  person's files with their own token, and taking that away (`GET` /
  `DELETE /assets/:id/access…`, ADR 0043 stage 4c). A revocation stops the
  application's play sessions of the file at once and holds when it stores
  the same bytes again; attaching the file to it yourself (`assets.link`)
  restores it.
- `fileManagement.appAccess.*` strings in all eleven locales, for the file
  manager's "Apps with access".
## 4.20.0

Needs `@oxy.so/contracts` 4.24.0. Additive: nothing existing changes behaviour.

### Added

- App assertions (ADR 0045), in `@oxy.so/core/server`:
  `verifyAppAssertion(token, { session })` returns
  `{ applicationId, platform }` when the `OXY-APP+JWT` verifies against Oxy's
  JWKS (`/capabilities/.well-known/jwks.json` on the issuer, fetched and cached)
  and its `sub`/`sid` are the request's verified person and session, and `null`
  for anything else. `readAppAssertionHeader(req)` reads
  `X-Oxy-App-Assertion`. Oxy signs with `signOxyAppAssertion`;
  `verifyOxyAppAssertion`, `readOxyAppAssertionKeyId`, `OxyAppAssertionError`
  and `oxyAppAssertionClaimsSchema` are the format.
- `oxy.apps.assertions.challenge`, `.registerAttestKey` and `.create`
  (`AppAssertionsApi`): the app-side calls `@oxy.so/services` drives.
- `OxyServer.agency.agentAvailability(agentAccountId)` (ADR 0044): where an
  agent opens (`AgentAvailability`), on the coordinator lane. Fails closed:
  anything but a valid answer throws.

## 4.18.0

Needs the Oxy API with application-owned files, file references, the file
lifecycle, import by URL, application deletion, file events and content
claims, large uploads, adoption and counter-notices (ADR 0043, migrations
`0169_application_owned_files`, `0170_file_references`, `0171_file_lifecycle`,
`0172_application_file_events`, `0173_content_claims`,
`0174_file_upload_sessions` and `0175_content_claim_counter_notices`), and
`@oxy.so/contracts` 4.22.0. (The work below was first prepared as 4.12.0,
then 4.13.0, then 4.14.0, then 4.15.0, then 4.16.0, then 4.17.0; each of those was published or taken from `main`
without it.)

### Changed

- `oxy.assets.list()` lists the signed-in person's LIBRARY — `active` files
  and `blocked` ones — and no longer files in trash (it used to list every
  file not deleted). `oxy.assets.list({ status: 'trash' })` lists the trash,
  most recently trashed first, each with `trashedAt` (also new, optional, on
  `FileMetadata`); restore one with
  `assets.restore(id)` or delete it for good with `assets.delete(id)`.
  `assets.restore` of a file that is not in trash (restored or deleted
  meanwhile, or blocked after a claim) is a 409 `FILE_NOT_IN_TRASH` — it was
  a 500 — and evicts the cached record and URLs like `trash` does.
- A file can be `blocked`: taken down after a content claim (ADR 0043 D10).
  `Asset.status` is `'active' | 'trash' | 'blocked' | 'deleted'`, and the
  service views that list a live file (`ServiceAssetMetadata`,
  `ServiceAssetMetadataBySha`, `ApplicationFile`, `ServiceUserMediaImport`)
  carry the new `AssetLiveStatus` (`'active' | 'trash' | 'blocked'`). A
  blocked file is never served; an exhaustive `switch` over the old unions
  needs the new case. `FileEvent` delivers `file.blocked` and
  `file.unblocked` (already in `FILE_EVENT_TYPES`) with `file.status:
  'blocked'` / the restored status.
- Every upload and import (`assets.upload`, `OxyServer.assets.uploadAppFile`,
  `uploadUserMedia`, `importAppFile(s)`, `importUserMedia`) can answer 451
  `CONTENT_BLOCKED`: those bytes were taken down and cannot be stored again,
  by anyone.

### Breaking

- `oxy.apps.delete(applicationId, { confirmName })`: the second argument is
  required. Deleting an application now deletes every file it owns and every
  reference it registered at once (ADR 0043 D8), so the API refuses the delete
  (400 `CONFIRM_NAME_MISMATCH`) unless `confirmName` is the application's
  current name (trimmed, case-sensitive). Resolves to
  `ApplicationDeleteResult` (`{ success, filesDeleted, referencesRemoved }`).

### Added

- `OxyServer.assets.uploadAppFileLarge(source, { mime, visibility, filename?, metadata?, reference?, sha256?, partConcurrency?, partAttempts?, verifyTimeoutMs?, onProgress?, signal? })`
  and `uploadUserMediaLarge(ownerUserId, source, { … visibility? })` →
  `LargeServiceUploadResult` (`{ file, deduplicated, uploadId, reference? }`):
  a file of ANY type up to 8 GiB by a resumable multipart upload
  (`/assets/service/app/uploads`, `/assets/service/user-media/uploads`, ADR
  0043 stage 4b). `source` is a `Blob`, bytes, or a file path (Node 20+
  `fs.openAsBlob`); it is hashed 8 MiB at a time, its parts PUT straight to
  storage on presigned URLs (`partConcurrency`, default 4, each retried, an
  expired URL refreshed), and Oxy verifies the assembled file against the
  declared SHA-256 before it is one. Calling again for the same bytes resumes,
  sending only the parts storage lacks. A verification that ends without a
  file rejects with `LargeUploadFailedError` (`code`, `uploadId`); a refusal
  at open or completion rejects with the API's error (415 for executables and
  active documents, 413, 451 `CONTENT_BLOCKED`, 422 `CHECKSUM_MISMATCH`).
  `abortAppFileUpload(uploadId)` / `abortUserMediaUpload(ownerUserId,
  uploadId)` abandon one. Types `LargeUploadSource`,
  `LargeServiceUploadOptions`, `LargeServiceUploadResult`,
  `LargeUploadProgressEvent`, `LargeUploadSession` from `@oxy.so/core/server`.
- `OxyServer.assets.adoptAppFile(fileId, { visibility, reference? })` →
  `ApplicationFileAdoption` (`{ file, outcome: 'adopted' | 'existing',
  deduplicated, reference? }`): the calling application takes its own file of
  the bytes a file it can read holds (`POST /assets/service/app/adopt`, ADR
  0043 stage 4b), sharing the stored object — no re-upload. Never more visible
  than the source (400 `VISIBILITY_WIDER_THAN_SOURCE`); 404 for anything it
  cannot read; 451 for taken-down bytes.
- `oxy.contentClaims.submitCounterNotice(notice)` (`ContentClaimsApi`): the
  signed-in owner of content a claim took down disputes it
  (`POST /content-claims/counter-notices`, ADR 0043 D10; body
  `ContentClaimCounterNotice` from `@oxy.so/contracts` 4.22.0) →
  `ContentClaimCounterNoticeResponse`.
- `OxyServer.assets.importAppFile(sourceUrl, { visibility, reference?, revalidate?, signal? })`
  → `ApplicationFileImport` (`{ file, outcome, deduplicated, source, reference? }`):
  Oxy fetches the URL itself (https only on every hop, public addresses only,
  at most 5 redirects, 40 MiB, 60 s) and the calling application owns the file
  (`POST /assets/service/app/import`, `files:app:write`, ADR 0043 D7). The same
  URL imported again answers the existing file without fetching
  (`outcome: 'existing'`); `revalidate` asks the source conditionally
  (`not_modified`, or `downloaded` with the new bytes as a new file).
  `reference` registers the application's use in the same request (needs
  `files:references:write`).
- `OxyServer.assets.importAppFiles(items)` → `ApplicationFileImportBatchResult[]`
  (`POST /assets/service/app/import/batch`, 50 per request, each item
  `{ index, ok: true, … }` or `{ index, ok: false, error }`).
- `OxyServer.assets.importUserMedia(ownerUserId, sourceUrl, { visibility?, reference?, revalidate?, signal? })`
  → `ServiceUserMediaImport` (`POST /assets/service/user-media/import`, the
  authority of `uploadUserMedia`; public unless `visibility` says otherwise).
- Types `FileImportOutcome`, `FileImportSource`, `FileImportOptions`,
  `ApplicationFileImport`, `ApplicationFileImportBatchResult`,
  `ServiceUserMediaImport`.
- `verifyFileEventSignature(rawBody, headers, secret, { toleranceSeconds?, now? })`
  from `@oxy.so/core/server` → `FileEvent | FileWebhookChallenge`: checks the
  `oxy-signature: t=…,v1=…` HMAC-SHA256 over `<t>.<raw body>` and a 300-second
  replay window, and hands back the endpoint challenge to echo. Also
  `FILE_EVENT_TYPES`, `FILE_EVENT_SIGNATURE_HEADER`,
  `FILE_EVENT_DEFAULT_TOLERANCE_SECONDS`, `FileEventVerificationError`, types
  `FileEvent`, `FileEventType`, `FileWebhookChallenge` (ADR 0043 D9).
- `oxy.apps.getFilesWebhook(appId)`, `setFilesWebhook(appId, url)` (verifies
  the endpoint with a challenge; returns the new signing secret ONCE) and
  `removeFilesWebhook(appId)`; `Application.filesWebhookUrl?`,
  `Application.filesWebhookVerifiedAt?`; types `ApplicationFilesWebhook`,
  `ApplicationDeleteResult`.
- `oxy.assets.trash(fileId)`: the owner moves their own file to trash (not
  served, kept until restored or deleted; ADR 0043 D5).

- `OxyServer.assets.references.reconcile(entityType, items, { dryRun? })` →
  `ServiceReferenceReconcileResult` (`{ sessionId, entityType, dryRun, added,
  removed, unchanged, refused }`): reconciles the calling application's
  references of one entity type with its real inventory (ADR 0043 D6, scope
  `files:references:write`). `items` is an array or any (async) iterable of
  `{ fileId, entityId }`, sent in pages of 1,000 over
  `POST /assets/service/references/reconcile`, `PUT …/:sessionId`,
  `POST …/:sessionId/commit`; on a failure while sending, the session is
  released (`DELETE …/:sessionId`) before the error is rethrown. Stale
  references are removed only when created before the reconciliation began,
  and removing one never trashes a file. One reconciliation per entity type
  at a time (409 `RECONCILIATION_IN_PROGRESS`).
- Types `ServiceReferenceInventoryItem`, `ServiceReferenceReconcileResult`.
- `Asset.inUse?`, `Asset.unreferencedSince?`, `Asset.trashedAt?` on the
  owner's own view (`assets.list`, `assets.get`), and `assets.list({ inUse })`
  to list only the files an application uses (`true`) or none does
  (`false`). A file not in use is never removed for its owner (ADR 0043 D5).

- `OxyServer.assets.references.add(references)` / `.remove(references)` →
  `ServiceFileReferenceResult[]`: the calling application records and removes
  its own uses of files (`POST`/`DELETE /assets/service/references`, scope
  `files:references:write`). `references` is `ServiceFileReference[]`
  (`{ fileId, entityType, entityId }`); the application is the service
  token's and is never sent. Batches above 100 are split into ordered
  requests. Per item: `created` / `exists` / `removed` / `not_found`.
- Types `ServiceFileReference`, `ServiceFileReferenceResult`.

- `OxyServer.assets.uploadAppFile(bytes, mime, { visibility, originalName?, metadata?, signal?, timeout? })`
  → `ApplicationFileUpload`: stores a file the CALLING APPLICATION owns
  (`POST /assets/service/app`, scope `files:app:write`). `visibility` is
  required; a re-upload of the same bytes returns the existing file,
  `deduplicated: true`, visibility unchanged. A third-party application's
  bytes count toward its developer's storage plan (413
  `STORAGE_QUOTA_EXCEEDED` over it); Oxy's own applications are not metered.
- `OxyServer.assets.setAppFileVisibility(fileId, visibility)` → `ApplicationFile`,
  `deleteAppFile(fileId)` (`files:app:delete`; 404 for another application's
  file, 409 `FILE_IN_USE`), `listAppFiles({ limit?, cursor? })` →
  `ApplicationFilePage`.
- `OxyServer.assets.uploadUserMedia(ownerUserId, bytes, mime, { originalName?, metadata?, signal?, timeout? })`
  → `ServiceUserMediaFile`, over the existing `POST /assets/service/user-media`
  (`files:user-media:write`).
- Types `ApplicationFile`, `ApplicationFileUpload`, `ApplicationFilePage`,
  `ServiceUserMediaFile`; `ServiceUploadBody`, `ServiceUploadDescription` from
  `@oxy.so/core/server`.
- `HttpService` sends a `Uint8Array` / `ArrayBuffer` / `Blob` body as raw bytes
  under the caller's `Content-Type` (default `application/octet-stream`)
  instead of JSON-encoding it.

### Changed

- Removing the last reference to an account's file no longer moves it to
  trash, on any path (`assets.unlink` included): it stays `active` and reads
  `inUse: false`. Only its owner trashes or deletes it (ADR 0043 D5).
- A file in trash is no longer served: `assets.url` / `assets.urls`, the
  stream and download routes and `linkedDownloadUrls` answer it like a missing
  file, and a public one leaves the CDN until it is restored.
- `AssetLink.app` holds the using application's ID (also in the new
  `AssetLink.applicationId`), never a free-text name; `AssetLink.createdBy` is
  optional (absent on a reference an application made with its token);
  `AssetLink.webhookUrl` is typed and deprecated — and no longer returned or
  called: file events go to the application's own endpoint (D9). `assets.link` takes an
  application id or a legacy name (`goway`, `mercaria`, `nilo`, `oxy-mail`,
  `profiles`) as `app`, and no longer changes the asset's visibility unless
  `visibility` is passed. `assets.unlink` removes only references on your own
  asset or ones you created.
- `Asset.ownerUserId` is optional and nullable (`string | null`): a file owned
  by an application or a system namespace has no owning account. New
  `Asset.ownerApplicationId?` and `ServiceAssetMetadata.ownerApplicationId?`.
  Code that assumed `ownerUserId: string` must handle its absence.

## 4.17.0

Needs `@oxy.so/contracts` 4.21.0.

### Added

- `serviceToken(apiKey?, apiSecret?, { scopes })` and
  `serviceRequest(..., { serviceTokenScopes })`: mint a token holding exactly
  that subset of the live grant (Oxy refuses a scope outside it, and a mint
  that ignores the narrowing is rejected). Each audience, credential and scope
  set has its own cache entry; invalidation clears every variant.
- Supervised personal policy (ADR 0041). `oxy.safety` in a browser:
  `supervisionState`, `inviteGuardian`, `acceptGuardianInvitation`,
  `cancelGuardianInvitation`, `contacts`, `approveContact`, `revokeContact`,
  `reviewSupervision`, `people`, `organizations`, `purchaseApproval(s)`,
  `reviewPurchaseApproval`. On `OxyServer` (`ServerSafetyApi`), the
  consumer-service lanes, each with a token narrowed to `safety:decide`:
  `profileAccess(input, requester)`, `profileAccessBatch`, `messageAccess`,
  `messageAccessBatch`, `deliveryAccess`, `deliveryAccessBatch`,
  `messagingSessions`, `contactAccess`, `contentAccess`, `contentAccessBatch`,
  `publicationPolicy`, `publicationPolicies`, `requestPurchaseApproval`,
  `reservePurchase`, `confirmPurchase`, `cancelPurchase`.
- `middleware.auth({ supervisedAction })` / `socket({ supervisedAction })`:
  validate through the reviewed supervised lane (`ServerSessionApi`), and a
  policy denial is a 403, never an anonymous request.
  `strictOptionalBearer: true` keeps anonymous access on an optional route but
  refuses a presented bad bearer (401), a denial (403) or an authority outage
  (503) instead of downgrading it.

### Changed

- `OxyServer.safety.profileAccess` now asks `POST /safety/service/profile-access`
  with the service's own `safety:decide` token plus the requester proof
  (`{ accessToken }`, `{ accessToken: null }` or `{ connectionToken }`): the
  consumer application needs `safety:decide` first.
- The auth middleware validates the request's bearer through
  `/session/validate-header/` (cross-checked against its session) instead of
  `/session/validate/` by id. `session.validate(id, { accessToken })` does the
  same; without `accessToken` it is unchanged.

## 4.16.0

Needs `@oxy.so/contracts` 4.20.0.

### Added

- `CreateExecutionAuthorizationInput.ceilingId` (`OxyServer.agency.createExecutionAuthorization`):
  name the agent owner's published ceiling that bounds the authority (ADR 0042),
  for an agent acting for the requester on the requester's own account root.
## 4.15.0

Needs `@oxy.so/contracts` 4.19.0. Additive: nothing existing changes behaviour.

### Added

- **Application roles** in `@oxy.so/core/server`: gate a backend's operator
  surfaces on permissions the application declares and Oxy grants to people,
  instead of an allow-list of user ids in the environment.
  - `server.middleware.requireAppPermission(key, { deny?, fresh?, respond?, applicationId? })`
    — after `middleware.auth()`. A refusal answers `404` by default (to a
    non-holder and to a request with no session alike) or `403`/`401` with
    `deny: 403`; Oxy unreachable answers `503`, a missing or unknown
    application id `500`. A service-token request, delegated or not, is
    refused. A malformed key throws at mount time. On success
    `req.oxyAppPermissions` holds the answer; its `operatorId` is the human.
  - `server.appPermissionsFor(req, { fresh?, applicationId? })` — the same
    answer without a middleware: `{ applicationId, operatorId, permissions, has() }`.
    Throws `OxyAppPermissionError` (`APP_PERMISSION_SESSION_REQUIRED`,
    `APP_PERMISSION_UNAVAILABLE`, `APP_PERMISSION_NOT_CONFIGURED`,
    `APP_PERMISSION_DENIED`); never answers "holds nothing" for a failure.
  - `server.invalidateAppPermissions({ userId? })`.
  - `OxyServerConfig.applicationId` (optional when service auth names the
    application) and `OxyServerConfig.appPermissionsCacheTtlMs` (default
    30 000; `0` disables). One answer is reused per (application, session,
    user) for that long; `fresh: true` asks Oxy and refreshes the entry.
  - Exports `OxyAppPermissionError`, `appPermissionErrorStatus`,
    `APP_PERMISSIONS_CACHE_TTL_MS` and the types `OxyAppPermissions`,
    `AppPermissionsOptions`, `RequireAppPermissionOptions`,
    `OxyAppPermissionDenyStatus`, `OxyAppPermissionErrorCode`.
  - Reads `GET /applications/:appId/roles/me` (oxy-api with migration
    `0167_application_roles`). Against an API without it every check denies
    (`APP_PERMISSION_NOT_CONFIGURED`, answered 500).

## 4.14.0

Needs `@oxy.so/contracts` 4.18.0.

### Added

- `OxyServer.accounts.accessFor(accountId, userId)` (`ServerAccountsApi`):
  may this person act for that account, and with what? Calls
  `GET /internal/accounts/:accountId/access/:userId` with the service's own
  token (the application needs `accounts:membership:read`) and returns the
  parsed `AccountAccessVerdict`. Never cached; anything but a valid 200 verdict
  throws, so callers fail closed.
- `oxy.assets.initUpload(...)` and `oxy.assets.completeUpload(...)`: the two
  steps of the direct-to-storage upload (`POST /assets/init`,
  `POST /assets/complete`).
- `oxy.assets.uploadLarge(blob, { mime, name, visibility, metadata, onProgress })`:
  hashes the file in 8 MiB slices (SHA-256, loaded lazily from `@oxy.so/core/crypto`, which now also exports `createContentHasher`), then init → PUT
  to the presigned URL → complete, so no byte passes through the API and the
  file is never held whole in memory. Hashing comes first because the presigned
  URL is short-lived. An empty `uploadUrl` (bytes already stored) skips the PUT
  and answers `deduplicated: true`. On the web the PUT uses `XMLHttpRequest`,
  so `onProgress({ phase, loaded, total })` sees bytes sent; elsewhere `fetch`.
  Types: `LargeUploadOptions`, `LargeUploadProgress`, `LargeUploadResult`,
  `CompletedAssetUpload`.

## 4.13.0

Needs `@oxy.so/contracts` 4.17.0 and `@oxy.so/protocol` 1.3.0. Smaller
startup for every app: measured on Mention web, the startup JavaScript loses
~125 KB raw / ~38 KB gzip with this release and services 11.6.0.

### Changed

- The client entries (`.`, `./session`, `./crypto`, `./civic`, `./logger`) no
  longer import Zod. Responses and request bodies are checked with
  `@oxy.so/contracts/client` (same verdicts and outputs as the schemas). Where
  a schema's `.parse()` used to throw a `ZodError`, the call now throws
  `ContractCheckError` from `@oxy.so/contracts/client`, whose `issues[0]`
  keeps Zod's `code`, `path` and `message`. `./server` and `./inference`
  still validate with the Zod schemas. `clientEntriesZodFree.test.ts` walks
  each entry's graph, into the workspace packages, to keep it that way.
- The identity stack (secp256k1, bip39, the AEAD cipher) loads on first use
  everywhere: the identity-bound session's default key binding imports it
  with `import()`, and every lazy load goes through the ONE module
  `@oxy.so/core/crypto`. A second lazy root (the internal crypto barrel, and
  `KeyManager`'s own lazy `./recoveryPhrase`) made Metro hoist the whole stack
  into the always-loaded common chunk. The polyfill still runs first.
- `@oxy.so/core/crypto` also exports `BACKUP_KDF_ENCRYPTION_INFO`,
  `solveRegistrationPow`, `canonicalize`, `loadCommonsIdentityBridge`,
  `signMessage` and `verifySignature` (they were reached through the removed
  internal barrel).

## 4.12.0

### Added

- `safeFetch` takes `redirect: 'manual'`, which returns the first response even
  when it is a redirect, so the caller can read its `Location`. The URL is still
  validated and the connection pinned. The default stays `'follow'`.

## 4.11.0

### Changed

- `createOxyRateLimit` answers 429 with the API error envelope, as
  `docs/api-conventions.md` requires, instead of a plain-text body:
  `{ error: { code: 'rate_limited', message, details: { retryAfterSeconds } } }`,
  with `retryAfterSeconds` equal to the `Retry-After` header. `message`
  now sets `error.message`.

## 4.10.0

Needs `@oxy.so/contracts` 4.16.0. One email may hold several accounts
(ADR 0040).

### Added

- `oxy.auth.email.choose({ requestId, requestSecret, userId })`: signs in the
  account chosen from those an email holds → a session or the second-factor
  step.
- Locale strings `signin.emailAccounts.*` and
  `signin.errors.emailAccountsFull`, in every locale.

### Changed

- `oxy.auth.email.confirm` and `collect` may answer
  `{ chooseAccount: true, accounts, expiresAt }` (an `EmailSignInStepResult`)
  instead of a session; nothing is planted then.
- `signin.errors.invalidCredentials` says to use the username when several
  accounts share the email.

## 4.9.1

### Fixed

- A GET no longer sends `Content-Type: application/json`. It has no body, and the
  header alone made every cross-origin GET a non-simple request the browser
  preflights.
- `X-Oxy-Activity-Id` and `X-Oxy-Edge-Region` ride only on requests the browser
  preflights anyway (a bearer, a JSON body, a custom header, a non-simple method).
  An anonymous GET is a simple request again, so it no longer waits an `OPTIONS`
  round trip per URL. Measured on a cold load against `api.oxy.so`: two
  preflights to zero, and the public app lookup 1.31 s to 0.66 s.
## 4.9.0

### Added

- `OxyServer.serviceTokenFor(audience, apiKey?, apiSecret?)`: a service token
  minted FOR a resource server, `kaana.ai` being the credential for
  https://kaana.ai/v1 (Kaana ADR 0002 decision 6). Both mints name it — the
  credential's `POST /auth/service-token` and the attested workload's
  `POST /auth/service-token/workload` — and each audience has its own cache
  entry, so one is never answered with another's token.
  `invalidateServiceToken(apiKey)` drops every audience that credential
  minted. Exported with `ServiceTokenAudience` and
  `DEFAULT_SERVICE_TOKEN_AUDIENCE` from `@oxy.so/core/server`.
- `requestWorkloadServiceToken({ audience })`.

### Unchanged

- `serviceToken()` mints for `oxy-api` and sends no `audience`, byte for byte
  as before.

## 4.6.0

### Added

- `accounts.create` takes an optional `character` (an `AvatarCharacter`) for
  `kind: 'bot'`; omitted, the API generates one. `accounts.update` replaces it
  with the same authorization as the other fields (`account:update`). Both are a
  400 for any kind but `bot`.
- `User.character`: the 3D avatar character of a bot, present only on
  `kind: 'bot'` accounts. `AvatarCharacter` is re-exported from
  `@oxy.so/core`'s accounts module.

### Changed

- `User.isAgent` is `kind === 'bot'`, no longer `type === 'agent'`.

## 4.5.0

Promoted from `4.5.0-oxy-one.1` to the stable release; no code change.

### Changed (breaking for `auth.registerKey` callers)

- `auth.registerKey(publicKey, signature, timestamp, username)` takes the
  account's username and sends it: `POST /auth/register` now requires it and
  writes it in the same insert as the key, so an account never exists without
  a username. A taken username is a 409 `Username already taken`. Commons is
  the only caller.

### Fixed

- `assets.upload` no longer times out at the client's 5s per-request default:
  an upload is now bounded at 10 minutes (override with `options.timeout`), so
  a video of a few dozen MB no longer fails with `Request timed out after 5000ms`.

## 4.4.0

### Added

- `OxyServer.apps.introspectAliaMachineCredential` performs an uncached,
  receiver-bound lookup for explicitly scoped app-only Alia chat credentials.
- The server-only `createOxyAliaMachineCredentialAuth` middleware validates
  audience/environment and keeps the forwarding bearer request-scoped without
  turning the caller into a user or internal service. Alia forwards this caller
  to Oxy inference so the caller application remains the payer.


## Unreleased (MINOR — additive; needs the next `@oxy.so/contracts` MINOR)

### Added

- `server.middleware.auth()` exposes who acted (#1520): `getOxyActor(req)`
  returns the `AccountActorChain` the session authority read off the session
  row, or `null` when the API sent none. A chain that does not describe the
  validated session is refused (`SESSION_ACTOR_MISMATCH`). No header or token
  claim can move it. `SessionValidation.actor` carries it on the client.

## 4.1.0

Requires `@oxy.so/contracts` ^4.7.0 (inference contract set 3.5.0).

### Added

- `OxyInferenceClient.decide(request, options)`: typed, non-streaming
  `POST /v1/decisions` with the same bearer, delegation, cancellation and
  idempotency transport as the other calls. The request is validated before
  sending; a success is accepted only when its `model` and question IDs match
  the request and its body `requestId` equals the `X-Oxy-Request-Id` header.
  A repeated `Idempotency-Key` is refused (`idempotency_conflict`), never
  replayed.

## 4.0.0

Android apps no longer share the `so.oxy.shared` UID, and Commons is the only
holder of the identity private key (OxyHQ/oxy#1388). Every other app gets what
it needs from Commons over signature-protected IPC, never the key. iOS is
unchanged (keychain access group `group.so.oxy.shared`).

### Breaking changes

- `oxy.auth.signInWithSharedIdentity()` is `oxy.auth.signInWithCommonsIdentity()`.
  On Android it asks Commons for its public key (`describe`), requests a
  challenge, has Commons sign it (`proveIdentity`) and verifies; on iOS it signs
  with the keychain-group key as before.
- The cold-boot lane `shared-key-signin` is `commons-proof-signin`, and
  `RefreshDeps.allowSharedKeyFallback` is `allowCommonsIdentityFallback`.
- On Android `KeyManager.getSharedPrivateKey()` always resolves `null`;
  `getSharedPublicKey()` reads Commons' `describe`. Use `deriveScopedSeed`,
  the new `signSocialReceive` or `signInWithCommonsIdentity` instead of the key.
- On Android `importSharedIdentity` / `createSharedIdentity` write the identity
  signer store and throw in any app that has not registered one (only Commons
  does).
- On Android an app without a signer store (every app but Commons) cannot
  persist an identity (`createIdentity`/`importKeyPair` throw), always asks
  Commons for seeds and social-receive signatures, and never caches the shared
  public key.
- `KeyManager.beginKeyRotation` / `completeKeyRotation`: `rotateKey` marks the
  new key before writing the shared slot, so `syncSharedIdentity` finishes an
  interrupted rotation from the shared slot instead of reverting it.
- Removed: `KeyManager.migrateToSharedIdentity` (use `syncSharedIdentity`),
  `storeSharedSession`, `getSharedSession`, `clearSharedSession`.
- Requires `@oxy.so/protocol` ^1.2.0.

### Added

- `KeyManager.setIdentitySignerStore(store)` / `hasIdentitySignerStore()` and the
  `IdentitySignerStore` type: Commons registers the native copy of the key its
  identity host signs with. Every persist writes it, every delete clears it,
  `syncSharedIdentity` repairs it, and it is the `shared` rung of
  `attemptIdentityRecovery` on Android.
- `KeyManager.signSocialReceive(index, digest)`: a low-S DER signature by the
  identity's social-receive child key (Peable's wallet), locally or from Commons.
- `KeyManager.deriveScopedSeed` on Android: the app's own primary key (Commons),
  else Commons computes it over IPC (byte-identical; Commons allows each app
  only its own labels).
- `@oxy.so/core/crypto` exports the pure derivations Commons implements
  natively (`deriveScopedSeedFromKey`, `deriveSocialReceiveKey`,
  `signSocialReceiveDigest`, `authChallengeDigest`), pinned against the Commons
  identity host's vectors.

## 3.2.0

### Added

- `common.stepOf` ("Step {{step}} of {{total}}"), in all eleven locales: the
  count under the sign-up and authenticator set-up progress bars.

## 3.1.0

### Added

- `signin.checkEmail.codeHasLetters` ("Does your code have letters?") and
  `signin.checkEmail.codeDigitsOnly` ("Is your code only numbers?"), in all
  eleven locales: the switch between the 6-digit sign-in code and the
  10-character long code.

### Removed

- `reauth.totpLabel`: "Confirm it's you" labels the authenticator code and the
  backup code separately (`signin.secondFactor.label` / `backupLabel`).

## 3.0.3

### Fixed

- A loaded `req.user` takes its `id` from the one source the middleware
  validated (`id`, else `_id`), so it always agrees with `req.userId`.
- `server/workloadIdentity` trims the base URL without `/\/+$/` (polynomial
  backtracking on a long run of slashes); `HttpService` and it share
  `utils/slashes`.

## 3.0.2

### Changed

- Published against `@oxy.so/contracts` 4.x and `@oxy.so/protocol` 1.1.4:
  3.0.1 required contracts `^3.0.0`, so every app on contracts 4 installed a
  second, nested contracts 3.x. No code change.

## 3.0.1

### Fixed

- `OxyServer`'s middleware (`middleware.auth()`, `.service()`, `.socket()`)
  types `req.user` as `OxyRequestUser`, the shape `OxyAuthRequest` already
  declared — it used the full `User`, so an app that augments Express's
  `Request` with `OxyRequestUser` needed a cast to mount them. A validated
  user still carries every field.
- The 3.0 codemod also rewrites calls on `this._oxyServices`, getter calls
  (`oxy()`, `getOxyClient()`) and parenthesised receivers
  (`(a ?? oxy).getUserById`).

## 3.0.0

The client is organised by namespace, the server half is its own class, and
the transport is faster and correct under load. **Breaking:** every flat
method moved. Run the codemod, then fix what it marks:

```sh
bun <oxy-repo>/scripts/codemods/core-3/codemod.ts ./src
grep -rn "TODO(core-3)" ./src
```

### Changed

- **Namespaces.** `oxy.users.get(id)`, `oxy.assets.upload(file)`,
  `oxy.follows.follow(id)`, `oxy.session.accessToken`, … — one namespace per
  API area, each created on first access. Duplicates are gone: one way to read
  a user, one asset URL call, one delete that always clears the cache, one
  "mine" convention (omit the user id). See `docs/api.mdx`.
- **`OxyServer`** (`@oxy.so/core/server`) is the backend client: `OxyServices`
  plus `serviceAuth: { apiKey, apiSecret }` (or workload identity),
  `serviceToken()`, `serviceRequest(…, { actAs })`, `middleware.auth()` /
  `.socket()` / `.service()` / `.requireScope()`, and the service-only
  namespace methods. `OxyServices` no longer carries server code. 2.3.0's
  `serviceIdentity: 'when-anonymous'` is an `OxyServer` option now (a client
  has no service identity to offer): `new OxyServer({ …, serviceIdentity:
  'when-anonymous' })`.
- **Errors.** Every call rejects with `OxyApiError` (`status`, `code`,
  `details`, `cancelled`, `timeout`).
- **Entry points.** The root is the client; `@oxy.so/core/session`,
  `/crypto`, `/civic` and `/inference` hold the heavy parts, so an app that only
  calls the API no longer ships secp256k1, bip39, the session machinery or the
  inference client. Non-English dictionaries load on demand (`loadLocale`,
  `subscribeLocales`).
- Signature changes: extra positional arguments became options objects
  (`assets.upload(file, { visibility, onProgress })`, `assets.link`,
  `assets.delete(id, { force })`, `reputation.transactions(userId, { limit,
  offset })`, …) — each is listed below.

### Fixed

- A burst of 401s (a revoked session under load) could stall every request:
  the refresh retry waited for a queue slot while its original held one.
- Two concurrent uploads with different files were merged into one call (an
  opaque `FormData` body keyed as empty); only GETs are deduplicated now.
- POST/PATCH were re-sent on a 5xx or a dropped connection; only idempotent
  methods (GET, PUT, DELETE) retry.
- One caller cancelling a deduplicated GET cancelled it for every caller.
- A retry's backoff and a deduplicated caller held a queue slot doing nothing.
- `assets.delete(id, { force })` sent `force` in the body; the API reads the
  query.
- `notifications.create` and `reputation.award` sent the user bearer to
  routes that only accept a service token.

### Performance

- No request waits on the Cloudflare edge-region trace any more.
- The access token is decoded once per token, not several times per request;
  the cache/dedupe key is computed once per call.
- Cache invalidation after a write is one pass over the cache; the cache is
  bounded (LRU); `dispose()` releases a client's cache.
- `session.waitForAuth` is event-driven instead of polling.
- No client is constructed at import time (`oxyClient` is gone).

### Removed

- Methods whose routes never existed or were superseded (subscriptions,
  saves/collections, history, FAQs, achievements, feedback, location,
  analytics, chains, `registerDevice`, payment creation), the Oxy-staff
  reputation overrides and disputes, `checkEmailAvailability` (it disclosed
  whether an email has an account), channel provisioning, the passkey-only
  account deletion and identity link, and the default export.

### Method map

#### Client (`OxyServices`)

| 2.x | 3.0 |
|---|---|
| `makeRequest` | `oxy.request` |
| `getBaseURL` | `oxy.baseURL` — now a property: oxy.baseURL |
| `getCloudURL` | `oxy.cloudURL` — now a property: oxy.cloudURL |
| `getClient` | `oxy.http` — now a property: oxy.http |
| `httpService` | `oxy.http` |
| `createLinkedClient` | `oxy.createLinkedClient` |
| `healthCheck` | `oxy.health` |
| `getCacheStats` | `oxy.cache.stats` |
| `clearCache` | `oxy.cache.clear` |
| `clearCacheEntry` | `oxy.cache.delete` |
| `clearCacheByPrefix` | `oxy.cache.deletePrefix` |
| `setTokens` | `oxy.session.setAccessToken` |
| `clearTokens` | `oxy.session.clear` |
| `onTokensChanged` | `oxy.session.onChange` |
| `getAccessToken` | `oxy.session.accessToken` — now a getter: oxy.session.accessToken |
| `getAccessTokenExpiry` | `oxy.session.accessTokenExpiry` — now a getter |
| `getCurrentUserId` | `oxy.session.userId` — now a getter: oxy.session.userId |
| `hasValidToken` | `oxy.session.isAuthenticated` — now a getter |
| `waitForAuth` | `oxy.session.waitForAuth` |
| `validate` | `oxy.session.validateToken` |
| `validateSession` | `oxy.session.validate` |
| `setDeviceCredentialProvider` | `oxy.session.setDeviceCredentialProvider` |
| `readDeviceProof` | `oxy.session.readDeviceProof` |
| `getSessionsBySessionId` | `oxy.session.list` |
| `logoutSession` | `oxy.session.logout` |
| `logoutAllSessions` | `oxy.session.logoutAll` |
| `register` | `oxy.auth.registerKey` |
| `requestChallenge` | `oxy.auth.requestChallenge` |
| `verifyChallenge` | `oxy.auth.verifyChallenge` |
| `checkPublicKeyRegistered` | `oxy.auth.isKeyRegistered` |
| `claimSessionByToken` | `oxy.auth.claimSession` |
| `signInWithSharedIdentity` | `oxy.auth.signInWithSharedIdentity` |
| `checkUsernameAvailability` | `oxy.auth.checkUsername` |
| `startEmailVerification` | `oxy.auth.email.startVerification` |
| `confirmEmailVerification` | `oxy.auth.email.confirmVerification` |
| `startEmailSignIn` | `oxy.auth.email.start` |
| `confirmEmailSignIn` | `oxy.auth.email.confirm` |
| `collectEmailSignIn` | `oxy.auth.email.collect` |
| `approveEmailSignInLink` | `oxy.auth.email.approveLink` |
| `signInWithPassword` | `oxy.auth.password.signIn` |
| `setPassword` | `oxy.auth.password.set` |
| `completeSecondFactor` | `oxy.auth.completeSecondFactor` |
| `signUp` | `oxy.auth.signUp` |
| `getSignInMethods` | `oxy.auth.methods` |
| `requestReauthEmailCode` | `oxy.auth.requestReauthCode` |
| `enrollTotp` | `oxy.auth.totp.enroll` |
| `confirmTotp` | `oxy.auth.totp.confirm` |
| `disableTotp` | `oxy.auth.totp.disable` |
| `regenerateTotpBackupCodes` | `oxy.auth.totp.regenerateBackupCodes` |
| `exchangeOAuthCode` | `oxy.auth.oauth.exchangeCode` |
| `getOAuthUserInfo` | `oxy.auth.oauth.userInfo` |
| `startCommonsSignIn` | `oxy.auth.commons.start` |
| `pollCommonsSignIn` | `oxy.auth.commons.poll` |
| `deliverCommonsSignIn` | `oxy.auth.commons.deliver` |
| `markCommonsApprovalOpened` | `oxy.auth.commons.markOpened` |
| `finalizeCommonsOAuth` | `oxy.auth.commons.finalizeOAuth` |
| `getCommonsApprovalInfo` | `oxy.auth.commons.approvalInfo` |
| `approveCommonsSignIn` | `oxy.auth.commons.approve` |
| `denyCommonsSignIn` | `oxy.auth.commons.deny` |
| `getUserById` | `oxy.users.get` |
| `getUsersByIds` | `oxy.users.getMany` |
| `getCurrentUser` | `oxy.users.me` |
| `getProfileByUsername` | `oxy.users.byUsername` |
| `getUserByPublicKey` | `oxy.users.byPublicKey` |
| `getUserBySession` | `oxy.users.bySession` |
| `getUsersBySessions` | `oxy.users.bySessions` |
| `searchProfiles` | `oxy.users.search` |
| `resolveProfile` | `oxy.users.resolveHandle` |
| `resolveExternalUser` | `oxy.users.resolveExternal` |
| `getSimilarProfiles` | `oxy.users.similar` |
| `getProfileRecommendations` | `oxy.users.recommendations` |
| `updateProfile` | `oxy.users.updateMe` |
| `updateNotificationPreferences` | `oxy.users.updateMe` — (prefs) → ({ notificationPreferences: prefs }) |
| `updateUserPreferences` | `oxy.users.updateMe` — (prefs) → ({ preferences: prefs }) |
| `updateThemePreference` | `oxy.users.updateMe` — (theme) → ({ themePreference: theme }) |
| `requestAccountVerification` | `oxy.users.requestVerification` |
| `deleteAccount` | `oxy.users.deleteMe` — (confirmText) → (confirmText, { deviceKey: true }) |
| `deleteAccountWithEmailCode` | `oxy.users.deleteMe` — (confirmText, reauth) → (confirmText, { reauth }) |
| `downloadAccountData` | `oxy.identity.export` — now the signed export (GET /users/me/export) |
| `followUser` | `oxy.follows.follow` |
| `followUsers` | `oxy.follows.followMany` |
| `unfollowUser` | `oxy.follows.unfollow` |
| `unfollowUsers` | `oxy.follows.unfollowMany` |
| `getFollowStatus` | `oxy.follows.status` |
| `getFollowStatuses` | `oxy.follows.statuses` |
| `getUserFollowers` | `oxy.follows.followers` |
| `getUserFollowing` | `oxy.follows.following` |
| `getUserMutuals` | `oxy.follows.mutuals` |
| `getMutualUserIds` | `oxy.follows.mutualIds` |
| `getFollowsOfFollowsIds` | `oxy.follows.followsOfFollowsIds` |
| `getViewerGraph` | `oxy.follows.viewerGraph` |
| `followTarget` | `oxy.follows.followTarget` |
| `unfollowTarget` | `oxy.follows.unfollowTarget` |
| `getFollowTargetStatus` | `oxy.follows.targetStatus` |
| `setFollowApplicationMode` | `oxy.follows.setApplicationMode` |
| `restoreFollowInheritance` | `oxy.follows.restoreInheritance` |
| `ensureFollowTarget` | `oxy.follows.ensureTarget` |
| `claimFollowNamespace` | `oxy.follows.claimNamespace` |
| `releaseFollowNamespace` | `oxy.follows.releaseNamespace` |
| `registerFollowKind` | `oxy.follows.registerKind` |
| `listFollows` | `oxy.follows.list` |
| `getPrivacySettings` | `oxy.privacy.settings` |
| `updatePrivacySettings` | `oxy.privacy.updateSettings` |
| `getBlockedUsers` | `oxy.privacy.blocked` |
| `blockUser` | `oxy.privacy.block` |
| `unblockUser` | `oxy.privacy.unblock` |
| `isUserBlocked` | `oxy.privacy.isBlocked` |
| `getRestrictedUsers` | `oxy.privacy.restricted` |
| `restrictUser` | `oxy.privacy.restrict` |
| `unrestrictUser` | `oxy.privacy.unrestrict` |
| `isUserRestricted` | `oxy.privacy.isRestricted` |
| `getNotifications` | `oxy.notifications.list` |
| `getUnreadCount` | `oxy.notifications.unreadCount` |
| `markNotificationAsRead` | `oxy.notifications.markRead` |
| `markAllNotificationsAsRead` | `oxy.notifications.markAllRead` |
| `deleteNotification` | `oxy.notifications.delete` |
| `registerPushToken` | `oxy.notifications.registerPushToken` |
| `unregisterPushToken` | `oxy.notifications.unregisterPushToken` |
| `assetUpload` | `oxy.assets.upload` — (file, visibility, metadata, onProgress) → (file, { visibility, metadata, onProgress }); returns { file } |
| `uploadRawFile` | `oxy.assets.upload` — (file, visibility, metadata) → (file, { visibility, metadata }); returns { file } |
| `assetLink` | `oxy.assets.link` — (fileId, app, entityType, entityId, visibility, webhookUrl) → (fileId, { app, entityType, entityId }, { visibility, webhookUrl }) |
| `assetUnlink` | `oxy.assets.unlink` — (fileId, app, entityType, entityId) → (fileId, { app, entityType, entityId }) |
| `assetGet` | `oxy.assets.get` |
| `assetGetVariants` | `oxy.assets.get` — variants are on the asset: (await assets.get(id)).variants |
| `assetGetUrl` | `oxy.assets.url` — returns the URL string, not { url } |
| `getFileDownloadUrlAsync` | `oxy.assets.url` |
| `fetchAssetDownloadUrl` | `oxy.assets.url` |
| `getFileDownloadUrl` | `oxy.assets.publicUrl` |
| `getFileDownloadUrls` | `oxy.assets.urls` |
| `getBatchFileAccess` | `oxy.assets.access` |
| `getFileContentAsText` | `oxy.assets.text` |
| `getFileContentAsBlob` | `oxy.assets.blob` |
| `assetRestore` | `oxy.assets.restore` |
| `assetDelete` | `oxy.assets.delete` — (fileId, force) → (fileId, { force }) |
| `deleteFile` | `oxy.assets.delete` |
| `assetUpdateVisibility` | `oxy.assets.setVisibility` |
| `listUserFiles` | `oxy.assets.list` — (limit, offset) → ({ limit, offset }) |
| `getAccountStorageUsage` | `oxy.assets.usage` |
| `uploadAvatar` | `oxy.assets.uploadAvatar` |
| `resolveDid` | `oxy.identity.resolveDid` |
| `getMyDid` | `oxy.identity.did` — now a getter |
| `listAuthMethods` | `oxy.identity.authMethods` |
| `getIdentityRootStatus` | `oxy.identity.rootStatus` |
| `createIdentityLink` | `oxy.identity.links.create` |
| `getIdentityLink` | `oxy.identity.links.get` |
| `signIdentityLink` | `oxy.identity.links.sign` |
| `completeIdentityLinkWithEmailCode` | `oxy.identity.links.complete` |
| `cancelIdentityLink` | `oxy.identity.links.cancel` |
| `rotateKey` | `oxy.identity.rotateKey` |
| `exportMyData` | `oxy.identity.export` |
| `requestDomainVerification` | `oxy.identity.domains.requestVerification` |
| `verifyDomain` | `oxy.identity.domains.verify` |
| `listDomains` | `oxy.identity.domains.list` |
| `removeDomain` | `oxy.identity.domains.remove` |
| `createEncryptedBackup` | `oxy.identity.backup.create` |
| `getBackupStatus` | `oxy.identity.backup.status` |
| `deleteBackup` | `oxy.identity.backup.delete` |
| `restoreFromEncryptedBackup` | `oxy.identity.backup.restore` |
| `listAccounts` | `oxy.accounts.list` |
| `getAccount` | `oxy.accounts.get` |
| `switchToAccount` | `oxy.accounts.actAs` |
| `createAccount` | `oxy.accounts.create` |
| `updateAccount` | `oxy.accounts.update` |
| `archiveAccount` | `oxy.accounts.archive` |
| `listAccountMembers` | `oxy.accounts.members.list` |
| `inviteAccountMember` | `oxy.accounts.members.invite` |
| `updateAccountMember` | `oxy.accounts.members.update` |
| `removeAccountMember` | `oxy.accounts.members.remove` |
| `transferAccountOwnership` | `oxy.accounts.transferOwnership` |
| `listAccountApps` | `oxy.apps.list` |
| `createApp` | `oxy.apps.create` |
| `getApp` | `oxy.apps.get` |
| `updateApp` | `oxy.apps.update` |
| `deleteApp` | `oxy.apps.delete` |
| `getAppUsage` | `oxy.apps.usage` |
| `listAppCredentials` | `oxy.apps.credentials.list` |
| `createAppCredential` | `oxy.apps.credentials.create` |
| `rotateAppCredential` | `oxy.apps.credentials.rotate` |
| `revokeAppCredential` | `oxy.apps.credentials.revoke` |
| `getPublicApplication` | `oxy.apps.getPublic` |
| `listConnectedApps` | `oxy.apps.connected.list` |
| `revokeAppGrant` | `oxy.apps.connected.revoke` |
| `listConnectedMcpClients` | `oxy.apps.connected.mcpClients` |
| `revokeConnectedMcpClient` | `oxy.apps.connected.revokeMcpClient` |
| `startLinkedAccount` | `oxy.linkedAccounts.start` |
| `completeLinkedAccount` | `oxy.linkedAccounts.complete` |
| `listLinkedAccounts` | `oxy.linkedAccounts.list` |
| `revokeLinkedAccount` | `oxy.linkedAccounts.revoke` |
| `listAvailableCapabilityCatalogs` | `oxy.agency.catalogs` |
| `listDelegationGrants` | `oxy.agency.grants.list` |
| `createDelegationGrant` | `oxy.agency.grants.create` |
| `updateDelegationGrant` | `oxy.agency.grants.update` |
| `revokeDelegationGrant` | `oxy.agency.grants.revoke` |
| `listAccountCapabilityPolicies` | `oxy.agency.policies.list` |
| `putAccountCapabilityPolicy` | `oxy.agency.policies.put` |
| `deleteAccountCapabilityPolicy` | `oxy.agency.policies.delete` |
| `listCapabilityExecutionAuthorizations` | `oxy.agency.authorizations.list` |
| `revokeCapabilityExecutionAuthorization` | `oxy.agency.authorizations.revoke` |
| `listCapabilityAuditEvents` | `oxy.agency.auditEvents` |
| `listStoreCategories` | `oxy.store.categories` |
| `listStoreApps` | `oxy.store.apps` |
| `getStoreApp` | `oxy.store.app` |
| `listStoreReviews` | `oxy.store.reviews.list` |
| `getMyStoreReview` | `oxy.store.reviews.mine` |
| `writeStoreReview` | `oxy.store.reviews.write` |
| `deleteMyStoreReview` | `oxy.store.reviews.deleteMine` |
| `getAppListing` | `oxy.store.listing.get` |
| `writeAppListing` | `oxy.store.listing.write` |
| `submitAppListing` | `oxy.store.listing.submit` |
| `unpublishAppListing` | `oxy.store.listing.unpublish` |
| `listAppListingScreenshots` | `oxy.store.listing.screenshots.list` |
| `addAppListingScreenshot` | `oxy.store.listing.screenshots.add` |
| `updateAppListingScreenshot` | `oxy.store.listing.screenshots.update` |
| `deleteAppListingScreenshot` | `oxy.store.listing.screenshots.delete` |
| `reorderAppListingScreenshots` | `oxy.store.listing.screenshots.reorder` |
| `getUserPayments` | `oxy.billing.payments` |
| `getSubscription` | `oxy.billing.subscription` |
| `getCurrentUserSubscription` | `oxy.billing.subscription` |
| `getWallet` | `oxy.billing.wallet` |
| `getCurrentUserWallet` | `oxy.billing.wallet` |
| `getWalletTransactions` | `oxy.billing.walletTransactions` — (userId, options) → ({ userId, ...options }) |
| `getCurrentUserWalletTransactions` | `oxy.billing.walletTransactions` — (options) → (options) |
| `getReputationBalance` | `oxy.reputation.balance` |
| `getMyReputationBalance` | `oxy.reputation.balance` — no userId = mine |
| `getReputationLeaderboard` | `oxy.reputation.leaderboard` — (limit, offset) → ({ limit, offset }) |
| `getReputationRules` | `oxy.reputation.rules` |
| `getReputationTransactions` | `oxy.reputation.transactions` — (userId, limit, offset) → (userId, { limit, offset }) |
| `getReputationInfluence` | `oxy.reputation.influence` |
| `getPublicCard` | `oxy.civic.publicCard` |
| `getMyIdPayload` | `oxy.civic.idPayload` |
| `buildAttestQrPayload` | `oxy.civic.buildAttestQrPayload` |
| `submitRealLifeAttestation` | `oxy.civic.attest` |
| `getValidatorInbox` | `oxy.civic.validation.inbox` |
| `submitValidationVote` | `oxy.civic.validation.vote` |
| `denyValidation` | `oxy.civic.validation.deny` |
| `vouchForPerson` | `oxy.civic.vouch` |
| `withdrawVouch` | `oxy.civic.withdrawVouch` |
| `getPersonhood` | `oxy.civic.personhood` |
| `getMyPersonhood` | `oxy.civic.personhood` — no userId = mine |
| `issueCredential` | `oxy.civic.credentials.issue` |
| `listCredentials` | `oxy.civic.credentials.list` |
| `listMyCredentials` | `oxy.civic.credentials.list` — (opts) → (undefined, opts) |
| `verifyCredential` | `oxy.civic.credentials.verify` |
| `revokeCredential` | `oxy.civic.credentials.revoke` |
| `registerNode` | `oxy.nodes.register` |
| `getMyNode` | `oxy.nodes.mine` |
| `removeMyNode` | `oxy.nodes.removeMine` |
| `provisionManagedVault` | `oxy.nodes.provisionManagedVault` |
| `notifyNodeIngest` | `oxy.nodes.notifyIngest` |
| `getUserDevices` | `oxy.devices.list` |
| `removeDevice` | `oxy.devices.remove` |
| `getDeviceSessions` | `oxy.devices.sessions` |
| `logoutAllDeviceSessions` | `oxy.devices.logoutAll` |
| `updateDeviceName` | `oxy.devices.rename` |
| `getSecurityInfo` | `oxy.devices.securityInfo` |
| `getSecurityActivity` | `oxy.devices.securityActivity` |
| `getRecentSecurityActivity` | `oxy.devices.securityActivity` — (limit) → (limit, 0); returns the page, read .data |
| `logPrivateKeyExported` | `oxy.devices.logPrivateKeyExported` |
| `logBackupCreated` | `oxy.devices.logBackupCreated` |
| `mintFromDeviceSecret` | `oxy.devices.mintToken` |
| `registerBrowserDevice` | `oxy.devices.registerBrowser` |
| `requestDeviceJoinCode` | `oxy.devices.requestJoinCode` |
| `joinBrowserDevice` | `oxy.devices.joinBrowser` |
| `provisionBackgroundCredential` | `oxy.devices.provisionBackgroundCredential` |
| `listTopics` | `oxy.topics.list` |
| `searchTopics` | `oxy.topics.search` |
| `getTopicBySlug` | `oxy.topics.get` |
| `getTopicCategories` | `oxy.topics.categories` |
| `resolveTopicNames` | `oxy.topics.resolveNames` |
| `updateTopicMetadata` | `oxy.topics.update` |
| `getAppData` | `oxy.appData.get` |
| `setAppData` | `oxy.appData.set` |
| `deleteAppData` | `oxy.appData.delete` |
| `listAppData` | `oxy.appData.list` |
| `discoverContacts` | `oxy.contacts.discover` |

#### Server (`OxyServer`, `@oxy.so/core/server`)

| 2.x | 3.0 |
|---|---|
| `createNotification` | `server.notifications.create` |
| `getServiceAssetMetadataByIds` | `server.assets.metadataByIds` |
| `getServiceAssetMetadataBySha256` | `server.assets.metadataBySha256` |
| `getServiceLinkedDownloadUrls` | `server.assets.linkedDownloadUrls` |
| `getLinkedAccountsForUser` | `server.linkedAccounts.forUser` |
| `mintRequesterAssertion` | `server.agency.mintRequesterAssertion` |
| `introspectRequesterAssertion` | `server.agency.introspectRequesterAssertion` |
| `awardReputation` | `server.reputation.award` |
| `configureServiceAuth` | `server.configureServiceAuth` |
| `getServiceToken` | `server.serviceToken` |
| `invalidateServiceToken` | `server.invalidateServiceToken` |
| `makeServiceRequest` | `server.serviceRequest` |
| `verifyServiceActingAs` | `server.verifyActingAs` |
| `verifyAccountEvent` | `server.accountEvents.verify` |
| `listAccountEvents` | `server.accountEvents.list` |
| `auth` | `server.middleware.auth` |
| `authSocket` | `server.middleware.socket` |
| `serviceAuth` | `server.middleware.service` |
| `requireScope` | `server.middleware.requireScope` |

#### Removed

- `handleError`
- `getMetrics`
- `withAuthRetry` — call the method directly; the HTTP layer already refreshes on 401
- `__resetTokensForTests`
- `webauthnRegisterOptions` — passkeys are removed (ADR 0030)
- `webauthnRegisterVerify` — passkeys are removed (ADR 0030)
- `webauthnLoginOptions` — passkeys are removed (ADR 0030)
- `webauthnLoginVerify` — passkeys are removed (ADR 0030)
- `checkEmailAvailability`
- `getAccountDeletionOptions`
- `deleteAccountWithPasskey`
- `lookupUsername`
- `getUserStats`
- `invalidateFollowGraphCaches`
- `extractUserId`
- `isUserInList`
- `fetchAssetContent`
- `getAssetUrlCacheTTL`
- `uploadProfileBanner`
- `getMyDidDocument`
- `getIdentityLinkAssertionOptions`
- `completeIdentityLink`
- `removePasskey` — passkeys are removed (ADR 0030)
- `signRecord`
- `publishRecord`
- `getRecord`
- `verifyRecord`
- `listChildAccounts`
- `provisionChannelAccount`
- `provisionChannelMember`
- `revokeChannelMember`
- `replyToStoreReview`
- `deleteStoreReviewReply`
- `createPayment`
- `getPayment`
- `createReputationDispute`
- `getUserReputationDisputes`
- `upsertReputationRule`
- `reverseReputationTransaction`
- `voidReputationTransaction`
- `recalculateReputation`
- `getReputationDisputeQueue`
- `resolveReputationDispute`
- `registerDevice`
- `inference` — createInferenceClient(oxy) from '@oxy.so/core/inference'
- `getStorage`
- `getCurrentLanguage` — use getLanguageCode / the i18n helpers
- `getCurrentLanguageMetadata`
- `getCurrentLanguageName`
- `getCurrentNativeLanguageName`
- `submitFeedback`
- `getSubscriptionPlans`
- `getIndividualFeatures`
- `subscribe`
- `subscribeToFeature`
- `cancelSubscription`
- `reactivateSubscription`
- `getCurrentSubscription`
- `getSavedItems`
- `getCollections`
- `saveItem`
- `removeSavedItem`
- `createCollection`
- `deleteCollection`
- `getUserHistory`
- `clearUserHistory`
- `deleteHistoryItem`
- `getFAQs`
- `searchFAQs`
- `getUserAchievements`
- `getAllAchievements`
- `updateLocation`
- `getNearbyUsers`
- `trackEvent`
- `getAnalytics`
- `appendChainRecord`
- `readChainRecords`

## 2.3.0

A backend's reads that carry no user session can identify as the service.
Also released for 1.x as 1.18.1 from `release/core-1.18.x`.

### Added

- `OxyConfig.serviceIdentity: 'never' | 'when-anonymous'` (default `'never'`).
  With `'when-anonymous'`, a request made while the client holds no user
  session carries this process's service token — the `configureServiceAuth()`
  key pair, or workload attestation (ADR 0026) without one. A user session
  still wins, `skipAuth` requests stay unauthenticated, and a process that can
  mint no token (a local checkout) sends the request anonymous as before. A
  failed mint sends reads anonymous for 30 s (`ANONYMOUS_SERVICE_TOKEN_RETRY_MS`)
  before trying again, so a refusing Oxy is asked once per window, not once per
  read.

  Why: oxy-api charges anonymous traffic to its source address — `rl:general`
  and a +500 ms `slowDown` per request past 100 in 15 minutes — and a backend
  fleet shares one NAT address, so its public reads (`getUserById`,
  `getProfileByUsername`, …) paid the delay together once past the threshold.
  A first-party service token is exempt and charged to its own application.
  Measured from Mention's task: `GET /users/:id` 543–575 ms anonymous past the
  threshold; `POST /users/by-ids` 19–24 ms with the service token
  (OxyHQ/Mention#1173). `getUsersByIds` already chose the service path on its
  own (1.12.1); this extends the same identity to every call.
- `HttpService.setAnonymousAuthProvider(provider)`: the hook the option uses,
  consulted only when there is no access token.

## 2.2.0

### Changed

- Locales (all 11): the strings of the email sign-in dialog — `signin.identifier`,
  `signin.checkEmail`, `signin.password`, `signin.secondFactor`, `signin.link`
  (auth.oxy.so's `/email-signin`), new `signin.errors` —, account creation by
  email (`signup`), `reauth`, `signInSecurity` (password, authenticator app,
  backup codes) and `deleteAccount.keyless`; `linkCommons` no longer speaks of a
  recovery email.

### Removed

Passkeys are removed from Oxy (ADR 0030); 2.x is unreleased, so the removals
ship in this same major. Requires `@oxy.so/contracts` ^3.0.0.

- `OxyServices`: `webauthnRegisterOptions`, `webauthnRegisterVerify`,
  `webauthnLoginOptions`, `webauthnLoginVerify`, `removePasskey`,
  `getAccountDeletionOptions`, `deleteAccountWithPasskey`,
  `getIdentityLinkAssertionOptions` and `completeIdentityLink` (a Commons link
  completes with `completeIdentityLinkWithEmailCode`; a keyless account is
  deleted with `deleteAccountWithEmailCode`).
- `SecondFactorRequiredError`: only the passkey sign-ins threw it; the email
  and password sign-ins answer the second-factor step as a value
  (`SignInStepResult`).
- `isOxyRpOrigin` (`utils/webauthnOrigin`) and the `LinkAuthMethodResult` type.
- `startEmailVerification` takes the sign-up request only, and
  `confirmEmailVerification` resolves to `{ ticket, expiresAt }` (contracts 3).
- `buildOxyPagesHeaders` on a sensitive origin sends
  `publickey-credentials-get=()` and `publickey-credentials-create=()`:
  WebAuthn is off everywhere.
- `deleteAccount.handoff.elsewhereMessage` (all 11 locales) no longer points a
  passkey account at auth.oxy.so; the `{{site}}` variable is gone.
- The passkey strings no longer used: `signin.username`, `signin.methods`,
  `signin.recoverLink`, `signin.errors.passkey*`, `signup.passkey`,
  `signup.webSubtitle`, `signup.createAccount`, `signup.commonsInstead`,
  `recover`, `emailCode.sentIfAccount`, `deleteAccount.passkey`,
  `accountSwitcher.useIdentityOnDevice`.

## 2.1.0

Signing in without a passkey: an email code or link, an optional password, an
optional authenticator app (TOTP), and sign-up with a confirmed email.

### Added

- `startEmailSignIn(identifier)`, `confirmEmailSignIn({ requestId,
  requestSecret, code })`, `collectEmailSignIn({ requestId, requestSecret })`
  and, for auth.oxy.so's link page, `approveEmailSignInLink(token)` —
  `POST /auth/signin/email/{start,confirm,collect,link}`. One email carries a
  6-digit code and a one-use link; the link approves only in the browser that
  asked (it proves the same shared device), and only the caller holding the
  `requestSecret` collects the session.
- `signInWithPassword({ identifier, password })` and
  `completeSecondFactor({ challengeId, code })` — `POST /auth/signin/password`
  and `/auth/signin/second-factor`. When the account has an authenticator every
  first factor resolves to `{ secondFactorRequired, challengeId, expiresAt }`
  (no session, no token planted) and the second factor to the session.
- `signUp({ username, email, emailTicket })` — `POST /auth/signup`, with the
  ticket `confirmEmailVerification` returns for a `signup` code.
- Every one of them attaches this client's device proof (`readDeviceProof`,
  ADR 0029 D2) unless `device` is passed (`null` opts out), and plants the
  access token of a session.
- `getSignInMethods()`, `requestReauthEmailCode()`, `setPassword({ newPassword,
  reauth, revokeOtherSessions? })`, `enrollTotp()`, `confirmTotp(code, reauth)`,
  `disableTotp(reauth)`, `regenerateTotpBackupCodes(reauth)` — the signed-in
  account's password and authenticator, each change confirmed by a fresh
  `reauth` proof (the current password or an emailed code, plus the
  authenticator's code once it is on).
- `SecondFactorRequiredError` (`challengeId`, `expiresAt`): thrown by
  `webauthnLoginVerify` and `webauthnRegisterVerify` (recovery) when the
  account has an authenticator — a passkey is a first factor too; finish with
  `completeSecondFactor`.
- `requestReauthEmailCode(action)` names the one change the code confirms.

### Deprecated

- `getAccountDeletionOptions`, `deleteAccountWithPasskey`,
  `getIdentityLinkAssertionOptions`, `completeIdentityLink` and adding a passkey
  to a signed-in account (`webauthnRegisterOptions`/`webauthnRegisterVerify`
  with a bearer): the API refuses them now (a stolen bearer could otherwise
  plant a passkey and use it). Use `deleteAccountWithEmailCode` and
  `completeIdentityLinkWithEmailCode`. They go with passkeys.
- `deleteAccountWithEmailCode(confirmText, reauth)` and
  `completeIdentityLinkWithEmailCode(linkId, reauth)`: deleting an account
  without a key and linking Commons, confirmed by an emailed code instead of a
  passkey.
## 2.0.0

Includes everything in 1.19.0.

### Removed

- **Breaking:** the `jwtSecret` option is removed from `auth()` and
  `serviceAuth()` (and so from `createOxyRateLimit`'s forwarded `auth` options).
  HS256 service tokens are refused: service tokens verify only as Ed25519
  (`alg: EdDSA` with a `kid`) against Oxy's published JWKS at
  `/.well-known/jwks.json`, and the algorithm is pinned, never read from the
  token. The `SERVICE_TOKEN_NOT_CONFIGURED` (403) refusal is gone with it; an
  HS256, `none` or other header is `INVALID_SERVICE_TOKEN` (401) without any
  JWKS fetch. Production has signed only EdDSA since 2026-09-17 (ADR 0012,
  #877). Peable passes `jwtSecret` to `serviceAuth()`/`auth()` today: it keeps
  verifying EdDSA tokens on core 1.x, and must drop the option when it moves to
  core 2.

## 1.19.0

One browser, one session: the browser bridge (ADR 0029 D2).

### Added

- `registerBrowserDevice()`, `requestDeviceJoinCode(request)` and
  `joinBrowserDevice(request)` — `POST /session/device/{register,join-code,join}`,
  bearer-less and validated against the contracts. auth.oxy.so's bridge page
  registers or proves the browser's device and hands an official app a one-use,
  PKCE-bound code; the app redeems it for its own holder credential.
- `setDeviceCredentialProvider(provider)` and `readDeviceProof()`: tell a client
  how to read the device credential it holds, and `claimSessionByToken`,
  `webauthnLoginVerify` and `webauthnRegisterVerify` (sign-up, recovery) send it
  as `device`, so the new session is created on that device. An explicit
  `device: null` opts out. Type `DeviceCredentialProvider`.

### Changed

- The in-session re-mint on the web KEEPS a device credential that answers
  `no_active_session` (it drops only the session fields) instead of clearing the
  store: a joined, signed-out app stays a holder of the browser's device and never
  needs the bridge again. `invalid_device_secret` still clears it.

## 1.18.0

Web accounts are a username, a passkey and a recovery email (ADR 0029 D3). The
web identity carrier is deleted: Commons is the one place a key lives.

### Added

- `startEmailVerification({ purpose: 'signup', email } | { purpose: 'recovery', identifier })`
  and `confirmEmailVerification(verificationId, code)`: a 6-digit code to a
  recovery email, and the one-use ticket it confirms into.
- `webauthnRegisterOptions({ username?, recoveryTicket? })` (was a bare
  `username`) and `webauthnRegisterVerify`'s `email`, `emailTicket` and
  `recoveryTicket`: a sign-up is created with its confirmed recovery email, and
  a recovery registers a new passkey for the account its ticket names.
- `getAccountDeletionOptions()` and `deleteAccountWithPasskey(confirmText, assertion)`:
  a passkey account is deleted with an assertion by one of its passkeys.
- Linking Commons to a passkey account from two devices:
  `createIdentityLink()`, `getIdentityLink(linkId)`,
  `getIdentityLinkAssertionOptions(linkId, challenge)`,
  `completeIdentityLink(linkId, assertion)`, `cancelIdentityLink(linkId)` for
  auth.oxy.so, and `signIdentityLink(linkId, challenge)` for Commons (signs the
  `link_identity` proof with this device's key, native only).
  `deriveIdentityLinkCode(linkId, publicKey)`: the 6-digit code both devices
  show.
- Locale keys in all 11 locales: `signup.username.*`, `signup.email.*`,
  `signup.passkey.*`, `signup.commonsInstead`, `emailCode.*`, `recover.*`
  (replaced), `deleteAccount.passkey.*`, `linkCommons.*`. `signup.webSubtitle` and
  `deleteAccount.handoff.elsewhereMessage` say what a web account is now.

### Removed

- The web identity carrier (`crypto/webIdentityCarrier.ts`): `sealWebIdentity`,
  `openWebIdentity`, `unlockWebIdentity`, `addWrap`, `removeWrap`,
  `markWrapVerified`, `unwrapDataKey`, `deriveKeyEncryptionKey`,
  `generateDataKey`, `generateWebIdentity`, `deriveIdentityFromMnemonic`,
  `deriveIdentityFromPrivateKey`, `deriveIdentityFromRecoveryMaterial`,
  `parseRecoveryMaterial`, `normalizeMnemonic`, `isUsablePrfOutput`,
  `wipeBytes`, `wipeOpenedIdentity`, `WEB_IDENTITY_PRF_INPUT`,
  `WEB_IDENTITY_PRF_OUTPUT_LENGTH`, `WebIdentityUnlockError` and their types.
- The move to Commons (`crypto/identityMove.ts`): `buildMoveQrPayload`,
  `parseMoveQrPayload`, `createMoveCommitment`, `verifyMoveCommitment`,
  `deriveMoveKey`, `deriveMoveSas`, `digestMoveCiphertext`,
  `generateMoveEphemeralKeyPair`, `sealIdentityForMove`, `openMovedIdentity`,
  `signMoveReceipt`, `verifyMoveReceipt`, `MoveReceiptClaims`.
- `checkEmailAvailability`: nothing says whether an email is an account's.
- The `accountMenu.identity` locale key.

## 1.16.0

No identity popups (ADR 0028 D1b).

### Added

- `buildOAuthAuthorizeUrl({ screen })` and `OxyAuthScreen` (`signin`, `signup`,
  `recover`): the IdP screen a person with no session there lands on, for an
  Oxy app that sends them to auth.oxy.so in the same tab.
- `signin.recoverLink` in all 11 locales.

### Removed

- `AccountDialogController.startPasskeyHubSignIn`, the `openPopup` and
  `authOrigin` options, and `PopupWindowHandle`: the account dialog never opens
  a window. What only auth.oxy.so can do happens there, in the same tab.
- The `'cancelled'` `SignInFailureReason`, which only a closed popup produced.

## 1.15.0

The web identity carrier is `auth.oxy.so`; `id.oxy.so` is gone (ADR 0028).

### Added

- `AUTH_WEB_ORIGIN` (`https://auth.oxy.so`): the IdP's origin, which is also
  the web identity carrier. `OXY_AUTHORIZE_URL` is built from it.
- `buildOxyPagesHeaders({ sensitive: true })` serves the whole holder policy:
  `base-uri` and `form-action 'none'`, `Referrer-Policy: no-referrer`, a
  `Permissions-Policy` allowing passkeys for the origin only with every other
  powerful feature off, and `Cross-Origin-Resource-Policy: same-origin`. Never
  COOP: the identity window reports back to its opener.

### Changed

- The account dialog's passkey window opens `<authOrigin>/continue?user_code=…`
  (was `id.oxy.so/continue?code=…`). The parameter is `user_code` because the
  IdP's own `OxyProvider` cold boot consumes a `?code=` as an OAuth return.

### Removed

- `IDENTITY_WEB_ORIGIN`; use `AUTH_WEB_ORIGIN`.
- The controller's `identityOrigin` option; it is `authOrigin`.

## 1.14.0

### Added

- `AccountDialogController.startInlineQr()`: the sign-in screen's embedded
  Commons QR — a request whose only route is the QR, started without leaving
  the current view. It runs no delivery selection (no push to a phone, no
  Commons opened): the screen starts it by itself, so nobody asked for either.
  Any sign-in the person then chooses supersedes it and withdraws its request;
  `retrySignIn()` repeats it.
- `SignInFlowState.inline`: `true` while the attempt is that embedded QR, so a
  host does not report its failures (an expired code is renewed, not news).
- Sign-in copy for the shared sign-in screen in all 11 locales:
  `signin.orContinueWith`, `signin.subtitleToApp`, `signin.noAccount`,
  `signin.createAccount`, `signin.qr.*`, `signin.methods.passkey`,
  `signin.terms.*`, `signin.chooser.subtitleToApp`,
  `signin.errors.{rateLimited,passkeyCancelled,passkeyFailed}`,
  `signup.webSubtitle`. `signin.title`/`subtitle`/`addAccountTitle` and
  `signin.username.placeholder` now read as auth.oxy.so always did.

### Removed

- The `hubBaseUrl` controller option, the deprecated alias of
  `identityOrigin` from when the passkey popup opened `auth.oxy.so/hub-passkey`.
  Nothing passed it; pass `identityOrigin`.
- 102 dictionary keys no surface reads any more, in every locale — the password,
  2FA and email sign-up copy, and the old account switcher's and sign-in
  entry's (`accountSwitcher.passkeyHint`, `continueWithPasskey`,
  `otherDeviceCommons`, `signin.or`, …).

## 1.13.0

### Added

- `verifyAccountEvent(token, { audience?, jwksUrl? })`: verifies an account
  event from Oxy — the body of an account-event webhook, or an entry of the
  pull feed — and returns `{ eventId, type: 'account.deleted', userId,
  username, occurredAt, retained, applicationId, issuedAt }`. The token is a
  Security Event Token (`typ: secevent+jwt`) signed with Oxy's Ed25519 service
  key and checked against the same public JWKS as service tokens; the audience
  defaults to the `appId` of the configured service credential. A service
  token is refused as an event and vice versa. `username` is the handle at
  deletion time, `null` when absent (including tokens that predate the field).
  Refusals throw `OxyAccountEventError` (OxyHQ/Mention#1169).
- `listAccountEvents({ after?, limit? })`: one page of the calling
  application's account events from `GET /account-events`, the reconciliation
  path behind the webhook.

## 1.12.1

### Fixed

- `getUsersByIds` sent an attested backend (ADR 0026: an ECS task with no key
  pair) down the anonymous user path, because it asked only whether a key pair
  was configured. Every chunk then went out with no bearer, was charged to the
  shared NAT address's per-IP budget and paid its 500ms slow-down penalty:
  measured from Mention's task, 520ms per chunk against 20ms with the service
  token, which put Mention's 1.5s author-hydration deadline out of reach on
  every cache miss. A host that can attest now takes the service path.

## 1.12.0

### Added

- `AccountDialogController.chooseContext(contextId)`: the one entry point for
  a chosen device-account row. Signed in it is a switch (`'current'` for the
  active row, else `activateContext`). Signed out it is "Continue as
  @handle": the same `signInWithOxy()` path as the "Continue with Oxy" button
  (silent through the shared identity, else the request), and when the silent
  mint lands on a different pair from the chosen row, that row is activated
  under the new bearer. Resolves a `ContextChoiceOutcome`.
- `AccountDialogSnapshot.hasSession`: whether this client holds a bearer. The
  device directory can keep listing a shared identity (Commons') after the app
  signed out, so hosts must not infer "signed in" from its size.

### Fixed

- Signed out on a device that still lists a shared identity, choosing that
  account signed nobody in: hosts treated the directory's "active" row as
  already signed in and closed the sheet (OxyHQ/oxy#1375 item 20).

## 1.11.0

Requires `@oxy.so/contracts` 1.5.0.

### Added

- Linked accounts mixin: `startLinkedAccount(network, options)`,
  `completeLinkedAccount(code)` (the `link_code` the callback hands
  `returnTo`; only the user who started the flow can complete it),
  `listLinkedAccounts()`, `revokeLinkedAccount(id)`, and the service read
  `getLinkedAccountsForUser(userId)` (privileged `linked-accounts:read`).
- `User.alsoKnownAs`, as `GET /profiles/username/:username` returns it.
- `Notification` gains `type`, `title`, `url`, `entityType` and `entityId`;
  `createNotification` accepts a `CreateOxyNotificationRequest`.
- `ServiceAssetMetadata.ownerUserId`, present only for Oxy's own
  (`tier: 'internal'`) applications.
- The identity device backup (OxyHQ/oxy#1388). `KeyManager.setDeviceBackupStore()`
  registers a store that keeps the identity outside the app's keystore (Commons
  registers Android Block Store). Every identity write refreshes it, the
  verified recovery phrase rides along, every `deleteIdentity` clears it, and
  `KeyManager.ensureDeviceBackup()` backfills or repairs it. Type:
  `IdentityDeviceBackupStore`.
- `attemptIdentityRecovery` gains a third rung, `device-backup`, the only copy
  that survives a wipe of the shared-UID Android Keystore. With a store
  registered it also restores an `absent` identity (the app's own data was
  cleared) instead of reporting `not-lost`. Without a store nothing changes.

## 1.10.0

### Fixed

- A sign-out outranks a token refresh already in flight. `OxyServices.clearTokens()`
  now ends the local session (`HttpService.endSession()`): a re-mint that started
  before it — the device-secret arm, the native shared-keychain arm, or the
  handler's own plant — plants nothing, and the native shared-keychain arm does
  not run again until a token is planted. Before, a refresh that outlived the
  sign-out put the bearer back, and on native a 401 after sign-out re-signed the
  user in with the shared keychain. The device-secret arm still persists the
  rotated secret when the store kept the credential it presented, never refills a
  store the sign-out cleared, and still mints later from a credential the store
  holds (a sign-in made in another tab).

### Added

- `HttpService.endSession()`, `HttpService.getSessionEpoch()` and
  `HttpService.hasSessionEnded()`.
- `DeviceSecretMintOutcome` `session-ended`: the mint succeeded after the session
  was ended, and nothing was planted.

## 1.9.1

### Fixed

- A refresh that returns the SAME still-valid access token (the device mint
  hands back the stored token until it expires) no longer counts as a reason
  to ask again. The request-time preflight sends that token until `exp`, and
  the proactive scheduler waits until just past `exp`
  (`REMINT_AFTER_EXPIRY_MS`) instead of re-minting at its 1s floor. Before,
  every token's last minute cost ~30 mints, tripped the 30/min limit, and the
  429 cooldown outlived the token, so the next request 401'd and the app signed
  out (OxyHQ/Mention#1140). New: `HttpService.isAwaitingCurrentTokenExpiry()`.
- The scheduler no longer re-arms when the same token is planted again.

## 1.9.0

Requires `@oxy.so/protocol` 1.1.1. Includes the crypto-polyfill ordering fix
from #1377 (1.8.1).

### Added

- `AccountDialogController.back()` and `AccountDialogSnapshot.backView`: the
  controller owns where the account dialog's Back leads. `signup` and `qr`
  return to the sign-in entry (`'add'` when somebody is signed in, `'signin'`
  when nobody is), `add` returns to the account menu, and the first view
  reports `backView: null` so the host closes instead. Leaving an active
  request withdraws it.

### Fixed

- The account dialog never shows the `'accounts'` view (the signed-in account
  menu) without a session: `setView('accounts')`, a fresh controller and the
  signed-out edge all resolve to `'signin'`. Signed out, Back from "Create your
  account" used to open the menu, "Sign out" included, for nobody
  (OxyHQ/oxy#1375).
- `DeviceLinkedSession.deviceName` is optional: `GET
  /session/device/sessions/:sessionId` never sends it, and a required type let
  Services render "undefined (This device)".
- i18n: `accounts.manage.switch.countOne` ("1 account", not "1 accounts") and
  `manageAccount.sessions.otherSession` (en-US, es-ES).

## 1.8.0

Requires `@oxy.so/contracts` 1.4.0.

### Added

- `OxyResponsesRequest.reasoning` (`{ effort: 'low' | 'medium' | 'high' }`),
  forwarded to `POST /v1/responses`. The edge refuses an effort the resolved
  model does not list with `invalid_request`.
- `listModels()` / `getModel()` entries now carry
  `capabilities.reasoningEfforts` and, when a provider reported one,
  `releasedAt` (both from `@oxy.so/contracts` 1.4.0).

## 1.7.4

### Fixed

- The auth mixin loads the ADR 0026 workload-identity module through the
  package-private `#workload-identity` import (declared in the `dist/esm` and
  `dist/cjs` scope `package.json` files) instead of a self-reference to the
  `./internal/workload-identity` export, which is removed. A self-reference
  resolves only where `@oxy.so/core` is reachable through `node_modules`, so
  every Vite build inside this workspace failed on 1.7.3's `dist`. Published
  consumers of 1.7.3 were unaffected. `test:package` asserts the resolution
  per condition for both module formats.

## 1.7.3

### Fixed

- Native and browser bundles no longer reach `node:crypto`: the workload
  identity module is routed by package conditions to an inert client
  implementation that can never attest or request a token; only Node hosts get
  the signer.

## 1.5.1

Maintenance release: 1.5.0's `onRefusal` made reachable.

### Fixed

- `onRefusal` is declared on the `OxyServices` interface consumers see, not only
  on the mixin. `src/OxyServices.ts` re-declares `auth()` / `serviceAuth()` by
  hand and that hand-written list is what the published `.d.ts` carries, so a
  host passing the option 1.5.0 advertised got
  `TS2345 … has no properties in common with`.
  `src/__tests__/publicInterfaceParity.test.ts` compares the two declarations.

## 1.5.0

Maintenance release: `1.4.0` plus auth-refusal observability only. It
deliberately excludes the unreleased, breaking identity changes on `main`
(#1302), which ship in the next major.

### Added

- Auth refusals are observable to the host: `auth()` records
  `req.oxyAuthRefusal` (`{ code, stage, reason, status, optional }`), logs one
  `warn` per refusal with a stable code, and accepts an `onRefusal` observer.
  Read it with `getOxyAuthRefusal(req)` from `@oxy.so/core/server`, which also
  names the refusal in the log beside `requireOxyAuth`'s generic 401. Response
  bodies are unchanged, no reason reaches a client, and a credential-free
  request is not a refusal. Additive.

## 1.4.0

Maintenance release cut from the `1.3.1` release commit (`f435259d`) plus the
present-requester assertion work only. It deliberately excludes the unreleased,
breaking identity changes on `main` (#1302), which ship in the next major.

### Added

- Present-requester assertions (ADR 0025): `OxyServices.mintRequesterAssertion`
  lets a pinned first-party product backend trade a signed-in person's live
  session for a one-use, 120-second `OXY-REQUESTER+JWT`, and
  `OxyServices.introspectRequesterAssertion` lets its audience consume it.
  `@oxy.so/core/server` adds `createOxyRequesterAssertionAuth` (mount after
  `createOxyAuthMiddleware`; sets `req.userId` and `req.oxyRequester` only after
  local JWKS verification, presenter binding and live introspection),
  `signOxyRequesterAssertion`, `verifyOxyRequesterAssertion` and
  `createOxyJwksKeyResolver`. Additive.

## Unreleased

### Added

- Identity roots (ADR 0024): `signIdentityProof` / `digestIdentityPayload` sign
  the one payload-bound, one-use v2 root proof; web identity envelopes gain
  version 2 (12–24-word phrases or a raw private key, RP-bound wraps, holder
  `verifiedAt`) alongside `parseRecoveryMaterial`,
  `deriveIdentityFromPrivateKey`, `deriveIdentityFromRecoveryMaterial`,
  `markWrapVerified`, `isUsablePrfOutput` and `wipeOpenedIdentity`.
- `getIdentityRootStatus()` reads the account's root readiness (root linked, web
  holder passkeys, phrase saved, recovery verified) without anything that opens
  the root. `webauthnRegisterVerify` accepts the sign-up `identity` enrollment.

- Identity transfer (ADR 0024 D6): `createMoveCommitment`,
  `verifyMoveCommitment`, `deriveMoveSas({ moveId, initiatorEphemeralPublicKey,
  responderEphemeralPublicKey, initiatorCommitment })`, `digestMoveCiphertext`,
  `signMoveReceipt(sign, claims)`, `verifyMoveReceipt(claims, signature)`. The
  initiator commits to its ephemeral key before the responder joins, so an active
  relay cannot grind substituted keys into matching codes; the receipt binds the
  move, root, both keys and the relayed ciphertext. 12–24-word phrases move.

### Changed

- `OpenedWebIdentity` is now a union of `OpenedMnemonicIdentity` (`kind:
  'mnemonic'`) and `OpenedRawKeyIdentity` (`kind: 'raw-key'`, `mnemonic: null`).
  `openMovedIdentity` returns `OpenedMnemonicIdentity`.
- **Breaking:** web identity envelopes have one scheme. `sealWebIdentity` and
  `addWrap` require the wrap's `rpId`; there is no version-1 envelope.

### Removed

- **Breaking:** `linkIdentityKey`, `unlinkAuthMethod` (the API links a root first
  time only through the holder flow and never unlinks one).
- **Breaking:** the `deviceTransfer` mixin (`/device-transfer*` is gone from the
  API; it had no caller), the version-1 transfer (`deriveMoveSas(moveId, a, b)`,
  `signMoveAction`, `IDENTITY_MOVE_ACTIONS`, timestamped receipts) and the `V2`
  suffixed names, which are now the only ones.

- Native agency-authority methods for catalog discovery, resource-scoped agent
  grants, account autonomy policies, execution-authority revocation, and the
  correlated audit trail used by Oxy Settings.
- Resource-bound external MCP connections can now be listed and revoked without
  exposing access or refresh tokens to clients.

## 1.5.1

Published 2026-09-18 from the maintenance line (tag `@oxy.so/core@1.5.1`: the
1.5.0 release commit plus the interface declaration it was missing). Everything
under "Unreleased" above it did NOT ship; the breaking identity work makes the
next release from `main` a major.

### Fixed

- `onRefusal` is declared on the `OxyServices` interface consumers see, not only
  on the mixin. `src/OxyServices.ts` re-declares `auth()` / `serviceAuth()` by
  hand and that hand-written list is what the published `.d.ts` carries, so a
  host passing the option 1.5.0 advertised got
  `TS2345 … has no properties in common with`.
  `src/__tests__/publicInterfaceParity.test.ts` compares the two declarations.

## 1.5.0

Published 2026-09-18 from the maintenance line (tag `@oxy.so/core@1.5.0`).

### Added

- Auth refusals are observable to the host: `auth()` records
  `req.oxyAuthRefusal` (`{ code, stage, reason, status, optional }`), logs one
  `warn` per refusal with a stable code, and accepts an `onRefusal` observer.
  Read it with `getOxyAuthRefusal(req)` from `@oxy.so/core/server`, which also
  names the refusal in the log beside `requireOxyAuth`'s generic 401. Response
  bodies are unchanged and a credential-free request is not a refusal. (Passing
  `onRefusal` needs 1.5.1 — see above.)

## 1.4.0

Published 2026-09-17 from the maintenance line (tag `@oxy.so/core@1.4.0`: the
1.3.1 release commit plus ADR 0025 only). Everything under "Unreleased" above
it did NOT ship in 1.4.0; the breaking identity work makes the next release
from `main` a major.

### Added

- Present-requester assertions (ADR 0025): `OxyServices.mintRequesterAssertion`
  lets a pinned first-party product backend trade a signed-in person's live
  session for a one-use, 120-second `OXY-REQUESTER+JWT`, and
  `OxyServices.introspectRequesterAssertion` lets its audience consume it.
  `@oxy.so/core/server` adds `createOxyRequesterAssertionAuth` (mount after
  `createOxyAuthMiddleware`; sets `req.userId` and `req.oxyRequester` only after
  local JWKS verification, presenter binding and live introspection),
  `signOxyRequesterAssertion`, `verifyOxyRequesterAssertion` and
  `createOxyJwksKeyResolver`. Additive.

## 23.2.0

### Added

- `OxyResponsesRequest.routingProfileId` lets trusted product integrations name
  an exact opaque Oxy routing-profile primary key. The client serializes the ID
  byte-for-byte; Oxy resolves it before constructing the stable Kaana envelope.
  Existing `model` and public `routingProfile` slug selectors remain compatible.

## 23.0.1

### Added

- Ed25519 capability-ticket issue and verification helpers with key ids,
  strict audience/resource binding and per-action limit enforcement.

### Security: `oxy.auth()` authenticated forged tokens as any account

**Every backend mounting `oxy.auth()` could be authenticated as any user by an
unauthenticated attacker.** Upgrade as soon as a version carrying this ships.

`oxy.auth()` decodes the bearer JWT with `jwtDecode`, which does not verify a
signature — by design, since third-party backends do not hold the Oxy signing
secret. Two claims were nevertheless trusted:

1. **A token carrying no `sessionId` was accepted on its claims alone.** The
   middleware skipped the network entirely and set `req.userId` straight from
   the token's `userId`. Forging a JWT with a victim's id, a future `exp` and a
   garbage signature was enough. Victim ids are public — `GET
   /profiles/username/:handle` returns one without authentication.

2. **On the session path, the identity came from the token, not the session.**
   `GET /session/validate/:sessionId` is unauthenticated and returns whoever
   owns the session id it is handed; it does not bind the bearer token. A caller
   holding any live session id — their own, for instance — could pair it with a
   forged `userId` claim and be trusted as that user.

Both are closed. A user token must now carry a `sessionId`, that session is
validated server-side, and `req.userId` is taken from the validated session and
must match the token's claim.

`authSocket()` already required a session and already cross-checked the claimed
user, and is unaffected. Service tokens are unaffected: they are HMAC-verified
with `aud` / `iss` / `type` checked, and that path is unchanged.

#### New refusals

| Code | When |
| --- | --- |
| `SESSION_REQUIRED` | A user token carries no usable `sessionId`. |
| `SESSION_USER_MISMATCH` | The token's `userId` is not the user the validated session belongs to. |

`INVALID_SESSION` additionally now covers a validation that returns no user, or
a user with no usable id.

Under `optional: true` all of these resolve to anonymous (`req.userId = null`)
rather than to the claimed user.

#### Compatibility

Every user access token the Oxy API issues already carries a `sessionId`, so no
legitimate caller is affected. Anything that relied on a session-less user token
resolving to an identity was relying on the vulnerability.

### Fixed

- `oxy.rateLimit()` no longer erases an identity that a preceding middleware
  resolved. It resolves the session through `createOptionalOxyAuth`, which skips
  when a user is already present, instead of `oxy.auth({ optional: true })`,
  which writes `req.userId = null` on every request it cannot authenticate — a
  mutation of the shared `req` that was visible to every handler downstream of
  the limiter, not just to the bucket calculation.

- A cursor-paginated page now survives the response unwrap. `{ data, …,
  nextCursor }` was reduced to `data` — the convenience unwrap preserved only the
  offset-paginated `{ data, pagination }` envelope and silently discarded every
  other sibling key — so a caller received a bare array, read `undefined` for its
  next cursor, and pagination was dead past the first page with nothing at the
  call site to show it. Measured on `GET /accounts/:id/audit` and `GET
  /accounts/:id/billing/audit`. The rule is deliberately narrow: `data` beside
  `pagination` or `nextCursor` is a page and travels whole; `{ data, count }`,
  `{ data, source }` and the other sibling shapes still unwrap, because a dozen
  Console call sites type those as the bare payload. Linked clients get the fix
  too — they are `HttpService` instances.

## 20.0.0

### Licence: AGPL-3.0-only becomes Apache-2.0

**Breaking for anyone who tracks the licence, and for nobody else.**
`@oxy.so/core` is now Apache-2.0. The code, the API surface and the behaviour are
unchanged in this release. It exists to carry the licence change.

This is a widening. Every right the AGPL granted you, Apache-2.0 grants too,
and Apache-2.0 additionally drops the network copyleft and adds an express
patent grant. Nobody has to do anything, and no existing use of this package
becomes non-compliant.

Versions published before this one keep the licence they were published under,
permanently. `19.1.2` stays AGPL-3.0-only for anyone who already has it. A licence
change binds future versions only.

The major is bumped rather than the change being slipped into a patch, so that
nobody on `^19.0.0` is moved to a new licence by a routine install. That is
exactly what happened at `12.5.4`, and it is not happening again.

### Added

- A `NOTICE` file, which Apache-2.0 section 4(d) requires downstream
  redistributors to reproduce, and a verbatim `LICENSE`.

## 17.0.2

### Fixes `17.0.0`, which could not be imported at all

`17.0.0` shipped `@oxy.so/core/server/userInvalidation`, which imports
`OXY_USER_INVALIDATION_CHANNEL`, `isPublishedOxyUserChangeReason` and
`oxyUserInvalidationEventSchema` from `@oxy.so/contracts` — but it pinned
`@oxy.so/contracts@^0.20.0`, and `0.20.0` exports none of them. A clean install of
`17.0.0` therefore failed on any import of `@oxy.so/core/server`:

```
The requested module '@oxy.so/contracts' does not provide an export named
'OXY_USER_INVALIDATION_CHANNEL'
```

That subpath carries `createOxyAuthMiddleware`, `safeFetch`, `createOxyCors` and
`verifySecret`, so a backend on `17.0.0` did not boot. `17.0.2` pins
`@oxy.so/contracts@^0.21.0`, which is the version that actually exports the symbols.
`17.0.0` is deprecated; no consumer had bumped to it. (`17.0.1` was versioned on
`main` but never published, so `17.0.2` is the first release carrying its changes.)

Nothing else changed. `17.0.1`'s wider cache sweep and `17.0.0`'s helpers are
unmodified — this release exists solely to correct the dependency range.

## 17.0.1

### `@oxy.so/core/server` — cross-service identity cache eviction

`evictOxyIdentityCache` now sweeps the same session-bound and `/users/me` prefixes
the user mixin clears after a local profile write, plus `GET:/auth/lookup/` (login-flow
lookup cache). Without these, a cross-service invalidation left stale identity in
session-scoped caches for up to five minutes.

New exports from `@oxy.so/core/server` (shipped in `17.0.0`, documented here):
`publishOxyUserInvalidation`, `createOxyUserInvalidationHandler`, `evictOxyIdentityCache`.

## 17.0.0

Shipped the invalidation publish/consume helpers on `@oxy.so/core/server` for Oxy backends
that cache identity via `OxyServices`. See `packages/core/src/server/userInvalidation.ts`.

## 16.1.0

### Display-name policy — separators admitted, swastika ideographs denied

`isValidDisplayName` / `cleanDisplayName` now admit four punctuation separators that
join real names (`·`, `־`, `་`, `・`) when flanked by letters, and reject the two
swastika ideographs (`卍`, `卐`) that slipped through the letter-only allowlist.

**Minor rather than patch:** the same input can return a different verdict than
`16.0.0` (e.g. `Codeur·euses` is now valid). No API surface changed beyond
`DISPLAY_NAME_INVALID_MESSAGE` (new export for shared client/server copy).

## 16.0.0

### BREAKING — `getServiceAssetMetadataByIds` fails closed by default

Failed chunks now throw `ServiceAssetMetadataError` instead of being swallowed.
A throttled or errored bulk lookup is no longer indistinguishable from “these ids
do not exist”. Pass `{ partial: true }` to keep the previous swallow behaviour as
an explicit opt-in.

### BREAKING — `express-rate-limit` peer range is `^8.0.0`

`server/rateLimit.ts` passes `validate: { keyGeneratorIpFallback: false }`, which
requires v8. The peer previously admitted v7, so nested installs could shadow the
root v8 devDependency and fail `tsc`.

## 15.0.0

### BREAKING — the reputation types moved to `@oxy.so/contracts`

`@oxy.so/core` no longer exports **any** reputation type, nor
`isFullReputationBalance`. The whole family now lives in `@oxy.so/contracts`
(`>= 0.20.0`), which the API's serializers are annotated and validated against —
so a server-side change to the wire shape fails the build instead of silently
diverging from the SDK type, which is what produced the view-split bug below.

**Migration:** change the import source, nothing else. The type names and their
meanings are unchanged.

```diff
-import type { ReputationBalance, TrustTier } from '@oxy.so/core';
-import { isFullReputationBalance } from '@oxy.so/core';
+import type { ReputationBalance, TrustTier } from '@oxy.so/contracts';
+import { isFullReputationBalance } from '@oxy.so/contracts';
```

Affected: `ReputationCategory`, `TrustTier`, `ReputationTransactionStatus`,
`ReputationTargetEntityType`, `ReputationDisputeStatus`,
`ReputationInfluenceContext`, `ReputationTransaction`,
`ReputationBalanceBreakdown`, `ReputationInfluence`, `ReputationReliability`,
`ReputationBalanceSummary`, `ReputationBalance`, `ReputationBalanceView`,
`ReputationDispute`, `ReputationRule`, `ReputationLeaderboardEntry`,
`ReputationInfluenceResult`, `ReverseReputationTransactionResult`,
`AwardReputationInput`, `CreateReputationDisputeInput`,
`ResolveReputationDisputeInput`, `UpsertReputationRuleInput`,
`ReverseReputationTransactionInput`, and `isFullReputationBalance`.

**One shape changed as well.** `ReputationLeaderboardEntry.user` was
`Pick<User, …> & Partial<User>`; it is now the pinned
**`ReputationLeaderboardUser`** (`id`, `username`, `name`, `avatar?`,
`publicKey?`). The API was emitting the raw `_id` on that object, so `user.id`
was `undefined` for every leaderboard row — it now really is the user id.

### BREAKING — reputation balance view split

`GET /reputation/:userId/balance` has always served two shapes (subject/staff vs
public), but the SDK type still declared the full `ReputationBalance` for every
caller. That let `balance.reliability.*` type-check on a stranger's balance and
throw at runtime.

- **`getReputationBalance(userId)`** now returns **`ReputationBalanceView`**
  (`ReputationBalance | ReputationBalanceSummary`). Only `userId`, `total`, and
  `trustTier` are reachable without narrowing.
- **`getMyReputationBalance()`** — new ergonomic path for the signed-in user's
  own balance; returns **`ReputationBalance`** directly and throws
  `OxyAuthenticationError` when the server answers with the public view (absent
  or lapsed token).
- **`isFullReputationBalance(balance)`** — type guard to narrow
  `ReputationBalanceView` to `ReputationBalance`.
- New types: **`ReputationBalanceSummary`**, **`ReputationBalanceView`**.

**Migration:** for your own balance, call `getMyReputationBalance()`. For a
third party's `total` / `trustTier`, keep `getReputationBalance(userId)`. For
private fields on an arbitrary id (subject or staff only), narrow with
`isFullReputationBalance()` before reading `breakdown`, `influence`, or
`reliability`.

## 14.0.0

Same content as 13.2.0, republished under a correct major. See the 13.2.0 entry
below for what actually changed — everything there applies here.

`13.2.0` is **deprecated on npm** and points at this version.

## 13.2.0 — DEPRECATED (shipped a breaking change under a MINOR)

> **Read this if you consume `@oxy.so/core` directly.** 13.2.0 contains a
> **runtime-breaking change to a publicly exported function** and was published
> as a MINOR, so a `^13.0.0` range could pick it up silently. It has since been
> deprecated, and npm now resolves `^13.0.0` to `13.0.0` rather than `13.2.0`;
> installing `13.2.0` explicitly still works but warns. The identical content is
> available as **14.0.0** under the correct major — prefer `^14.0.0`.

### BREAKING — `buildPaginationParams` return type

`buildPaginationParams(params)` now returns a plain **`Record<string, string>`**.
It previously returned a **`URLSearchParams`**.

**You are affected if** you call `URLSearchParams` methods on the result —
`.toString()`, `.get()`, `.append()`, `.set()`, `.has()`, `.entries()`,
`.forEach()`, or iterate it with `for...of`. Those now throw a `TypeError`,
because a plain object has none of them. This is a runtime failure, not a
compile error, so TypeScript will not necessarily catch it for you.

**Migration:** use `buildSearchParams(params)`, which is unchanged and still
returns a `URLSearchParams`.

```ts
// before
const qs = buildPaginationParams({ limit: 20 }).toString();
// after
const qs = buildSearchParams({ limit: 20 }).toString();
```

**You are NOT affected if** you passed the result to `makeRequest` /
`HttpService` — the overwhelmingly common use, and the one this change exists to
repair. That path was already broken; see below.

### Fixed — follow-graph pagination was silently ignored, and every page shared one cache entry

`buildPaginationParams` returned a `URLSearchParams`, which was then handed to
`makeRequest` as a GET's `params`. `HttpService` inspects that object with
`Object.keys(...)` in two places — `buildURL`, to decide whether to append a
query string, and `generateBaseCacheKey`, to build the request's cache key — and
`Object.keys(new URLSearchParams({ limit: '20' }))` is `[]`, because a
`URLSearchParams` exposes its entries through iterator methods rather than own
enumerable properties. Both guards therefore saw an empty object.

Two consequences, both silent at the call site:

- **No query string was ever sent.** `getUserFollowers`, `getUserFollowing`,
  `getUserMutuals`, `getMutualUserIds` and `getFollowsOfFollowsIds` all returned
  the server's default page no matter what `limit`/`offset` the caller passed.
- **Every page collapsed onto ONE cache key**, so a request for page 2 was served
  page 1's cached body without a network call.

```
before  GET /users/abc/followers
        cache key  GET:/users/abc/followers
after   GET /users/abc/followers?limit=20&offset=40
        cache key  GET:/users/abc/followers:{"limit":"20","offset":"40"}
```

`buildSearchParams` and `buildUrl` are unchanged in behaviour (their parameter
types were widened to a generic, which is strictly more permissive).

### Fixed — follow/unfollow did not invalidate the follower/following lists

`followUser`, `unfollowUser`, `followUsers` and `unfollowUsers` cleared
`follow-status`, `/users/:id`, the profile caches and `/users/me/graph`, but
never `/users/:id/followers`, `/users/:id/mutuals`, or the viewer's own
`/users/:id/following`. With the cache key fixed above, those lists became
properly content-addressed, so stale variants would have multiplied instead of
collapsing onto one entry.

All four mutation paths now funnel through a single
`invalidateFollowGraphCaches` helper, which clears the lists **by prefix** — one
logical list spans many keys (one per `limit`/`offset`/`sort` combination), so an
exact-key clear would only bust whichever page happened to be read last.

### Added — `sort` on the follow-graph reads

`getUserFollowers`, `getUserFollowing` and `getUserMutuals` accept
`sort?: 'recent' | 'oldest'` via the new `FollowGraphParams` type. Omitted leaves
the server default (`recent`). The shared `PaginationParams` is deliberately
unchanged — many endpoints have no `sort`.

New exports: `buildQueryParams`, and the types `FollowGraphSort` /
`FollowGraphParams`.
