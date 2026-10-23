# First-party integration migration

Decision: [ADR 0049](../adr/0049-first-party-platform-authority.md), 2026-10-23.
This is a delivery ledger, not production evidence. No release, deployment,
credential change or live acceptance is implied by source implementation.

## Accepted contract

Own products share account access without app-consent/scopes or agent app-level
switches. Own services use attested workload identity, explicit environment and
`authority: first_party`; customer credentials are `external`. Product service
audiences are `oxy-service:<applicationId>`; Kaana's audience is `kaana.ai`.
Correct requester/account/resource, external-grant restrictions, domain rules,
revocation and operation binding remain mandatory.

## Workstreams

| Area | Source state | Required acceptance |
|---|---|---|
| Oxy auth, OAuth finalizers, Commons | Implemented `0447cdc9d`; verification below, not released | Own sign-in has no scopes/grant/permission screen; external PKCE/isolation/revocation pass |
| Oxy core/contracts service authority | In progress, separate workstream | Workload proof, environment and audience; customer key stays external |
| Oxy API files/inference/agency/introspection | In progress, separate workstream | Account/resource isolation without own scope/grant dependencies |
| Alia own-app levels and tool admission | Audited; implementation pending | No app-level switches; owner/requester/bot and scheduled-task isolation |
| Product receivers and SDK adopters | Audited edges below; implementation pending | Caller→SDK→receiver tests for own and external identities |
| Registry/workload migration and deploy | Pending | Reviewed readback, rollout order, actual task digests and live canaries |

Record tested commits and commands in each implementation PR; update this table
only when that work is verified. SDK packages release through Actions/OIDC before
consumer dependency/lockfile updates. Migrate receivers before producers require
the new service audience, and retire compatibility only after every inventoried
caller is updated. No version bump or production rollout has occurred in this
workstream.

## Audited runtime graph

The following edges were inspected at remote `origin/main` on 2026-10-23.
A runtime code path is not evidence that the feature is enabled in production.

| Caller → receiver | Transport and identity found | Remaining work |
|---|---|---|
| Mention, Clarity, Homiio, Inbox → Alia | Alia SDK; human session, linked client, app assertion | Adopt SDK; test account switching and own agent tools |
| Mention → Clarity Experience | Clarity SDK; public read or linked human session | Preserve resource owner and session-switch protection |
| Mention → Clarity jobs/places/indexing | Clarity SDK + Oxy service token | Workload recipient contract; remove own scope dependencies |
| Alia → Clarity search/read | Clarity SDK + Oxy service token | Same service contract; retain external Clarity API restrictions |
| Mention → Syra rooms/podcasts | Linked client or Syra SDK + viewer session | Test room/podcast actions without app connection |
| Mention → Mercaria catalogue | Mercaria SDK, anonymous public reads | Preserve public response/cache semantics |
| Clarity → Mercaria catalogue | Mercaria SDK + own service token; anonymous public fallback | Workload contract; no private data in public cache |
| Mention → Kaana classification/translation/Jev | Kaana SDK + `kaana.ai` service token | Scope-less own authority; audience, receipts, idempotency |
| Alia → Kaana voice/dictation | Kaana SDK + `kaana.ai` service token | Scope-less own authority; preserve attribution |
| Clarity → Kaana embeddings | Kaana SDK + exact Clarity service identity | Remove exact scope tuple; retain workload identity and environment |
| Alia → Mention/Clarity/Homiio/other own tools | Oxy catalogue + Capability ticket, internal MCP or declared HTTP route | Remove grant/ceiling enablement; retain effective account and operation |
| Alia → Inbox/Oxy Files | Own catalogue tools served by Oxy | Own invoice/mail access; refuse other accounts' resources |
| Alia → Syra shows | Syra SDK + human bearer; one-use ingest ticket for worker | Preserve requester/account and deferred operation; update obsolete scope docs |
| Inbox → Oxy email AI → Kaana | `/email/ai/*`, human session | Remove own scope dependencies, retain per-message ownership |
| Inbox → Clarity favicons | Public URL helper | Preserve public/anti-tracking behavior |
| Nilo → Oxy inference | Client checks application `inference:invoke` before showing AI | Replace scope-based availability with product/runtime availability |
| Syra/Nilo/Clarity/Homiio/Alia → Oxy Files | Shared server/client assets APIs | Remove own app-grants/scopes; preserve file ownership and references |
| Own callers/external merchants → Peable | Shared Oxy service middleware + payments scopes | Distinguish proven own workload from bounded external credentials |

## Remaining audited callers and explicit exclusions

| Caller → receiver | Current seam | Required change / invariant |
|---|---|---|
| Schedio → Mention publishing | Mention SDK after central MCP OAuth registration/PKCE; persisted access/refresh | Replace own connection with workload/person operation context; preserve scheduled publications; Mastodon OAuth stays |
| Move → Mention import/lookup/undo | Fetch + service token + user header; duplicated contract | Product SDK transport, verified requester and idempotent operation |
| Mercaria → CrowdSource | Legacy `@oxy.so/crowdsource` service key | Current CrowdSource SDK own-service helper; no static key |
| Allo/Moovo → CrowdSource | `crowdSourceForOxyService` | Adopt shared own authority; preserve tenant isolation |
| Syra → CrowdSource | PostgreSQL outbox | Preserve durable/retry semantics while adopting service contract |
| Own callers → CrowdSource | Receiver fabricates full scopes/local request context | Shared verifier and explicit principal, preserve tenant |
| Mercaria → Clarity feeds; website → Clarity careers | Clarity SDK/token callback | Workload recipient identity |
| Mercaria → Peable | SDK token provider for payments/billing | Preserve merchant and environment isolation |
| Mercaria ↔ Moovo | Per-request bearer-bearing Oxy clients + linked transport | Shared person/service transport; no fabricated authority |
| Allo ↔ Homiio | Frontend linked client; backend team client + operation capability | Preserve operation and membership, no OAuth connection |
| Nilo → Alia webhook / Oxy events/invitations | Durable outbox with hand-written fetch/401 behavior | Shared SDK transport; preserve outbox and account |
| Noted → Nilo notes | Frontend linked client | Preserve synchronization/revisions |
| GoWay → Oxy Files | Separate outbox/reconciliation clients | Preserve intentionally different retry/timeout policies |
| Moovo internal callers | `SERVICE_SECRET` synthesizes `system/serviceApp`; Telegram secret/user header | Replace fabricated identity with verified caller and actor; update all consumers |
| TNP API/DNS/relay → Oxy | Workload/events | Shared identity; retain separate cryptographic network grants |
| Allo/Syra → Alia | Ask SDK | Adopt SDK and own-account tests |
| Nilo/Atlas/GoWay/Moovo/Schedio/Willo → Alia | ChatSheet SDK | Adopt SDK and own-account tests |
| Noted/CrowdSource Console/website → Alia | Text SDK | Adopt SDK and own-account tests |

Authenticator uses Oxy provider/appData; its separate identity storage is
intentional. Atlas consumes public store APIs and Alia without a backend.
ActivityWallpaper uses public socket/PoP data: no credential migration follows
from those reads. Astro's inspected Alia shell panel is informational, not a
runtime API client. No Oxy API consumer was found in Eufesio. OxyOS runtime
consumption is not established by this audit. GWJ explicitly excludes itself
from the Oxy ecosystem in its own instructions and is excluded from this change.
Examples' Next/Vite/Expo third-party OAuth and website's external Claude MCP
OAuth are intentional external paths and remain scoped. Use remote refs for
stale/diverged checkouts (especially Willo), and preserve Inbox's unrelated edits.

## Acceptance and cutover

- Run each changed package's own tests, types and build; exercise PostgreSQL
  finalizers and external OAuth single-use/transactional failure cases.
- Exercise each changed runtime edge through its product SDK and receiver, not
  only an isolated middleware stub: own scope-less identity succeeds; external
  missing scope, wrong audience, revoked workload and foreign account fail.
- Exercise account change during a request, public-agent requester isolation,
  bot self tools, scheduled work and nested agents.
- Verify human flows across web/native, files and playback, inference streaming,
  email tools, product catalogues and third-party consent/revocation.
- Production acceptance requires live registry/binding readback, deployed image
  digests and successful canaries. Preserve external grants and data throughout;
  do not call the migration complete from merged source or green deploy jobs.

## Read-only deployment census (2026-10-23)

The root workstream inspected 41 running tasks across 28 task definitions,
excluding GWJ. No `OXY_SERVICE_API_KEY`, `OXY_SERVICE_SECRET` or `ALIA_API_KEY`
was present in those task definitions; code fallback removal is still required.
Alia revision 601 contains `SERVICE_SECRET` and `INTEGRATIONS_SECRET`;
integrations revision 182 contains `INTEGRATIONS_SECRET`. Those internal shared
secrets need a coordinated workload producer/receiver cutover. Runtime image
and task-definition evidence is retained in the root workstream's
`runtime-inventory-20261023.json`; no production changes were performed.
The workload readback found 27 bindings without explicit environment, so the
new strict environment contract requires a reviewed migration before cutover.

## Auth source acceptance

The auth workstream verifies PostgreSQL authorization/finalization, grant
revocation, OAuth code exchange and shared-device isolation, operated accounts,
autonomous agents, request lifecycle and authority provenance. It rejects an
external bearer approving a new own sign-in, legacy codes without provenance,
and registry changes that would promote an external request/code. Services,
Commons and web-auth tests cover own sign-in without permission text and
external consent unchanged. Package type checks and the AGENTS budget gate are
required alongside those suites. No generated migration number is a deployment
commitment: regenerate the pending provenance migration on the combined
upstream journal before integration because upstream concurrently added 0210.

Legacy grants with no authority evidence remain visible and revocable; only an
explicitly evidenced own cohort may be archived during migration. Registry
flags alone must never hide an external historical connection.

Auth implementation commit: `0447cdc9d` (provisional migration metadata to be
regenerated during integration). Verified locally:

- API PostgreSQL: OAuth finalizers/grants/token/shared-device/code, 5 suites /134
  tests; autonomous/operated approval/info/authSession, 4 suites /107 tests;
  app identity/device binding/migration guards, 4 suites /74 tests. Additional
  session authorize/claim/status/schema suites passed in the lifecycle run.
- Services: explicit consent + HTTP bearer commit, 2 suites /21 tests; shared
  consent/sign-in surface, 18 tests. `bun run build` passes, including package
  export verification; changed SDK files pass Biome with warnings as errors.
- Commons ApprovalRequest: 21 tests. Web auth: full `bun run test`,149 tests.
- API and web-auth `tsc --noEmit`, `validate:agents-md`, and diff whitespace checks
  pass. API lint retains existing optional-chain/template-literal diagnostics.

Commands use each package's `bun run test`; API uses the local PostgreSQL test
URL and `--runInBand`. These are local checks, not live acceptance.
