# Changelog — `@oxy.so/core`

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
`publicKey?`). The API was emitting Mongo's `_id` on that object, so `user.id`
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
