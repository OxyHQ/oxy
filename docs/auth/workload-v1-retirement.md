# Workload protocol v1 retirement — draft cutover

Status: source preparation only. This branch must not merge, release or deploy
until the root rollout coordinator records every gate below. The running fleet
still uses the finite compatibility bridge; this document does not claim its
retirement. No binding, credential, secret or database row is changed by this work.

ADR 0049 assigns scope-free authority to verified own workloads. Final retirement
makes all SDK workload token methods emit protocol 2, including maintenance calls
to `serviceToken()` and `serviceTokenFor()`. Explicit customer credentials still
use their external lane. A historical `wl_` token carrying external authority is
refused, not reclassified; current live workload proofs require the provisioned
environment, original application/owner and unrevoked binding.

The draft removes the runtime 27-binding whitelist and compatibility projections
from resource introspection, linked accounts, personal owner metadata, service
revocation events and managed-account session switching. The historical tuple
fixture remains only in rejection tests. Customer keys, external service JWTs
(including the supported `oxy-api` audience), OAuth/MCP grants and live scope
intersections retain their contracts. Product resource and account authorization
still applies to all own calls. Historical workload scope columns remain inert
for an additive rollout; a physical column drop requires a separate reviewed
post-deployment migration and must not remove external application/key scopes.

## Required evidence before activation

- Every current API, worker, publisher, integration process and MCP server has
  a verified running digest which produces protocol 2 and accepts its recipient's
  exact audience. A source merge or npm release alone is insufficient.
- Scheduled tasks, EventBridge targets, manual administrative workflows, rollback
  launch definitions and dormant one-shot jobs cannot launch an old producer.
  Kaana's credential-admin launcher must retain its separately verified image;
  do not create missing credential-control services during this cleanup.
- Move and Schedio are activated only after the Mention receiver; Clarity's
  reader/backfill and Mercaria receiver precede its producer. Legacy queued jobs
  keep their recorded original account/operation and are never promoted by brand.
- The Oxy-hosted Inbox client, catalog registrar and normalized-event outbox
  have migrated to the shared workload provider and exact Alia recipient in
  #1985. Source `7f2d10dc800948757155a7a085877a0690b1b4a4` was verified on API
  revision 1077 with its producer canary. Preserve that evidence and check that
  current and rollback launchers retain the same authority contract; this is no
  longer an outstanding source/deployment prerequisite.
- No owned consumer or operator script still depends on scoped workload issuance,
  raw forwarded owner headers or a v1 introspection serializer. External scoped
  clients are not counted as violations of the own-workload migration.
- Fresh live canaries cover own v2, recipient mismatch, requester/account mismatch,
  binding revocation, external customer scope ceilings and external OAuth/MCP
  revocation. After old producers stop, drain existing tokens for their full
  maximum lifetime before removing the accepting readers. The current shared
  `OXY_SERVICE_TOKEN_MAX_LIFETIME_SECONDS` in
  `packages/core/src/server/serviceTokenLifetime.ts` is **300 seconds**; API mint
  and verifiers use it. Record the deployed version/digest and wait at least
  300 seconds after the last old producer stops (including delayed launches),
  then perform the final readback. Recheck the constant at activation rather
  than relying on historical one-hour comments. An interval with zero observed
  v1 mints alone does not prove this drain: identify the last possible old
  producer, including scheduled/manual/rollback launches, and establish the
  deployed token lifetime ceiling before starting the clock.
- The changed Core emitter requires a version bump, CI and normal registry release
  at activation; the draft deliberately does not publish or bump a package now.
- Root records the complete fleet and launcher inventory plus final authorization
  to retire the bridge. Until then, keep this PR draft and production unchanged.

### Current holds and completed prerequisites (2026-10-25)

The [migration ledger](../architecture/first-party-integration-migration.md)
records the verified product receiver/producer deployments, Inbox rollout,
Noted's exact retired workload binding and completed Alia/commerce secret cleanup.
Those completed operations must not be repeated by this draft. In particular,
Mercaria's cookie-free transition is now deployed and verified: API revision 146
runs source `714f3ec411b9abcaaa465278ad42a4fb75823a2b` from #1159, with
matching image digest, healthy targets and the previous revision drained. Its
storefront, dashboard and POS each completed an actual deployment of that source
(API workflow 40213492751; storefront 40213492875; dashboard 40213492844;
POS 40213492781). Website API revision 70 and its frontend run
`a30d271115fe9afb95e038e46d84e1ba51adff12`. Neither replaces account-specific
acceptance tests or establishes whole-fleet readiness.

Schedio remains on rollback revision 17: public DNS access and ACM validation
are unresolved technical prerequisites for its new producer. The user has
authorized continuing the migration; that authorization does not make the
undeployed producer ready. Keep v1 retirement on hold until Schedio's actual
new runtime, scheduled publisher and recipient canary are verified.

Mercaria's public HTTP/Chromium acceptance passed at
`2026-10-25T16:58:19.383Z`: ordinary requests omit cookies, old cookie-only clients
fail safely, invalid Authorization does not downgrade, and only the finite
referral migration paths permit credentialed CORS. This is public transport
acceptance, not native or real-account acceptance. The final preflight preserved
the zero guest-session/portal-grant/durable guest-checkout population and three
Oxy-owned carts; stateless historical referral evidence retains its bounded
transition. Post-deployment flags remain absent/default-false, with no flag secret
references. Preserve the consolidated receipt
`/home/nate/Oxy/.scratch/first-party-root/mercaria-cookie-free-rollout-20261025.json`
and its linked runtime, preflight, diagnostic-cleanup and public-acceptance
receipts. Mercaria is no longer a pending migration prerequisite. Its finite
referral bridge is separate from workload v1 and must not be removed by this PR.

The remaining activation gates are Schedio's DNS/ACM and verified producer rollout,
a fresh complete runtime/binding/launcher inventory and live authorization checks,
the full deployed old-token lifetime drain (currently at least 300 seconds after
the last possible old producer stops), and CI/artifact compatibility for the final
Core minor release. Global v1 retirement remains on hold; no global drain or
activation is claimed here.

## Operator scripts

Safety provisioning and Jev readback use explicit workload environments and live
identity, not workload or application scopes. Safety domain capabilities retain
their existing review policy; external credential ceilings remain unchanged.
`seedOxyApplicationScopes` still guards external credential expansion and no longer
computes own workload authority from those ceilings.

The completed 27-binding environment backfill command refuses before opening a
connection. Explicit binding administration remains available. The I05 pilot no
longer prepares/applies scoped workload configuration, mints a registrar key,
registers via that key or restores obsolete scopes on rollback. Its compiled
executor and ECS launcher admit only `retire`: revocation of the exact historical
registrar credentials identified by the validated original receipt, nonce,
application, owner, environment and scope. Cleanup keeps the existing audit rows,
rejects ownership drift and remains idempotent after receipt expiry. Historical
scope fields survive only in this receipt validator and test fixtures; they do
not read or grant runtime workload authority.

The historical Noted issuer-canary launcher also refuses before AWS access or
secret injection. The external-credential probe remains available for explicitly
authorized external test credentials; it cannot reuse Noted's retired own keys.

## Validation

Rebased without conflicts onto main `df3876fe8` on 2026-10-25, preserving the
upstream streaming file-close fixture from #1990 and the verified rollout ledger
from #1988/#1989. The changed-composition checks passed: 45 Core tests in six
suites (including the real HTTP 401 cache regression and streaming close/abort
tests), 74 API tests in five PostgreSQL/HTTP suites, the API/dependency build,
script typechecking, AGENTS validation and strict Core lint. Regenerating OpenAPI
produced no diff. The Core production files and package manifest are byte-identical
to the prior retirement checkpoint, so its public API audit remains applicable;
there is no version bump or publication. Evidence is in
`/home/nate/Oxy/.scratch/first-party-core-tmp/retirement-rebase-df387/`.

Root repeated the full Core suite on retirement head
`cb18f9ccb5c5f9072065a707613824db20ee7404`: **227 suites / 2,754 tests passed**
in 40.055 seconds. The log is
`/home/nate/Oxy/.scratch/first-party-root/retirement-cb18-full-core.log`.
The Mercaria completion update changes documentation only; it does not invalidate
those byte-identical Core results or repeat deployment operations.

CI run 40206743109 on `cb18` exposed one test-discovery error in API shard 1:
the historical cohort data lived under `__tests__`, so Jest treated it as an empty
suite. The 173 real suites in that shard passed (2,531 tests); the other three
API shards passed. The fixture now lives under the existing `__fixtures__`
convention and its four test imports were updated, without changing Jest's test
pattern or production code. Local reproduction confirmed the original failure;
complete discovery now excludes only that data file and preserves all 763 real
suites. All four consuming PostgreSQL/HTTP suites pass (49 tests). The next CI
run remains required; these focused checks do not assert a new full API CI pass.
Evidence: `/home/nate/Oxy/.scratch/first-party-core-tmp/retirement-fixture-ci/`.

The previous checkpoint on main `0a312b9b1` (including the Inbox producer in
#1985 and the Noted binding retirement in #1987) passed the following local
verification. These are historical results, not a repeat on the later rebase:

- Core: the full 227-suite run passed all 2,754 tests, including the 30 focused
  retirement tests for v2 token helpers, cache/audience boundaries, stale live
  projections and explicit external credentials.
- API: 286 tests in 19 suites against an isolated local PostgreSQL 17 database,
  including scope-bounded external services, raw keys, OAuth, managed sessions,
  requester proofs, revocation, historical token refusal and operator cleanup.
- The API and its eight build dependencies compile; script typechecking, generated
  OpenAPI, AGENTS validation and strict Core Biome checks pass. Existing unrelated
  API lint warnings remain unchanged in the touched legacy files.
- Thirteen offline ECS launcher tests pass. The actual emitted Node executor rejects
  both obsolete provisioning and rollback before configuring a database.

The registry Core 7.3.0 tarball was independently checked against its published
SHA-512 integrity. Comparing every declaration file found only a renamed private
OxyServer method and removal of the two internal legacy-helper declarations;
public export maps, signatures and types remain unchanged. The rebased Core
artifact also builds and packs locally without changing its version or publishing.

These checks establish source behavior, not fleet readiness. Full API CI and
representative consumer compositions against the final versioned release artifact
remain required before activation.
No production cleanup, binding revocation or database backfill has run here.

## Core release version and consumer compatibility

Prepare a **7.x minor release** when the retirement gates are satisfied
(`7.4.0` if that is still the next available version), rather than publishing
these changes under the existing `7.3.0` version or unconditionally choosing 8.
The public signatures of `serviceToken`, `serviceTokenFor`, `createServiceClient`
and the credential/principal types are unchanged. The removed
`requestLegacyWorkloadServiceToken` helper is internal and was not exported by
the package entry point; the public `requestWorkloadServiceToken` already emits
v2 in Core 7.3. The observable own-workload change is ending the explicitly
finite v1 bridge, after all producers and launchers have migrated and the token
drain has passed. External credentials, OAuth and supported external `oxy-api`
audiences retain their existing contracts.

This version choice keeps published product peers such as `>=7.1.0 <8`
compatible. Before the release, compare the actual packed public exports/types
against the then-current registry package and run representative product SDK
compositions with that artifact, including session, workload, external-key and
external OAuth regressions. If that review reveals a public API removal or a
supported external behavior change, stop the minor release and prepare the
necessary major-version consumer migration first; do not silently override or
widen consumers' peer ranges. Normal CI, version/lock updates and the registry
release remain required. This draft does not bump, publish or activate Core.
