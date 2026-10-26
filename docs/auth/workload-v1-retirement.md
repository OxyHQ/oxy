# Workload protocol v1 retirement — verified cutover

Status: [PR #1984](https://github.com/OxyHQ/oxy/pull/1984) merged as
`dc1c21186dab603c6e2ec216e61f7c45d7f37537` at `2026-10-25T20:01:29Z`,
after normal queue CI, image and reviewed activation gates passed. Core 7.4.0
is published and integrity/provenance verified. Accounts, Auth and
Console deployed the same source successfully. API revision 1080 and asset worker
545 are verified on the exact image, with prior tasks drained; live authority
canaries passed. The parked Schedio role was again refused by the new API.
The bounded parking and token drain below are complete. Historical
validation checkpoints remain dated evidence, not instructions to repeat them.

ADR 0049 assigns scope-free authority to verified own workloads. Final retirement
makes all SDK workload token methods emit protocol 2, including maintenance calls
to `serviceToken()` and `serviceTokenFor()`. Explicit customer credentials still
use their external lane. A historical `wl_` token carrying external authority is
refused, not reclassified; current live workload proofs require the provisioned
environment, original application/owner and unrevoked binding.

The merged change removes the runtime 27-binding whitelist and compatibility
projections
from resource introspection, linked accounts, personal owner metadata, service
revocation events and managed-account session switching. The historical tuple
fixture remains only in rejection tests. Customer keys, external service JWTs
(including the supported `oxy-api` audience), OAuth/MCP grants and live scope
intersections retain their contracts. Product resource and account authorization
still applies to all own calls. The [two-release schema cleanup](workload-schema-cleanup.md)
subsequently removed the historical `application_workload_identities.scopes`
column/check on 2026-10-26, after deploying the compatible rollback writer.
API 1084 and asset worker 549 run the verified removal image; pre/post binding
and attribution hashes are unchanged. The retirement image cited above remains
historical evidence, not a supported post-DROP provisioning rollback target.
External `applications.scopes` and `application_credentials.scopes` remain
active and must not be removed.

## Activation requirements and recorded disposition

- Every current API, worker, publisher, integration process and MCP server has
  a verified running digest which produces protocol 2 and accepts its recipient's
  exact audience. A source merge or npm release alone is insufficient.
- Supported scheduled, manual and rollback paths must resolve reviewed migrated
  producers; old dormant producers must lack usable workload authority. Historical
  definitions and images remain preserved, and arbitrary administrative launches
  of unsupported old code are outside this supported procedure.
  Kaana's credential-admin launcher must retain its separately verified image;
  do not create missing credential-control services during this cleanup.
- Enabled products retain their verified receiver-before-producer rollout. Move
  follows the Mention receiver; Clarity's reader/backfill and Mercaria receiver
  precede their producers. Schedio is explicitly deferred before launch, as
  described below; neither its DNS nor its launch is a prerequisite for this
  retirement. Its old issuer must nevertheless be verifiably parked. Legacy
  queued jobs keep their recorded original account/operation and are never
  promoted by brand.
- The Oxy-hosted Inbox client, catalog registrar and normalized-event outbox
  have migrated to the shared workload provider and exact Alia recipient in
  #1985. Source `7f2d10dc800948757155a7a085877a0690b1b4a4` was verified on API
  revision 1077 with its producer canary. Preserve that evidence and check that
  current and rollback launchers retain the same authority contract; this is no
  longer an outstanding source/deployment prerequisite.
- No owned consumer or operator script still depends on scoped workload issuance,
  raw forwarded owner headers or a v1 introspection serializer. External scoped
  clients are not counted as violations of the own-workload migration.
- Final live canaries cover scope-free own v2, canonical introspection, recipient
  mismatch, refused v1 issuance, invalid bearers and the parked Schedio binding.
  Requester/account isolation, external customer scope ceilings and external
  OAuth/MCP revocation are covered by the exact-source signed-HTTP/PostgreSQL
  regressions and earlier dated product probes. Those evidence types remain
  distinct; the final canary did not exercise a real external customer credential.
- After old producers stop, drain existing tokens for their full
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
- Core 7.4.0 passed the packed public API and consumer checks below. Its version
  change merged through normal CI; registry and production evidence are recorded
  separately from the source merge.
- The rollout coordinator approved the final inventory, parking and drain gates
  before promotion. Do not repeat completed parking or binding mutations.

### Completed parking and release verification (2026-10-25)

The [migration ledger](../architecture/first-party-integration-migration.md)
records the verified product receiver/producer deployments, Inbox rollout,
Noted's exact retired workload binding and completed Alia/commerce secret cleanup.
Those completed operations must not be repeated. In particular,
Mercaria's cookie-free transition is now deployed and verified: API revision 146
runs source `714f3ec411b9abcaaa465278ad42a4fb75823a2b` from #1159, with
matching image digest, healthy targets and the previous revision drained. Its
storefront, dashboard and POS each completed an actual deployment of that source
(API workflow 40213492751; storefront 40213492875; dashboard 40213492844;
POS 40213492781). Website API revision 70 and its frontend run
`a30d271115fe9afb95e038e46d84e1ba51adff12`. Neither replaces account-specific
acceptance tests or establishes whole-fleet readiness.

The owner deferred Schedio before launch. Its deployment workflows are disabled,
and the service is parked at desired/running/pending `0/0/0`. The last old process
stopped at `19:36:26.289Z`. An exact-tuple CAS committed at `19:38:09.468Z`,
changing only that workload binding's expiry; application, public client, role,
customer credentials and product data were preserved. A real signed mint under
the Schedio role returned `403 unbound_workload` at `19:39:15.618Z`. Diagnostic
tasks stopped and their definitions became inactive before the conservative
drain boundary `19:39:52.720361Z`.

The deployed lifetime ceiling was 300 seconds. The final readback after
`19:44:52.720361Z` confirmed 30 stable services, no running Schedio process,
unchanged reviewed image digests, and supported launchers using their reviewed
images or the live service revision. The intervening Mention sitemap task used
exactly the migrated revision 723 and exited successfully. Issuer observations
through `19:50:51.657Z` contained 178 emissions, all protocol 2. These logs support
the actual stop, binding expiry and signed refusal; absence of v1 events alone
would not establish a drain. See the durable
[parking and drain evidence](../architecture/evidence/first-party-prelaunch-parking-20261025.json).

Cloudflare access, DNS/ACM validation and public launch are future Schedio launch
requirements, not blockers for this parked producer. Relaunch must use current
v2 artifacts, reviewed binding administration and the normal receiver canary;
never restore an old v1 launcher or unconditionally clear the expired binding.

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

Parking, current fleet/launcher readback, the full token-lifetime drain and final
artifact compatibility gates are complete. The actual Core publication, exact
API/worker
production rollout and live retirement canaries are also verified.
Real-person Console settings, inference execution, physical native devices and
desktop distribution remain distinct product-acceptance limits; they do not
reopen a completed service-token drain.

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

## Historical validation checkpoints

The following checkpoints record the checks that preceded the approved merge.
References to pending activation describe that checkpoint, not current status.

The final documentation/fixture composition was rebased without conflicts onto
actual main `aba819b17fbf5df181788fef888ead5454966699` after #1993 merged.
Its Mercaria rollout ledger and committed evidence are preserved unchanged.
Compared with tested retirement head `cb18`, the only changes are documentation,
that upstream evidence, the identical cohort fixture's location and its four test
imports. Core and all production runtime files remain byte-identical. Complete
Jest discovery and AGENTS/diff checks were repeated; the 49 consumer tests and full
Core results below remain applicable without duplicating them for a docs-only
upstream rebase. Final branch CI 40215450916 and scaffold smoke 40215450924 both
completed successfully on `e61b56ddc2848293089f504b18f31687862240ba`, including
all four API shards. The later Schedio-deferral edit changes documentation only.
At that checkpoint, versioned release artifacts and fresh production/drain
evidence were still required; the completed cutover is recorded above.

The previous composition rebased without conflicts onto main `df3876fe8` on 2026-10-25, preserving the
upstream streaming file-close fixture from #1990 and the verified rollout ledger
from #1988/#1989. The changed-composition checks passed: 45 Core tests in six
suites (including the real HTTP 401 cache regression and streaming close/abort
tests), 74 API tests in five PostgreSQL/HTTP suites, the API/dependency build,
script typechecking, AGENTS validation and strict Core lint. Regenerating OpenAPI
produced no diff. The Core production files and package manifest are byte-identical
to the prior retirement checkpoint, so its public API audit remains applicable;
no version bump or publication occurred in that checkpoint. Evidence is in
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
suites. All four consuming PostgreSQL/HTTP suites pass (49 tests). The corrected final branch subsequently passed all four API shards in
CI 40215450916; the focused checks alone were not treated as a full CI result.
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

These checks established source behavior, not fleet readiness. At that
checkpoint, full API CI and final-artifact consumer compositions remained
prerequisites, and no production cleanup, binding revocation or backfill had run.
The completed release and runtime verification below supersede those pending gates.

## Core release version and consumer compatibility

The approved release is **7.4.0 minor**. The registry check and packed review
preceded the merge; these changes must not be published under the existing
`7.3.0` version or relabelled as a major without a public compatibility change.
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
release were completed for Core 7.4.0. The actual registry and runtime verification
below establish release completion.

### Release procedure and future audit reference

1. Record the fresh fleet and launcher inventory, including the exact Schedio
   parked issuer disposition. Identify the latest possible v1 issuance time
   across every old producer; wait the deployed maximum lifetime (currently
   300 seconds) after that bound and perform the final readback/canaries. This
   clock cannot start from a source merge or a quiet mint metric alone.
2. Recheck registry availability, then prepare only the Core minor bump,
   changelog and workspace lock metadata. Registry readback on 2026-10-25 found
   latest `@oxy.so/core@7.3.0` with `7.4.0` unallocated. Contracts/public types
   have no new release requirement. Published `@alia.onl/sdk@22.0.1` accepts
   `>=7.1.0 <8`, and `@oxy.so/services@13.6.0` accepts `^7.3.0`; neither needs
   its peer widened. Do not republish unchanged packages just because their
   workspace development dependency resolves to the new Core version.
3. Build Core and its dependencies in order; pack with `bun pm pack`. Inspect
   every CJS/ESM/types export and all dependency sections for unresolved
   workspace/catalog/file/link protocols. Compare the packed public signatures
   and export map against the integrity-verified current registry Core artifact.
   Re-run release/lock checks and the affected final composition's CI.
4. Install the actual packed artifact into isolated representative consumers,
   keeping their published peer ranges: Services/Alia session transport, Alia
   server and Clarity workload factories, Kaana HTTP/streaming credentials, and
   MCP transport. Exercise refresh/replay, requester/account isolation,
   recipient mismatch and explicit external-key/OAuth scope/revocation
   regressions. Do not validate only workspace source aliases or a stale
   previously installed tarball. A supported public/API regression stops the
   minor release rather than prompting casts or peer overrides.
5. Only after the inventory, drain and artifact gates, merge through normal CI
   and release Actions. Verify registry integrity/provenance, exact API runtime
   digest and v1 rejection/own-v2/external compatibility canaries. Existing
   compatible Core 7.x consumers already using the explicit-v2 product factories
   do not need a forced reinstall before that API cutover. Any remaining manual
   workload-token caller must adopt the new minor before it is allowed to launch.

Steps 1–4, the normal merge and registry verification in step 5 are complete.
API/worker production verification and live canaries in step 5 also passed.
This procedure does not authorize starting
Schedio or repeating any binding mutation.

### Prepared Core 7.4.0 artifact validation

The local version bump changes Core's manifest/changelog and generated workspace
lock metadata; production source remains identical to the green `e61b56ddc`
retirement checkpoint. Four dependency/Core builds passed, as did frozen install.
The packed artifact has 46 checked export targets with unchanged export maps and
179 declaration files reviewed against the SHA-512-verified registry Core 7.3.0.
Only documentation, a private method name, non-exported legacy helpers and literal
union ordering differ; normalized public signatures remain identical. All packed
dependency sections have resolved published ranges.

A fresh isolated consumer install verifies every Core file against that tarball,
loads both CJS and ESM entries, and typechecks actual published Services, Alia,
Clarity, Kaana and MCP compositions without casts or peer overrides. Five local
HTTP tests pass using that artifact: workload manual/factory cache refresh,
explicit external credentials, canonical product audiences/requester binding,
Kaana attribution/MCP transport, and Alia session JSON replay/account switching.
Only renderer hooks are stubbed for the pure Alia transport; issuer/receiver
fixtures are synthetic. These tests do not claim React/native or production
acceptance, nor replace the live-grant/OAuth regressions in full branch CI.
Receipts, declaration review, test logs and the tarball are under
`/home/nate/Oxy/.scratch/first-party-core-tmp/retirement-core-7.4/`.

Versioned branch and queue CI, parked-issuer, launcher, fresh binding and
full-lifetime drain receipts passed before merge. Registry publication and exact
production activation are tracked separately at the top of this document.

### Actual registry and frontend verification

At `2026-10-25T20:07:29Z`, the actual public Core 7.4.0 artifact passed SHA-512
integrity and Sigstore verification against source `dc1c21186` and release
[40228796623](https://github.com/OxyHQ/oxy/actions/runs/40228796623). A fresh
registry-only install verified 713 shipped files, 46 export targets and 179
declarations; normalized public signatures remain compatible. CJS/ESM imports,
consumer types and five HTTP composition tests (24 assertions) passed without
peer overrides. The registry artifact differs from the candidate only in one
declaration's literal-union ordering. These are actual published bytes with
synthetic HTTP fixtures, not production or mounted native acceptance.

Frontend deployment [40228796647](https://github.com/OxyHQ/oxy/actions/runs/40228796647)
completed actual Accounts, Auth and Console deployment steps on the same source,
including the Accounts CSP and Auth IdP smoke gates. The sanitized
[evidence](../architecture/evidence/first-party-prelaunch-parking-20261025.json)
records the source receipt hashes and exact verification boundaries.

### Exact production runtime and live authority canary

AWS deployment [40228796566](https://github.com/OxyHQ/oxy/actions/runs/40228796566)
performed the actual rollout. API revision 1080 (3/3) and asset worker 545 (8/8)
run source `dc1c21186` with matching source/runtime image digest
`sha256:698c2ec9df5accb0de8b795116e11b60e187f1ae3bbc1ec4e9b08fe45eeb1766`.
Their previous tasks drained, and the API target groups are healthy.

At `20:14:09.701Z`, the live canary passed scope-free v2 identity (200), canonical
recipient introspection (active), wrong-recipient refusal (401), v1 issuance
refusal (400), and invalid-bearer refusal (401). The diagnostic exited 0; its
definition was inactive with no active family tasks by `20:15:52Z`. No raw token
or customer secret is retained in the committed evidence. The invalid-bearer
negative is not a positive live external-customer key/OAuth exercise: those
compatibility paths retain their dedicated source and real-HTTP regression
coverage, rather than being inferred from this canary.

The post-release Schedio probe at `20:16:47.538Z` used the exact parked workload
role against the new API 1080 and again returned `403 unbound_workload`. Its task
exited 0 and its definition was inactive by `20:17:38Z`. This confirms parking
remained enforced after the runtime change; it does not authorize a future
Schedio launch or change the approved binding expiry.
