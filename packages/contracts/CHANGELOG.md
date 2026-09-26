# Changelog: `@oxy.so/contracts`

## 3.0.0

Passkeys are removed from Oxy (ADR 0030): an account signs in with an email
code or link, an optional password and an optional authenticator, or with
Commons.

### Removed

- `webauthn.ts` and every export from it: `webauthnRegisterOptionsRequestSchema`,
  `webauthnLoginOptionsRequestSchema`, `webauthnRegisterVerifyRequestSchema`,
  `webauthnLoginVerifyRequestSchema`, `webauthnCredentialIdSchema`,
  `webauthnAssertionResponseSchema` and their types
  (`WebauthnRegisterOptionsRequest`, `WebauthnLoginOptionsRequest`,
  `WebauthnRegisterVerifyRequest`, `WebauthnLoginVerifyRequest`,
  `WebauthnAssertionResponse`).
- `identityLinkOptionsRequestSchema` / `IdentityLinkOptionsRequest` (the
  passkey assertion options of a Commons link).
- The email `recovery` purpose: `EMAIL_VERIFICATION_PURPOSES` is
  `['signup', 'signin', 'reauth']`; `emailVerificationStartRequestSchema` is
  the sign-up request `{ purpose: 'signup', email }` only. Getting back into an
  account is an email sign-in.
- `emailVerificationConfirmRequestSchema.totpCode` and
  `EmailVerificationConfirmResponse.username` (both recovery-only): the
  response is `{ ticket, expiresAt }`.
- `AuthMethodEntry` is the identity key only: `type` is `'identity'`, and
  `credentialId`/`name` are gone.

## 2.4.0

Signing in without a passkey (email code or link, password, authenticator).

### Added

- `signIn.ts`: `emailSignInStartRequestSchema`/`ResponseSchema`,
  `emailSignInConfirmRequestSchema`, `emailSignInCollectRequestSchema`,
  `emailSignInLinkRequestSchema`/`ResponseSchema`, `emailSignInPendingSchema`,
  `passwordSignInRequestSchema`, `secondFactorSignInRequestSchema`,
  `secondFactorRequiredSchema`, `signUpRequestSchema`, `reauthProofSchema`,
  `emailReauthProofSchema`, `passwordSetRequestSchema`, `signInMethodsSchema`,
  `totpEnrollResponseSchema`, `totpConfirmRequestSchema`,
  `totpReauthRequestSchema`, `totpBackupCodesResponseSchema`,
  `isSecondFactorRequired`, `SIGN_IN_ERROR_CODES`, the constants
  (`EMAIL_SIGNIN_LINK_TTL_MS`, `SIGNIN_SECOND_FACTOR_TTL_MS`,
  `SIGNIN_SECOND_FACTOR_MAX_ATTEMPTS`, `PASSWORD_MIN_LENGTH`,
  `PASSWORD_MAX_LENGTH`, `TOTP_DIGITS`, `TOTP_PERIOD_SECONDS`,
  `TOTP_BACKUP_CODE_COUNT`) and their types.
- `EMAIL_VERIFICATION_PURPOSES` gains `signin` and `reauth`.
- `REAUTH_ACTIONS` and `reauthEmailStartRequestSchema` (`{ action }`): a
  re-verification code confirms only the change it was asked for.
- `emailVerificationConfirmRequestSchema.totpCode`: a recovery of an account
  with an authenticator needs its code too.

### Changed

- `identityLinkCompleteRequestSchema` is `{ reauth }` only (an emailed code,
  plus the authenticator's): a passkey assertion no longer confirms a link.
- `emailSignInCodeSchema` / `normalizeEmailSignInCode`,
  `EMAIL_SIGNIN_LONG_CODE_ALPHABET`, `EMAIL_SIGNIN_LONG_CODE_LENGTH`: a sign-in
  code is 6 digits, or — for an account whose codes were guessed at too often
  today — 10 characters of Crockford base32 without look-alikes
  (`XXXXX-XXXXX`). UIs must accept both in one field; the start response is the
  same either way.
- `emailSignInStartResponseSchema.retryLater`: set only for a request that
  proved a device the account is already on, when no email could be sent.

## 2.3.0

The browser bridge (ADR 0029 D2).

### Added

- `deviceProofSchema` (`{ deviceId, deviceSecret }`),
  `deviceRegisterResponseSchema`, `deviceJoinCodeRequestSchema` (PKCE S256
  only), `deviceJoinCodeResponseSchema`, `deviceJoinRequestSchema` (an RFC 7636
  verifier), `deviceJoinResponseSchema` and their types.
- `webauthnLoginVerifyRequestSchema.device` and
  `webauthnRegisterVerifyRequestSchema.device`: an optional proof of the device
  the new session joins.

## 2.2.0

Web accounts are a username, a passkey and a recovery email (ADR 0029 D3).

### Added

- `accountEmail`: the recovery email of a passkey account (ADR 0029 D3) —
  `emailVerificationStartRequestSchema` (`signup` with `email`, `recovery` with
  `identifier`), `emailVerificationConfirmRequestSchema` (6 digits),
  their response schemas, `emailAddressSchema` (trimmed, lowercase),
  `emailTicketSchema`, `EMAIL_CODE_LENGTH`, `EMAIL_CODE_TTL_MS`,
  `EMAIL_CODE_MAX_ATTEMPTS`, `EMAIL_TICKET_TTL_MS`,
  `EMAIL_VERIFICATION_PURPOSES` and `EMAIL_VERIFICATION_ERROR_CODES`.
- `webauthnRegisterOptionsRequestSchema.recoveryTicket`;
  `webauthnRegisterVerifyRequestSchema.email`, `.emailTicket` and
  `.recoveryTicket`.
- `webauthnCredentialIdSchema` and `webauthnAssertionResponseSchema` (with
  `WebauthnAssertionResponse`) now live in `webauthn`.
- `identityLink`: linking Commons to a passkey account from two devices —
  `IDENTITY_LINK_STATUSES`, `IDENTITY_LINK_QR_PREFIX`,
  `buildIdentityLinkQrPayload` / `parseIdentityLinkQrPayload`
  (`oxycommons://link?id=…&c=…`), `identityLinkIdSchema`,
  `identityLinkCreateResponseSchema`, `identityLinkStateSchema`,
  `identityLinkProofRequestSchema`, `identityLinkOptionsRequestSchema`,
  `identityLinkCompleteRequestSchema` and their types.

### Changed

- `IdentityRootStatus` is `{ rootLinked, recoveryEmail }`.
- `IDENTITY_PROOF_ACTIONS` is `{ link: 'link_identity' }`: the only root proof
  left is linking Commons to a passkey account.

### Removed

- The web identity carrier and its move: `webIdentityCarrier`
  (`WEB_IDENTITY_ENVELOPE_VERSION`, every `webIdentity*` schema and type),
  `identityRecovery` (`IDENTITY_RECOVERY_TTL_MS`, `identityRecovery*`) and
  `identityMove` (`IDENTITY_MOVE_*`, `identityMove*`, `buildMove*`).
- `webauthnRegisterVerifyRequestSchema.identity` (the sign-up enrollment).
- The proof actions `web_envelope_*`, `enroll_identity`,
  `recover_account_start`, `recover_account_complete`, `identity_move_seal`, and
  the error codes `IDENTITY_ENVELOPE_REVISION_CONFLICT`, `IDENTITY_NO_ROOT`,
  `IDENTITY_LAST_WEB_HOLDER`, `IDENTITY_ENROLLMENT_REQUIRED`,
  `IDENTITY_ENROLLMENT_INVALID`, `IDENTITY_RECOVERY_FAILED`.

## 2.1.0

### Added

- `federationInstanceFetch`: `instanceFetchSignRequestSchema` (`{ url }`,
  strict — no signing string, no method) and `instanceFetchSignResponseSchema`
  (`{ keyId, headers: { Host, Date, Signature } }`) for
  `POST /federation/instance-fetch/sign`, where Oxy's instance actor signs one
  ActivityPub GET for a service holding `federation:instance-fetch`.
  `INSTANCE_FETCH_MAX_URL_LENGTH` (2048).
- `linkedAccounts`: `LINKED_ACCOUNT_START_ERROR_REASONS` —
  `instance_invalid | instance_unreachable | handle_unresolvable |
  provider_rejected | provider_unavailable` — with
  `linkedAccountStartErrorReasonSchema` and
  `linkedAccountStartErrorDetailsSchema` (`{ reason }`): the `details` of a
  400 from `POST /linked-accounts/:network/start`, so a client can tell "check
  what you typed" from "the other network refused Oxy".

## 2.0.0

### Removed

- `browserHub`: `BROWSER_HUB_COOKIE_NAME`, `BROWSER_HUB_COOKIE_ATTRIBUTES`,
  `BROWSER_HUB_HANDLE_TTL_MS` and every `browserHub*` / `hub*` schema and type.
  The browser DeviceSession hub was never deployed and is deleted (ADR 0003
  superseded); no origin holds a cookie.

## 1.5.0

### Added

- `linkedAccounts`: the wire contract of `/linked-accounts` —
  `LINKED_ACCOUNT_NETWORKS` (`activitypub | atproto`),
  `startLinkedAccountRequestSchema` (`clientId` and `returnTo` required) /
  `startLinkedAccountResponseSchema`, `completeLinkedAccountRequestSchema`
  (`{ code }`) / `completeLinkedAccountResponseSchema`,
  `linkedAccountSchema`, `linkedAccountListResponseSchema`, the service read's
  `serviceLinkedAccountSchema` / `serviceLinkedAccountListResponseSchema`
  (adds `federatedUserId`), and `LINKED_ACCOUNT_CALLBACK_ERRORS`. Every
  response schema is strict and has no field a third-party token could occupy.
- `notifications`: `OXY_NOTIFICATION_TYPES` (gains `system`),
  `OXY_NOTIFICATION_ENTITY_TYPES` (gains `app`, valid only for `system`), and
  `createOxyNotificationRequestSchema`. A `system` notification requires
  `title` and `message`, may carry a `url`, and names the recipient as its
  actor; `url` and `entityType: 'app'` are refused on every other type.

## 1.4.0

### Added

- `inferenceReasoningSchema` (`{ effort }`, strict) and `reasoningEffortSchema`
  (`low | medium | high`). `inferenceRequestSchema` gains an optional
  `reasoning`; the envelope stays at wire `schemaVersion: 2` because the field
  is optional. Types `InferenceReasoning`, `ReasoningEffort`.
- `modelCapabilitiesSchema.reasoningEfforts` (defaults to `[]`) beside the
  existing `reasoning` boolean, which is kept for compatibility.
- `modelCatalogueEntrySchema.releasedAt` (optional ISO timestamp): the date the
  upstream provider reports it published the model.
- `INFERENCE_CONTRACT_VERSION` is `3.1.0`. MINOR, because the strict
  capabilities leaf now carries a key an older consumer refuses.

## 1.3.0

(These notes sat under "Unreleased"; no `src/` change landed between the 1.3.0
release commit and 1.4.0, so they shipped in 1.3.0.)

### Added

- `identityProof`: `buildIdentityProofMessage`, `canonicalJson`,
  `identityProofSchema`, proof-challenge request/response schemas,
  `IDENTITY_PROOF_ACTIONS` and the stable `IDENTITY_ERROR_CODES` (ADR 0024 D7).
- Web identity envelope (one scheme, `version: 2`): `WEB_IDENTITY_SECRET_KINDS`,
  required wrap `rpId`, `verifiedAt`, holder metadata and readiness facts on the
  envelope response, proof fields on every envelope write,
  `webauthnAssertionResponseSchema`, and the sign-up `identity` enrollment on
  `webauthnRegisterVerifyRequestSchema`.
- Identity move: commitment create request, reveal request, seal request with an
  `identity_move_seal` root proof, `initiatorCommitment`/`initiatorCommitmentNonce`
  on the state (initiator key `null` until revealed), `{ signature }` receipt,
  12–24-word ciphertext lengths, and the canonical commitment/SAS/digest/seal/
  receipt builders.

### Removed

- **Breaking:** `devicePairing` schemas; the version-1 web identity envelope and
  unscoped wraps; identity move `protocolVersion`, `receiptTimestamp` and the
  version-1 create/receipt shapes; `IDENTITY_ERROR_CODES.rootNotUnlinkable`.

## 0.41.0

### Changed

- Replaced the Alia-specific `internal_alia` availability member with
  `platform_internal`. The new name is an Oxy application audience: reviewed
  routes are visible to staff-classified `first_party`, `internal` and `system`
  applications, never to third-party applications or plain users.
- `modelDeploymentSchema` advances from wire `schemaVersion: 1` to `2`, and
  `modelCatalogueEntrySchema` from `2` to `3`. The contract-set handshake is
  `3.0.0`; older consumers fail on the version instead of silently assigning the
  new commercial boundary its retired Alia-only meaning.

## 0.40.0

### Added

- `routingProfileIdSchema` is the shared opaque-ID bound used by catalogue
  projections and Oxy's exact product-routing selector. It applies only length
  bounds and never trims, case-folds, parses, or otherwise substitutes an ID.
- Signed inference requests and canonical routing-policy snapshots now carry
  only `{ kind: "routing_profile_id", routingProfileId }`. The former slug arm
  is removed from the cross-service boundary. Consequently
  `inferenceRequestSchema` and `routingPolicySchema` advance to wire
  `schemaVersion: 2`; the contract-set version is `2.0.0`. Oxy may still accept
  the deprecated public `routingProfile` request field, but must resolve it to
  one exact profile PK before constructing either canonical shape.

## 0.36.0

### Added

- Canonical contracts for actors, resources, delegation grants,
  automations, capability tickets, app capability catalogs and correlated
  audit events.
- A typed email-agent context that carries the effective mailbox and account
  instead of relying on prompt conventions.

## 0.29.0

### `safeErrorTextSchema`: redacting against the old pattern could make a leak worse

**Read this if you produce inference error text.** The credential pattern was
bearer-shaped — it matched markers (`authorization:`, `api_key=`, `sk-…`) and
nothing about the value beside them. An upstream echoing a request header sends
`{x-api-key: <the key>}`; the pattern matched `api-key`, so a producer redacting
the SPAN it matched emitted `{x-[redacted] <the key>}`, which no longer matched
and was therefore **accepted**. The unredacted string was refused and the
redacted one was not, and both carried the key. Measured by the second outside
implementation of this contract (OxyHQ/Kaana#3), not theorised.

The refinement now checks four independent signals, so removing one does not
clear a string: a credential-bearing name (the whole `x-…`/`…-api-key` family,
not two literal spellings) assigned a value long enough to be a credential; a
bearer token; issued token grammars that are credentials wherever they appear
(`sk-…`, `sk_live_…`, JWTs, `AKIA…`, `ghp_…`, `AIza…`); and a redaction
placeholder standing next to a value that survived it.

**What this refuses that it did not:** a header-family marker with a live value,
an issued token with no marker in front of it, and a redaction that left the
value behind.

**What it now accepts that it did not:** a marker whose value has been replaced —
`Authorization: [redacted]`, `api_key=***`. That is deliberate. Refusing a
correct redaction is what made stripping the marker the only way to satisfy the
old pattern, which is the defect above.

**It is a last-resort refusal and not protection, and the doc comment now says
so.** A pattern reading the output cannot be the primary control; redacting the
known secret VALUE, at the point where the producer still holds the bytes it
sent, is. Do not redact by replacing the span this pattern matches, and do not
read acceptance here as evidence a string is clean. This package deliberately
ships no redaction helper: one keyed on these patterns would rebuild the same
defect a layer up.

### Added

- **`provider_billing_refused`** — an upstream declining to bill OXY (several
  answer `402`). Non-retryable, like `provider_credential_invalid`, and separate
  from `quota_exceeded`, which is right about retryability and points the
  customer at their own balance — an account that is not the one at fault.
- **`refusal`** as an `inferenceFinishReasonSchema` member, distinct from
  `content_filter`. The model declining to answer and an upstream filter removing
  an answer are separate events, and the delta channels already carried the
  distinction (`channel: 'refusal'`).

### Changed

- `INFERENCE_CONTRACT_VERSION` is `1.1.0`. The version rule now states that a
  closed enum gaining a member and a refinement changing which bytes parse are
  both MINOR: each lets a producer on the newer set emit something the older set
  refuses, with no per-message `schemaVersion` difference to explain it.

## 0.25.0

### Licence: AGPL-3.0-only becomes Apache-2.0

**Breaking for anyone who tracks the licence, and for nobody else.**
`@oxy.so/contracts` is now Apache-2.0. The code, the API surface and the behaviour are
unchanged in this release. It exists to carry the licence change.

This is a widening. Every right the AGPL granted you, Apache-2.0 grants too,
and Apache-2.0 additionally drops the network copyleft and adds an express
patent grant. Nobody has to do anything, and no existing use of this package
becomes non-compliant.

Versions published before this one keep the licence they were published under,
permanently. `0.24.0` stays AGPL-3.0-only for anyone who already has it. A licence
change binds future versions only.

`@oxy.so/contracts` is below 1.0.0, where semver puts the breaking position in the minor
and `^0.24.0` does not accept `0.25.0`. Bumping the minor is therefore the
same signal a major bump gives a 1.x package: no consumer picks this up
without editing their manifest, which is the whole point.

### Added

- A `NOTICE` file, which Apache-2.0 section 4(d) requires downstream
  redistributors to reproduce, and a verbatim `LICENSE`.
