# Platform features and their contracts

> Moved out of `AGENTS.md` unchanged. The one-line rules stay there.

## Workspaces (2026-06-15)

**Models in `packages/api/src/models/`:**
- `Workspace` (collection `workspaces`): `type` personal|team, `slug`, `ownerId`. Personal workspace is MANDATORY — created automatically for every user, NOT renamable (PATCH rejects rename for `type:'personal'`), cannot be deleted.
- `WorkspaceMember` (collection `workspacemembers`): `workspaceId`+`userId` unique; `role` owner|admin|member|viewer.

**Routes:** `packages/api/src/routes/workspaces.ts` at `/workspaces`. `GET /workspaces` calls `ensurePersonalWorkspace` UNCONDITIONALLY so every user always has a Personal workspace. RBAC via `requireWorkspacePermission`.

**Application scoping:** `Application.workspaceId` is REQUIRED. `GET /applications?workspaceId=` filters by workspace; access granted if workspace member OR `ApplicationMember`.

**SDK:** `@oxyhq/core` `workspaces` mixin — `OxyServices.workspaces.ts` with CRUD + members + transfer. `Workspace`/`WorkspaceMember` types exported. `getApplications(workspaceId?)` accepts workspace scope.

**Production "Oxy" team workspace:** `_id 6a2f9d8989b795cfdfac350f`, slug `oxy`, owned by user `oxy` (`_id 69b2d3df5d12f58c9800d651`, username `oxy`, email `hello@oxy.so` — DISTINCT from human `nateus`/`nate@oxy.so`). All 12 official Applications assigned to it. Migration `scripts/migrate-workspaces.ts` ran (idempotent).

## Oxy Trust — Reputation System (#217 + #219, 2026-06-16)

**Full hard replacement of the karma system. NO back-compat. Karma collections (`karmas`, `karmarules`) NOT auto-dropped — manual drop after migration verification.**

### API models (`packages/api/src/models/`)
- `ReputationTransaction` (collection `reputationtransactions`): ledger; `status` active|reversed|voided; `category` content|social|trust|moderation|physical|penalty|other; `sourceActionId` for idempotency.
- `ReputationBalance` (collection `reputationbalances`): cached per-user; `total`, `positive`, `negative`, `breakdown`, `reliability`, `trustTier`, `influence`; recalculated on demand.
- `ReputationDispute` (collection `reputationdisputes`): dispute lifecycle for contested transactions.
- `ReputationRule` (collection `reputationrules`): configurable award rules (replaces `KarmaRule`).
- **Deleted:** `Karma.ts`, `KarmaRule.ts`, `karma.controller.ts`, `karma.routes.ts`, `karma.schemas.ts`, the `KARMA` const, `UserStatistics.karma` field.

### Service (`packages/api/src/services/reputation.service.ts`)
Single source of truth. Key methods:
- `award(input)` — rule-driven, respects cooldown, idempotent on `(applicationId, sourceActionId)` via sparse partial-unique index.
- `reverseTransaction(id)` — marks original `reversed` + inserts compensating `-points active` txn → nets to zero. Never deletes.
- `voidTransaction(id)` — excludes from balance without compensating txn.
- `recalculateBalance(userId)` — aggregates `active`-only txns → total/positive/negative/breakdown + reliability + trustTier + influence.
- `getBalance(userId)`, `getInfluence(userId, context)`, `createDispute`, `resolveDispute`.

### Routes (`/reputation`, CSRF parity with old `/karma`)
- `GET /leaderboard`, `GET /rules`, `POST /rules` (staff)
- `GET /:userId/balance`, `POST /award` (service-token OR staff; regular users 403; service-token resolves `applicationId`/`credentialId` from `req.serviceApp`)
- `GET /:userId/transactions`, `GET /:userId/influence?context=default|report|moderation|ranking`
- `POST /transactions/:id/reverse` (staff), `POST /transactions/:id/void` (staff)
- `POST /:userId/recalculate` (staff)
- `POST /disputes`, `GET /disputes` (staff queue), `GET /:userId/disputes`, `POST /disputes/:id/resolve` (staff)

### Constants (`packages/api/src/utils/reputation.constants.ts`)
- Trust tiers (top-down): `restricted` (total<0 OR abuseScore>=0.5) → `verified` (User.verified) → `high_trust` (total>=500) → `trusted` (total>=100) → `new`.
- Influence clamped [0.1, 3.0]; base=clamp(0.1+total/500); moderation factor map: `{restricted:0, new:0.5, trusted:1.0, high_trust:1.25, verified:1.5}`; restricted floors ALL weights to 0.1.
- Reliability source keys: `report_confirmed`/`report_rejected`; abuseScore smoothing window=5.

### Rate-limit prefixes (reputation)
`rl:reputation:read:`, `rl:reputation:award:`, `rl:reputation:admin:`, `rl:reputation:dispute:`

### Migration
There is none, and there is nothing pending. Karma was hard-replaced by the reputation ledger (b28f886b, PRs #217/#219), and `karmas`/`karmarules` were verified EMPTY cluster-wide before the Postgres port — the port's own collection map recorded them as "no table, and nothing to move". `scripts/migrate-karma-to-reputation.ts` was therefore a documented no-op against production and has been deleted along with the rest of the Mongo one-shots. Do not re-add a "balances read 0 until the migration runs" note: it was never true after b28f886b, and the collection it would have read no longer exists.

### Types (`@oxyhq/contracts` — `src/reputation.ts`)
**`@oxyhq/contracts` owns the whole reputation type family** — the closed value sets (`REPUTATION_CATEGORIES`, `TRUST_TIERS`, `REPUTATION_TRANSACTION_STATUSES`, `REPUTATION_TARGET_ENTITY_TYPES`, `REPUTATION_DISPUTE_STATUSES`, `REPUTATION_INFLUENCE_CONTEXTS`), the response entities (`ReputationTransaction`, `ReputationBalanceSummary` / `ReputationBalance` / `ReputationBalanceView`, `ReputationBalanceBreakdown`, `ReputationInfluence`, `ReputationReliability`, `ReputationDispute`, `ReputationRule`, `ReputationLeaderboardUser` / `ReputationLeaderboardEntry`, `ReputationInfluenceResult`, `ReverseReputationTransactionResult`), the write-endpoint request schemas + input types, and the `isFullReputationBalance` narrowing guard. `@oxyhq/core` declares NONE of them and re-exports NONE of them; every consumer imports from `@oxyhq/contracts` directly.
- The API's Drizzle schema enums (`ReputationTransaction`/`ReputationRule`/`ReputationDispute`/`ReputationBalance`/`User`) and its `validate({ body })` schemas import the SAME tuples/schemas, so a value set cannot be widened on one side only. `packages/api/src/utils/reputation.constants.ts` keeps only the numeric TUNABLES.
- Each serializer in `packages/api/src/routes/reputation.routes.ts` builds a `const dto: <ContractType>` (compile-time guard: a missing field, an undeclared field, or a `Date` where the wire promises an ISO string all fail `tsc` and name the field) and returns `schema.parse(dto)` (runtime guard). Do NOT loosen a serializer's return type back to `Record<string, unknown>` — that is exactly what let the `/:userId/balance` view split diverge from the SDK type silently.

### SDK (`@oxyhq/core` — `reputation` mixin)
- 15 methods on `OxyServices`: `getReputationBalance`, `getMyReputationBalance`, `getReputationLeaderboard`, `getReputationRules`, `getReputationTransactions`, `getReputationInfluence`, `awardReputation`, `createReputationDispute`, `getUserReputationDisputes`, `upsertReputationRule`, `reverseReputationTransaction`, `voidReputationTransaction`, `recalculateReputation`, `getReputationDisputeQueue`, `resolveReputationDispute`.
- Writes sweep `clearCacheByPrefix('GET:/reputation/')`.
- **Deleted:** karma mixin + `KarmaRule`/`KarmaHistory`/`KarmaLeaderboardEntry`/`KarmaAwardRequest` types + `User.karma` field + `UserStats.karmaScore`.
- **SEMVER NOTE:** the karma removal was a breaking change. Peer ranges in `@oxyhq/services` were updated at publish time.

### Services (`@oxyhq/services`) — Trust screens
- 4 screens renamed Karma*→Trust* + About/FAQ under `src/ui/screens/trust/`.
- **BREAKING `RouteName` change:** removed `KarmaCenter|KarmaLeaderboard|KarmaRewards|KarmaRules|AboutKarma|KarmaFAQ`; added `TrustCenter|TrustLeaderboard|TrustRewards|TrustRules|AboutTrust|TrustFAQ`. Consumers calling `showBottomSheet('Karma...')` MUST migrate. `test-app-expo` already migrated.

## API: userCache Invalidation Rule

**Every** API route that modifies user state (`updateUserProfile`, `PATCH /privacy/:id/privacy`, `PUT /users/:userId/privacy`, etc.) MUST call `userCache.invalidate(userId)` after the write. Skipping this causes the in-memory cache to return stale pre-write data on the next `getUserBySession`, silently reverting client updates.

Every `rateLimit()` call MUST also pass a unique `prefix` (see "Rate Limiting" below) — the factory in `packages/api/src/middleware/rateLimiter.ts` enforces it as required.

## Rate Limiting (api)

All limiters use `rate-limit-redis` with a shared ioredis client. The factory `rateLimit({ windowMs, max, prefix, ... })` in `packages/api/src/middleware/rateLimiter.ts` requires a unique `prefix` per limiter instance.

**Why unique prefixes are mandatory** (commit `ef222ecc`): without a per-instance `prefix`, every `rate-limit-redis` store writes to the same default Redis key. When a request passes through the global limiter AND a route-specific limiter, the same key is incremented twice and `rate-limit-redis` throws `ERR_ERL_DOUBLE_COUNT`, halving the effective budget. Each limiter MUST own its own key namespace.

**Convention**: `rl:<scope>:` where scope identifies the limiter purpose.

**Prefixes in use:**
- `rl:general:` — global limiter (1000 / 15min)
- `rl:idp:service:` — IdP worker server-to-server READ budget (`/session/validate/*`, 20000 / 15min prod)
- `rl:auth:` — broad auth routes (`authRateLimiter`, 300 / 15min)
- `rl:user:` — user routes (`userRateLimiter`, 200 / 15min)
- `rl:auth:challenge:`, `rl:auth:verify:`, `rl:auth:refresh:`, `rl:auth:lookup:`, `rl:auth:session-claim:`, `rl:auth:oauth-authorize:`, `rl:auth:oauth-consent:`, `rl:auth:oauth-token:`, `rl:auth:service-token:`, `rl:auth:login:`, `rl:auth:client-lookup:`
- `rl:session:device-token:` — the zero-cookie device-secret mint (`POST /session/device/token`, `packages/api/src/routes/sessionDevice.ts`)
- `rl:session:hub-establish:`, `rl:session:hub-resolve:`, `rl:session:hub-rotate:`, `rl:session:hub-revoke:` — the browser hub (`packages/api/src/routes/browserHub.ts`). Establish is keyed on the bearer's device; the other three on a PREFIX of the presented handle's hash, because every request arrives from Cloudflare's edge and an IP key would collapse the whole hub onto a few buckets. Guessing is bounded by the handle's 256 bits, not by a limiter
- `rl:apps:authorized:read:`, `rl:apps:authorized:revoke:` — connected-apps (`AppGrant`) surface; `rl:auth:grants:read:`, `rl:auth:grants:revoke:` — OAuth grant management
- `rl:contacts:discover:` (200 hashes/request, 5 req/min/user)
- `rl:social-auth:`
- `rl:email:inbound:`, `rl:email:proxy:`
- `rl:userdata:write:`
- `rl:reputation:read:`, `rl:reputation:award:`, `rl:reputation:admin:`, `rl:reputation:dispute:`
- `rl:auth:session-approve-info:`, `rl:auth:session-authorize-signed:` — Commons QR handoff endpoints
- `rl:auth:session-finalize:` — OAuth-bound Commons approval finalize (issue #691 Phase 3, `POST /auth/session/finalize/:sessionToken`); `rl:auth:session-deliver:` — automatic push delivery (Phase 4, bearer-required); `rl:auth:session-opened:` — delivery-opened progress ping (Phase 4, no bearer)
- `rl:identity:export:` (5/hr — signed data export), `rl:identity:domainreq:`, `rl:identity:domainverify:` — domain verification
- `rl:civic:attest:` (real-life QR attestation), `rl:civic:validate:` (jury vote submit), `rl:civic:vouch:` (personhood vouch/withdraw), `rl:civic:credential:` (credential issue/revoke)
- `rl:transparency:read:` — public transparency-log reads (`GET /transparency/*`, 600 / 15min)
- `rl:updates:manifest:` (public expo-updates manifest poll), `rl:updates:publish:`, `rl:updates:read:` — Oxy Updates admin surface

## Federation (`@oxyhq/federation`)

`packages/federation` → `@oxyhq/federation` (published to npm — `package.json` is the version source of truth, not this file) is the app-agnostic ActivityPub identity + follow engine substrate: the network-connector contract, normalized cross-network DTOs, HTTP signatures, the local-actor builder, and remote-actor resolution. The isomorphic `.` entry stays free of Express/Mongoose so it can be imported anywhere; the runnable engine (signed fetch, delivery transport, webfinger/actor/inbox routers) lives under the separate `./node` subpath so it never enters isomorphic bundles. Mention is the connector consumer; oxy-api imports only pure functions off the isomorphic entry — host canonicalisation (`canonicalFederationHost`, `isSameFederationHost`), the upstream-URL parser (`federatedUsernameFromUpstreamUrl`), and HTTP-signature signing (`signRequest`) — never the connector contract or the `./node` Express routers.

**Bridge relabelling — the mechanism ships here, the trust entries never do.** An account republished by a bridge (e.g. `@wired@bird.makeup`, mirroring X's `@wired`) is re-labelled onto the network it actually came from. `createBridgeRelabeller(entries)` — the derivation engine, the network vocabulary (`FEDERATION_NETWORKS`: x, instagram, bluesky), and the bidirectional upstream-profile-URL rule (`upstreamProfileUrl` / `parseUpstreamProfileUrl`, ONE declaration read forwards to render a link and backwards to recognise a pasted one) — ships with ZERO bridge entries. Which operators may be trusted to re-attribute somebody's account is a moderation judgement each consuming app commits and answers for; `entries` is a parameter, never baked in. Mention's own reviewed list lives in `Mention/packages/backend/src/connectors/activitypub/federationBridgePolicy.ts` (see that repo's `AGENTS.md`).
- `relabel: 'enabled' | 'pending_dedup'` per entry — relabelling MANUFACTURES duplicates (two bridges of one network start rendering the identical handle), so an entry can be committed and reviewed while staying inert until its collision set is measured and any pre-existing duplicates are merged.
- An empty derived handle is refused, never merged: it is the signature of a BROKEN derivation rule, not an unusual account, and merging on it would collapse every actor on a domain onto one person.
- FEP-fffd `proxyOf` (`readProxyDeclarations`, `upstreamHandleFromProxyOf`) is parsed for every actor but is only ever a derivation SOURCE inside a reviewed bridge entry — never honoured globally, because it is a claim an untrusted remote actor makes about its OWN identity (any actor on any instance can publish a `proxyOf` naming anyone). `authoritative` on a declaration defaults to `false` when absent and is read as `=== true`, never by truthiness — it is the one bit separating "this actor IS that account" from "this actor is one copy of it." Nothing in production ingests it yet (only two Nostr bridges publish it, and Nostr npubs have no `@handle@domain` form to relabel onto) — it exists so a future FEP-fffd bridge needs a reviewed entry, not new code.

**oxy-api adjudicates independently, with a second, deliberately un-consolidated trust list.** `PUT /users/resolve` binds a federated actor URI's host to the domain the caller asserts, so a service cannot vouch for a user on a host it does not own — a bridged identity is the one case those legitimately differ, and oxy-api decides for itself whether to believe a re-attribution via its OWN list, `packages/api/src/config/federationBridgeTrust.ts` (`bridgeVouchesForNetwork`), never importing Mention's. **This is not duplication and must not be "tidied" into one shared list.** Kept separate, drift fails CLOSED in both directions: an app derives for a bridge oxy-api does not trust → the resolve is refused and the actor keeps its bridge identity; oxy-api trusts a host no app derives for → nothing happens. Consolidating them would let a single unreviewed entry in either repository start re-attributing real people's writing — the redundancy is the safety mechanism, stated in comments at both this file and Mention's `federationBridgePolicy.ts` (two sites, so whoever next finds the same domains listed twice and reaches for the obvious tidy-up finds the reason first).

**Search by pasted profile URL.** Pasting an `x.com`, `instagram.com`, or `bsky.app` profile link into search now finds the account we hold under its federated handle (`nasa@x.com`) — previously unreachable by substring match, since we store the bridged identity, not the URL. `peopleSearchMatch` (`packages/api/src/utils/profileQuery.ts`) is the ONE chokepoint `/search`, `/profiles/search`, and `POST /users/search` all funnel through: when the pasted text parses as a network profile URL (via `federatedUsernameFromUpstreamUrl`, the SAME `FederationNetwork.storedUsername` rule the ingest path uses — never a second parsing rule, which is exactly how the Bluesky `.bsky.social`-suffix-dropping case would have silently diverged from ingest), the exact match REPLACES the fuzzy match rather than joining it, and a URL that parses but matches nobody returns zero rows rather than falling back to a fuzzy search. The URL is parsed only, never fetched — fetching a user-supplied URL from a search endpoint would be an SSRF surface for no benefit.

**Blocked-domain platform-data purge.** `POST /federation/domain-purge` (service auth, under the `/federation` mount's existing `federationServiceLimiter`) removes the federated identities and mirrored media Oxy holds for a blocked domain — the platform-side counterpart to an app's own content purge. Safe by default (`dryRun` defaults `true`) and doubly gated for a real deletion: the caller must pass `dryRun:false` AND the deployment needs `FEDERATION_DOMAIN_PURGE_ENABLED=true` set, else 409 — arming the endpoint is an operator decision on THIS deployment, independent of whatever calls it. Bounded and resumable (`limit` actors per call, default 200; response carries `done`/`nextCursor`/`remaining`); a repeated or already-completed purge is a no-op. A caller only ever deletes files it recorded itself (`req.serviceApp.appId` from the service credential, never the request body) — a user row shared with another application is archived, not deleted, and the response names the apps that kept it. Driven today by Mention's `run-blocked-domain-purge.yml` ECS one-shot (in-VPC, `main`-only — see `~/Oxy/Mention/AGENTS.md`).

## Oxy Updates — self-hosted OTA (api + ship + console)

Self-hosted `expo-updates`-protocol OTA server, namespaced entirely under `/updates/v1` (`packages/api/src/server.ts`) so it never clashes with the rest of the API.

- **Public manifest endpoint** (`packages/api/src/routes/updates.ts`): `GET /updates/v1/apps/:clientId/manifest` — no auth, no CSRF (mounted before the CSRF group); `:clientId` is an `ApplicationCredential.publicKey` (`oxy_dk_…`). Resolves `(channel, runtimeVersion, platform)` from expo-updates request headers and returns a signed `multipart/mixed` manifest or a `noUpdateAvailable` directive via `manifest.service.ts`.
- **Admin surface** (`packages/api/src/routes/updatesAdmin.ts`): channel/publish/rollback management, gated by the `Application`/role permission system (not a separate auth scheme).
- **Models** (`packages/api/src/models/`): `AppUpdate`, `UpdateAsset`, `UpdateChannel`.
- **Services** (`packages/api/src/services/updates/`): `manifest.service.ts`, `publish.service.ts`, `signing.service.ts` (code-signing; throws `CodeSigningNotConfiguredError` when keys aren't set up — see the keygen script), `assetKeys.ts`.
- **Publishing CLI:** `@oxyhq/ship` (`packages/ship`, bin `oxy-ship`) parses an `expo export` output, hashes assets, and publishes to a channel via the admin API — see `packages/ship/README.md`.
- **Console UI:** per-app Updates tab at `packages/console/src/routes/_layout/apps/$appId/updates.tsx` (+ `components/apps/updates-section.tsx`).

**General limiter threshold** (commit `641cea67`): raised 150 → **1000 / 15min**. The 150 ceiling was below a single authenticated user's normal traffic (feed scroll + socket fallback polling + profile loads + device-secret token mints). Per-endpoint limiters (`authRateLimiter` 300, `userRateLimiter` 200, `checkLimiter` 10/min, etc.) remain the relevant defense-in-depth. **Do NOT lower the general limiter below 1000 without measuring real production traffic.**

## Contact Discovery (api + core)

- Endpoint: `POST /contacts/discover` — accepts `{ hashedEmails: string[], hashedPhones: string[] }` (SHA-256 on client before sending; no PII stored server-side)
- Rate limited: 200 hashes per request, 5 requests/min/user
- Core mixin: `oxy.contacts.discoverContacts(hashedEmails, hashedPhones)`
- `User` model has `hashedEmail`, `hashedPhone`, `phone` fields; `hashedEmail` / `hashedPhone` auto-computed via pre-validate hook

## Accounts App Patterns (packages/accounts — "Accounts by Oxy")

**Post-PR #415: Accounts is KEYLESS and management-only.** All identity creation, key management, recovery phrase, backup, and key-based flows moved to `packages/commons`. Accounts signs in via the shared `OxyAccountDialog` from `@oxyhq/services` — one primary "Continue with Oxy" action, Commons QR / shared-keychain / automatic delivery (issue #691 Phases 4–5); there is no password option in this dialog. Account deletion deep-links to `commons://delete-account` — Accounts no longer owns the key-signed deletion flow.

- **i18n**: `LocaleProvider` + `useTranslation` hook in `packages/accounts/lib/i18n/`; 11 locales (EN + ES fully populated); device locale via `Intl.DateTimeFormat().resolvedOptions().locale` (no `expo-localization` native module needed)
- **Typed routes**: `typedRoutes: true` in `app.json` — all `router.push()` calls must use typed path strings, no `as any` casts
- **Error boundaries**: at root, `(tabs)`, and `(auth)` layout levels using an `ErrorFallback` component
- **Activity History**: `/(tabs)/activity.tsx` using `GET /security/activity` with infinite scroll
- **Font**: do NOT set `fontFamily: 'Inter-*'` — `BloomThemeProvider` sets Inter as `Text.defaultProps` globally
- **expo-router v56**: no `@react-navigation/*` direct imports; synthesize `{ type: 'OPEN_DRAWER' }` payloads inline
- **`(auth)` routing** (session-only gate): `(auth)`↔`(tabs)` now keys **purely on session** — `needsAuth = isAuthResolved ? !isAuthenticated : true`. No `hasIdentity`/`KeyManager` in routing. `(auth)/index.tsx`: session resolved + authenticated → `/(tabs)`; not authenticated → sign-in. Always clean up timers from entrance animations.
- **Username step**: use `useUpdateProfile().mutateAsync()`, NOT `oxyServices.updateProfile()` directly — gets optimistic update + cache invalidation. Stable initial value via lazy `useState` initializer (no `useEffect` reset on remount).
- **`useUpdatePrivacySettings`**: do NOT call `invalidateAccountQueries(queryClient)` in `onSuccess` (defeats optimistic merge). Use `{ ...previous, ...requested, ...incoming }` merge in `onMutate`. `onError` does targeted `invalidateQueries({ queryKey: queryKeys.privacy.settings(...) })` for reconciliation.
- **Web sign-in**: same in-app `OxyAccountDialog` as native — no redirects. No web identity creation (Commons is native-only; Accounts web is management after sign-in only).
- **Shared modules** (use these, don't re-duplicate): `utils/relative-time.ts` + `hooks/useRelativeTime.ts` (i18n-aware relative time); `utils/device-utils.ts` (getDeviceIcon, getDeviceDisplayName, DeviceRecord, groupDevicesByType); `hooks/useAvatarUrl.ts`; `hooks/useDebounce.ts`; `constants/payments.ts` (FAIRCOIN_WALLET_URL); `constants/drawer-screens.ts` (typed DrawerScreenConfig[] — lives in `constants/` NOT `app/` so expo-router doesn't register it as a route); `constants/styles.ts` (`floatingPosition`: `Platform.select({ web: 'fixed', default: 'absolute' })` for floating action bar / FAB — used by `(tabs)/_layout.tsx` + `components/ui/bottom-action-bar.tsx`).
- **Shared UI components** (use these, don't re-duplicate): `components/ui/empty-state-card.tsx` — `EmptyStateCard` (icon + title + subtitle, optional `subtitleColor?`) — single shared empty-state used by security + payments sections (replaced 3 duplicated inline empty states); `components/ui/circle-icon-badge.tsx` — `CircleIconBadge` (36dp circular icon wrapper) — shared across identity cards, payments info, home actions; `components/ui/quick-action-button.tsx` — accepts `size?` prop (default 48) — reused by `bottom-action-bar` and `home-bottom-actions` (home footer no longer hand-rolls badge buttons).
- **God-screen decomposition**: section components under `components/sections/` (+ shared `GroupedItem`/`PrioritizedGroupedItem` types in `components/sections/types.ts`), `components/security/`, `components/home/`, `components/payments/`; hooks under `hooks/home/*`; identity auto-sync in `hooks/identity/useIdentitySync.ts`; pure helpers `utils/security-recommendations.ts`, `utils/payment-utils.ts`.
- **`payments.tsx`**: reads `timestamp` field (NOT `createdAt`) for payment/transaction dates.
- **Removed unused deps**: `@radix-ui/react-tabs`, `react-responsive`, `@lottiefiles/dotlottie-react-native`, `expo-symbols`. KEEP `expo-document-picker` + `expo-image-manipulator` (lazy-loaded optional peers of `@oxyhq/services`) and `@lottiefiles/dotlottie-react` (hard-required by web lottie export).

## Commons App (packages/commons — "Commons by Oxy", PR #415)

**NATIVE-ONLY identity vault — no web build, no Cloudflare Pages project.** All key/identity UX from Accounts has been extracted here.

- **Bundle**: `so.oxy.commons`, scheme `commons`/`oxycommons`, package name `commons`
- **Purpose**: Hello Human onboarding, create/import identity, recovery phrase, encrypted backup, key display, biometric sign-in, QR scanner + approval screens for "Sign in with Oxy"
- **Metro config** (MANDATORY): mirrors `packages/accounts/metro.config.js` exactly — the Bloom single-instance `resolveRequest` rewrite is required to prevent duplicate React context crashes
- **Pinned native deps**: match accounts / whatever the current Expo SDK bundles — `package.json` is the source of truth, do not hardcode versions here; honor root `overrides`
- **Routing**: bidirectional Stack guard; `useOnboardingStatus` with `hasIdentity` gate is correct here (Commons legitimately owns the identity gate). Native-only: Hello Human → welcome → create/import → vault group `(vault)`. No web entry variants or web blockers.
- **Onboarding gate is LOCAL-FIRST — never key it on session/network state.** `useOnboardingStatus` decides routing PURELY from local reads (`KeyManager.getIdentityStatus()` + an offline-safe onboarding-complete milestone); `isAuthResolved` / the SDK's cold-boot loading flag must never gate, delay, or downgrade that local verdict (an active session is only consulted as an earlier, authoritative override, never a routing precondition). `'none'` (welcome/auto-create) requires a positive `absent` verdict AND no identity marker — a marker-backed `lost` verdict routes to the recover-identity screen, and `unavailable` (storage threw) routes to a neutral retry surface, never to welcome/create. The create/import preflight uses `KeyManager.getIdentityStatus({ bypassCache: true })` plus the marker to decide whether it's safe to generate a new identity — do not reintroduce a cached `getPublicKey()` preflight for this decision.
- **For account management**: Commons deep-links to `accounts://` (Accounts). Accounts deep-links to `commons://` for key/backup/recovery/delete.
- **Delete account flow**: `commons://delete-account` — key-signed deletion via `KeyManager.getPublicKey()` → sign `delete:${publicKey}:${ts}` → `DELETE /users/me`. Strict order: `deleteAccount` → `purgeIdentity` (primary AND backup, success-only) → `signOutAll`; local-purge failure is non-fatal.
- **Recovery phrase**: mandatory acknowledgement screen at `/(auth)/create-identity/recovery-phrase` before identity creation completes; persistent reminder in Security screen until acknowledged.
- **CI wiring**: `packages/commons` added to root bun workspaces + `commons:*` scripts. No Cloudflare Pages deploy job. Ships via EAS only.
- **A0 prereqs:** Commons' `oxy_dk_…` `ApplicationCredential` (clientId) is registered in production → `packages/commons/constants/oxy.ts` (overridable via `EXPO_PUBLIC_OXY_CLIENT_ID`), minted/reconciled idempotently by `bun run register:commons-clients` (`packages/api/scripts/register-commons-clients.ts`), which also UNIONs the staff-only `identity:approval` capability onto Commons' `Application` record — the deploy step that makes its installs eligible push-delivery targets for `POST /auth/session/deliver/:authorizeCode` (issue #691 Phase 4). **Still pending:** a real EAS project ID (`packages/commons/app.config.js` `projectId` is still empty).

**On-device testing safety (CRITICAL) — the hazard is UID-scoped, not Commons-package-scoped:** AndroidKeyStore aliases, which `expo-secure-store` wraps, belong to the shared Linux UID (`android:sharedUserId="so.oxy.shared"`), not to any individual package. EVERY package that declares that `sharedUserId` — Commons, Mention, Accounts, Allo, Homiio, and any dev/debug variant that still declares it — sits inside the SAME UID as a real Commons identity, so installing or updating ANY of them in place can orphan and destroy that identity's keys, not just an install of Commons itself. Critically, Android does NOT refuse a same-signer install of a *different* package into that UID: a debug build signed with the shared release keystore (e.g. a `.dev` variant sharing Commons' signer) installs cleanly as a new member of the UID, exactly as if Commons itself had been reinstalled. Mechanism: on next launch after any in-place install/update inside the UID, `expo-secure-store` can detect a "no corresponding KeyStore key" condition on the identity's alias and DELETE the now-undecryptable entry — BOTH the primary identity AND the on-device backup (same keystore master key) — dropping the user into create-identity onboarding. Commons is self-custody: there is NO server-side copy of the private key, so recovery is possible ONLY via the user's written 12-word recovery phrase (`RecoveryPhraseService.restoreFromPhrase`). Without it, the identity and account are permanently unrecoverable. Uninstalling the LAST package of a UID clears that UID's keystore entirely — so never `adb uninstall` anything sharing `so.oxy.shared` on a device with a live identity either.

**Safe pattern for device testing:** build a clean-room variant with a fresh `applicationId`/package name and `android:sharedUserId` REMOVED, so Android assigns it its own UID that can neither update nor share a keystore with anything already installed. Trade-off: it cold-boots with no shared session, so any test that needs a signed-in account has to sign in manually inside that variant.

**Verification recipe (get the field name right — this is the part that bites):** after installing, run `adb shell dumpsys package <id>` and read the **`appId=`** field — an isolated package shows its own numeric appId (e.g. `appId=10226`) distinct from the shared UID's appId (e.g. `10533` for `so.oxy.shared`). The field is `appId=`, NOT `userId=` — grepping the dumpsys output for `userId` returns zero lines even against a CORRECTLY isolated package, which is indistinguishable from a mistyped command, so don't rely on it. Also grep for `sharedUser` in the same output (expect zero hits for an isolated package), and diff `so.oxy.commons`'s own `lastUpdateTime` (`adb shell dumpsys package so.oxy.commons`) before and after as proof the real identity's package was never touched.

Rule: test identity/SSO flows on the EMULATOR, or on a physical device holding only a disposable test identity you can recreate. Ship real Commons updates to real devices ONLY through the store / EAS update channel (which handles keystore/data migration correctly) — never a developer `adb install -r` / `expo run:android` of ANY package sharing the UID. Treat any device holding a real identity as untouchable; see also "Android release signing — shared keychain" in `~/Oxy/AGENTS.md`.

## Commons Civic Identity Layer — Oxy ID (Fases 0–4)

**Concept:** Commons by Oxy (`packages/commons`, native-only) is the user-facing UI for their **"Oxy ID"** — a self-sovereign civic identity built on DID + cryptographic keys + verifiable reputation + credentials + proof-of-personhood. The civic ENGINE lives server-side in `packages/api/src/services/civic/` + `packages/api/src/routes/civic.ts`. Ownership is proven by CRYPTO (per-subject hash-chained signed records), not by Oxy granting it. There is **zero "DNI"** terminology anywhere — the canonical name is "Oxy ID".

**Civic contracts:** `packages/contracts/src/civic.ts` — Zod schemas + inferred types for all civic surfaces. Consumed as `workspace:*` by api/core/services. **NOT published to npm.** Do not bump `@oxyhq/contracts` version for civic-only additions until Fases 0–4 are deployed and stable.

### Fase 0 — Signed Records v2 (hash chain)

- **Envelope v2** (`version:2, seq, prev, collection, rkey`): adds sequential ledger semantics on top of the v1 signing envelope. `seq` = monotone counter per `(subject, collection)`; `prev` = SHA-256 of the previous envelope JSON (or null for the first). Forms a per-subject, per-collection hash chain.
- **`RepoHead`** model (collection `repoheads`): one document per `(subject, collection)`, stores `seq + envelopeHash` — O(1) head lookup without scanning the chain.
- **`SignedRecord.nsid`** — the column name for `collection` is `nsid` (Namespaced Identifier, e.g. `app.oxy.card`, `app.oxy.credential`). Use `nsid` in queries; `collection` is the schema/SDK alias.
- **`signedRecordSigningInput` / `canonicalize`** from `packages/core/src/crypto/canonicalJson.ts` — signing input is `canonicalize(envelopeWithoutSignature)`. Used identically by client and server.
- **`verifyEnvelope` branching** in `packages/api/src/services/signedRecord.service.ts`: issuer === subject → self-signed (verify against subject's current VM); issuer === `OXY_DID` → custodial (verify via `verifySecret`-gated Oxy key); else → untrusted, reject.

### Fase 1 — Oxy Trust Civic Engine (reputation via attestations)

Reputation awards are NEVER self-issued. The flow: users generate signed attestation payloads client-side → civic service evaluates quorum/rules → calls `reputationService.award(...)` in-process with `emitAttestation:true` → awards are appended to the ledger as Oxy-signed `reputation_attestation` records.

**Award weights (civic categories):**
| Action | Points | Category |
|--------|--------|----------|
| `real_life_attested` | +25 | `physical` |
| `peer_validated` | +8 | `trust` |
| `validation_correct` | +3 | `trust` |
| `validation_incorrect` | -10 | `trust` |
| `personhood_vouched` | +5 | `trust` |
| `vouch_slashed` | -20 | `penalty` |

**Trust tiers** (same as base reputation): new → trusted (≥100) → high_trust (≥500) → verified (`User.verified`) → restricted (total<0 or abuseScore≥0.5).

### Fase 2 — Anti-gaming (real-life QR attestation + validator jury)

**Real-life QR attestation:** B opens Commons and scans A's `oxycommons://attest?subject=…&ctx=…&nonce=…&exp=…` QR. Commons shows A's public card, biometric-gates B's approval, then B signs an attestation on-device and POSTs to `POST /civic/attest`. Server verifies both signatures, checks exclusion rules, and awards `real_life_attested`.

**Validator jury:** contested or fresh attestations queue for random jury review. Selection: weighted-reservoir algorithm with `rngSeed` stored in the `ValidationRequest` document for audit. Graph/device/IP exclusion via `packages/api/src/services/civic/graphExclusion.ts` (rejects validators who share a device fingerprint, IP range, or have previously interacted with the subject). Affinity throttle prevents any pair from repeatedly validating each other. Quorum tally → `peer_validated` award; reversal of a prior vote → `vouch_slashed` penalty.

**Key files:**
- `packages/api/src/services/civic/graphExclusion.ts` — exclusion predicate
- `packages/api/src/services/civic/jury.service.ts` — weighted-reservoir selection, quorum, slash
- `packages/api/src/routes/civic.ts` — all civic endpoints (`/civic/*`)

### Real-Life Attestation transport — QR only

- The ONLY transport is the attest QR: `buildAttestQrPayload` → `oxycommons://attest?subject=…&ctx=…&nonce=…&exp=…` (raw query keys, there is NO `payload=` wrapper). A shows it, B scans it — in-app via `(scan)/index.tsx`, or from the system camera, which deep-links straight into `(scan)/attest`.
- **NFC/HCE was removed (2026-07-22).** It carried byte-for-byte the same payload, could only ever emit on Android (Apple gives no HCE to third-party apps), and forced a patch of the abandoned `react-native-hce` (dead `jcenter()` repos vs Gradle 9). Do NOT reintroduce it without owning the native module — `react-native-hce` is not an option. Design: `docs/superpowers/specs/2026-07-21-remove-nfc-hce-design.md`.
- Card feedback: the `attestGlow` SharedValue is threaded through `TiltContext` into the Skia canvas, driven by the `civic:attested` socket event to room `user:<subjectUserId>` emitted by `POST /civic/attestations` (payload `{byUserId, recordId, points, at, subjectUserId}` — clients drop malformed payloads whole and scope the effect to the active identity).
- Deploy-order rule: the api must deploy before a Commons build that requires new `civic:attested` payload fields ships (old api + new client = events dropped by the strict whitelist).

### Fase 3 — Proof of Personhood

**Mechanism:** multi-signal web-of-trust combining signed personhood vouches + real-life attestations + biometric confirmation.

**`utils/personhoodDerive.ts`:** evidence scoring formula — `evidence = 0.50 × vouches + 0.35 × realLife + 0.15 × biometric`; threshold θ = 0.60; if evidence ≥ θ, sets `User.verified = true` → reputation tier becomes `verified`.

**Vouch staking:** `POST /civic/vouch` — voucher signs a `personhood_vouch` record on-device; stake is burned if the vouch is later reversed (sets `vouch_slashed` penalty). `POST /civic/vouch/withdraw` — explicit withdrawal before system reversal avoids the slash penalty.

**Sybil clustering:** `packages/api/src/services/sybil.service.ts` — graph clustering on shared device fingerprints, IP ranges, and attestation patterns. Flagged clusters receive reduced evidence weight.

**Random audits:** reuse the Fase 2 jury mechanism on a random sample of verified users. Audit failure triggers `vouch_slashed` cascade on all vouches that user issued.

**`User.isSeedVerifier`:** bootstrap field on the `User` model. Set manually for the first batch of trusted users to seed the web-of-trust (required before personhood flows can propagate). Pending: populate seed verifiers in production.

### Fase 4 — Verifiable Credentials

**Collection NSID:** `app.oxy.credential`. One signed record per credential; `rkey` = credential UUID (unique per holder DID).

**Issuers:**
- **User-issued (self-signed):** `issuer === subject`. For personal attestations, claims about oneself.
- **Org-issued:** `issuer` = an Application's DID (Oxy key signing on behalf of the Application). Requires Application to be `type:'internal'` or `isOfficial`.

**`verifyCredential` checks (order):**
1. Parse and verify the outer signed envelope against the issuer DID's CURRENT active verification method (rejects if key was rotated/unlinked since issuance).
2. Check `credential.status` — rejects if `revoked`.
3. Check `credential.expiresAt` — rejects if past.
4. Returns parsed credential claims on success.

**Routes:** `packages/api/src/routes/civic.ts` at `/civic/credentials/` — `POST /issue`, `GET /list/:holderDid`, `GET /my`, `POST /verify`, `DELETE /revoke/:rkey`.

### Commons Nav (Oxy ID UI)

`packages/commons` tab structure — 3 NativeTabs:

| Tab | Route group | Content |
|-----|-------------|---------|
| ID (default) | `(id)` | Oxy ID card + DID + verifications + domain badges |
| Reputation | `(reputation)` | Standing hero + Skia composition donut + civic-duty CTA + signed activity ledger |
| Settings | `(settings)` | Trust & verification → Proof of personhood → Credentials |

- Active tab tint = `colors.text`; indicator/ripple = `primarySubtle`; background = `card`.
- **Scan FAB:** Bloom `Fab` on the ID landing screen opens `app/(scan)/` as a `fullScreenModal` — handles both `oxycommons://attest` (real-life attestation) and `oxycommons://approve` (sign-in handoff).
- **Reputation screen:** `components/reputation/*` — standing hero, Skia composition donut (shows breakdown arc per category), civic-duty CTA (prompts next action to grow standing), signed activity ledger (reads `GET /reputation/:userId/transactions` + `GET /civic/attest/history`).
- **QR schemes:** ALL use `oxycommons://` — `oxycommons://card` (share identity card), `oxycommons://attest?subject=…&ctx=…&nonce=…&exp=…` (real-life attestation), `oxycommons://approve?v=1&code=<authorizeCode>&...` (sign-in handoff). `oxydni://` scheme is removed entirely.



Threat model: state-actor harassment of users. The platform must **never persist a user IP address** — raw, hashed, or geo-derived (country included, e.g. `cf-ipcountry`) — in the database, logs (pino fields), metrics metadata, or response DTOs. Salted hashes of the IPv4 space are brute-forceable by anyone with server access, so hashing is NOT an acceptable at-rest form.

- Removed entirely: `SecurityActivity.ipAddress`, `Session.deviceInfo.{ipAddress,location}`, `ApiKeyUsage.ipAddress`, the IP input to `deriveStableDeviceId`, IP-based anomaly detection (`detectRapidIPChanges`), and the civic `shared_ip` anti-sybil signal (`graphExclusion.ts` — device-fingerprint/interaction-history/affinity-throttle only now).
- **Anonymous rate-limit keys are the one place IPs may be touched, and only transiently:** they MUST go through `hashedIpKey` (`packages/api/src/utils/ipKey.ts` — HMAC(`DEVICE_ID_SALT`), IPv6 /56-bucketed) and live only as a Redis key with the limiter's normal TTL. Never key a limiter on raw `req.ip`.
- **The gate:** `scripts/check-no-raw-ip-keys.mjs` (CI job `Raw Client IP Guard`) censuses every `packages/*/src` with the TypeScript parser — not a regex, because most textual `req.ip` hits on this tree are comments — and refuses any read of `ip`/`ips`/`remoteAddress` or a forwarded-client-IP header that is not on its allow-list, and any such read inside a `rateLimit`/`slowDown` options object at all. Its allow-list is exact in both directions and names the residue. It is also what found the last raw key outside oxy-api — `packages/protocol/src/node/rateLimit.ts`, which keyed its in-process window map on a bare `req.ip ?? 'unknown'`; that is now hashed (below), so no live gap remains.
- **A limiter keyed on a principal must be mounted AFTER the middleware that resolves one, and must `skip` when it cannot.** `/store` writes shipped with `keyGenerator: (req) => req.user?._id?.toString() ?? req.ip ?? 'unknown'` mounted *before* `authMiddleware` on all nine write routes, so `req.user` was undefined every time the key was computed: the `?? req.ip` arm was not a fallback, it was the only branch that ever ran. Every store write minted a Redis key holding a raw client IP, and one office network shared one 20-per-minute budget — the exact outcome the limiter's own comment said keying on the account was there to prevent. An `?? req.ip` behind an unresolved principal is never a fallback; drop the IP arm and `skip` instead (`packages/api/src/routes/store.ts`, covered by `routes/__tests__/storeWriteLimiterKey.test.ts`). The same census found the shape three more times in `packages/api/src/routes/nodes.ts` (`nodeReadLimiter`, `nodeAdminLimiter`, `nodeManagedLimiter`), where the fallback WAS `hashedIpKey` — so no IP leaked and the failure was purely the dead per-user budget, everyone behind one NAT egress sharing one bucket. Fixed identically, and covered by `routes/__tests__/nodeLimiterOrdering.test.ts`.
- **"In memory" is not an exemption to the invariant.** `packages/protocol/src/node/rateLimit.ts` (the self-hosted / managed node's own limiter, in the PUBLISHED `@oxyhq/protocol`) keyed its in-process window `Map` on a raw `req.ip ?? 'unknown'` — never Redis, never disk, the mildest form of the problem and still the form. It now keys on `clientRateLimitKey`, an HMAC under a 256-bit salt drawn from `randomBytes` at module load and held only in memory. The salt is deliberately EPHEMERAL: a rate-limit window is short-lived and process-local, so nothing needs a key that survives a restart or means anything on another node — which makes a per-process salt both sufficient and better than a configured one (nothing to distribute, nothing to rotate, nothing to leak, and the mapping dies with the process). A node operator supplies no salt and cannot. Note the reach: `@oxyhq/protocol` is published, so this lands for consumers only on its next publish.
- **The one sanctioned exception:** inbound-email `Received:` headers (third-party SMTP sender IPs, not Oxy users) stored in `Message.headers` — standard email practice, owner-approved.
- Do NOT re-add IP capture "for security" (audit trails, anomaly detection, sybil resistance, etc.) — this was a deliberate trade-off, not an oversight. Design + rollout: `docs/superpowers/specs/2026-07-14-no-ip-storage-design.md`.

