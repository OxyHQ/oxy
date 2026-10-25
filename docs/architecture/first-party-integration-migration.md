# First-party integration migration

Decision: [ADR 0049](../adr/0049-first-party-platform-authority.md), 2026-10-23.
This ledger distinguishes source implementation from production evidence. Only
the explicit deployment records below establish a released runtime; source
commits alone do not establish live acceptance.

## Accepted contract

Own products share account access without app-consent/scopes or agent app-level
switches. Own services use attested workload identity, explicit environment and
`authority: first_party`; customer credentials are `external`. Product service
audiences are `oxy-service:<applicationId>`; Kaana's audience is `kaana.ai`.
Correct requester/account/resource, external-grant restrictions, domain rules,
revocation and operation binding remain mandatory.

## Workstreams (updated 2026-10-25)

| Area | Source state | Required acceptance |
|---|---|---|
| Oxy auth, OAuth finalizers, Commons | Foundation `4d8cc12a` deployed; shared SDKs published; human fleet adoption remains | Own sign-in has no scopes/grant/permission screen; external PKCE/isolation/revocation pass |
| Oxy workload environment preflight | Deployed and provisioned; foundation v2 canary passed | Nullable DDL, exact 27-binding CAS and live readback; product fleet cutovers remain |
| Oxy core/contracts service authority | Core 7.0.0 / contracts 6.0.0 published; foundation live canary passed | Workload proof, environment and audience; customer key stays external |
| Oxy API files/inference/agency/introspection | Foundation `4d8cc12a` deployed; service authority and dedicated QA private-file canaries passed; inference execution and remaining product canaries remain | Account/resource isolation without own scope/grant dependencies |
| Oxy Console application settings/credentials | Foundation frontend deployed; public sign-in dialog smoke passed; authenticated settings smoke remains | General does not mutate scopes; workload identity separate from external API products; all service/API-key credentials explicitly scoped |
| Alia own-app levels and tool admission | Stage B/C deployed; SDK 22 published; app transport follow-up `b1b0f981` verified live | No app-level switches; owner/requester/bot and scheduled-task isolation |
| Alia gateway/integrations workload transport | Workload gateway 191 and API 611 verified on `b1b0f981`; operational secret cleanup is not executed | Role-specific workload identity, live channel binding, requester task; no shared-secret identity |
| Kaana inference own-service receiver | Contracts 8.0.1 published; receiver and workload producer deployed; evidence below | Retain requester/account, external scopes, audience and revocation |
| Product receivers and SDK adopters | Clarity reader reconciled and producer canary passed; CrowdSource, Peable, GoWay, Moovo, TNP, Allo, Mention, Syra, Move, Nilo and Mercaria runtime readbacks verified; remaining cutovers are separately gated | Caller→SDK→receiver tests for own and external identities |
| Registry/workload migration and deploy | Exact 27-binding environment preflight and Oxy authority rollout complete; product cutovers pending | Reviewed readback, rollout order, actual task digests and live canaries |

Record tested commits and commands in each implementation PR; update this table
only when that work is verified. SDK packages release through Actions/OIDC before
consumer dependency/lockfile updates. Migrate receivers before producers require
the new service audience, and retire compatibility only after every inventoried
caller is updated. The Oxy authority runtime is deployed and its service canary passed. Remaining product and native consumers still require their own SDK pins, deployments and acceptance;
this checkpoint is not fleet completion.

## Verified rollout update (2026-10-25)

The [sanitized deployment receipt](evidence/first-party-live-20261025.json)
records source commits, exact image digests, task revisions and running counts
from operator readbacks. It contains no bearer credentials or user data.

| Runtime | Verified source | Live revisions / count |
|---|---|---|
| Kaana and publisher | `de3db4741ff648d9de8d28d124634a9b7553652e` | API 150: 2/2; publisher 151: 1/1 |
| Peable | `dea5f1a7f7a08537f839a37e8d3768b9140a72cf` | 120: 1/1; healthy targets |
| CrowdSource | `75b10396787abf6d994682192519d925d4e49e61` | 127: 1/1; healthy targets |
| GoWay | `541158ea968605afcd9a523cf3c1a87fdf633378` | 163: 1/1; healthy targets |
| Moovo | `999b1d1341c854f1032a1e54ecf7527148554c00` | 60: 1/1; healthy targets |
| TNP API / DNS / relay | `be3303312ea4068c18a654c4358dc4362478c026` | 29 / 23 / 15: each 1/1; healthy targets |
| Alia stage A API / integrations | `850b2f96177a1ef07ed635bf1d88307919eec300` | 606: 2/2; 186: 1/1; healthy targets / integration task |
| Homiio API / worker | `c672a3321ee9c874329bd1308681e3988eb5c033` | 274: 2/2; 277: 1/1; old tasks drained |
| Willo | `42a8f738e0b84324eaa2a99af41b58317fc2460e` | 36: 1/1; healthy targets |
| Allo | `7582c9678a99c70cb718eaacd93c543db0a3f4e9` | 181: 2/2; healthy targets |
| Alia stage B API / integrations | `81819a95cd99279d155df2171df02ce3f5654adc` | 608: 2/2; 188: 1/1; verified before producers |
| Alia containing stage C API / integrations | `029702fbd3703bb85d1dd258324b2d058063f293` | 609: 2/2; 189: 1/1; matching ARM64 child digests |
| Mention API / MCP | `0ce0f417e039b96c3490bfb29b4f19ff333b3bd8` | 721: 2/2; 421: 1/1; healthy targets |
| Syra | `7ee33926b95e26792b7f153de7a45c212a7b4fce` | 173: 2/2; healthy targets |
| Move | `0f095e3eb40435be1bfb41186962525961e26a09` | 50: 1/1; healthy targets |
| Nilo | `5ad257adadde9c12018fe2be8cc1aae73105f9e4` | 109: 2/2; healthy targets |
| Mercaria | `c257573475899a400efa96bc6d4bbfe0cf63bac8` | 142: 1/1; healthy targets |

TNP's [targeted infra apply](https://github.com/OxyHQ/oxy-infra/actions/runs/40178370575)
and image-pin reconciliation succeeded. This preserved the existing running
relay; it did not activate a dormant service. GoWay's
[deployment](https://github.com/OxyHQ/GoWay/actions/runs/40177672428) also passed.
Published SDK receipts cover CrowdSource 3.1.0, Peable 0.5.0 and GoWay 0.7.1;
SDK publication alone is not evidence that their consumers have deployed.

Noted's [frontend deploy](https://github.com/OxyHQ/Noted/actions/runs/40180765059)
succeeded for `b7c6c204fa349aa217575ca1e45dab36df785562`. Its HTTP/session and
Socket.IO wire contract with Nilo is unchanged; this deployment does not claim
Nilo's separate workload producer cutover or a signed-in user canary.

Oxy [PR #1951](https://github.com/OxyHQ/oxy/pull/1951) merged as
`f02b43785ed43ed169a6d0fe0971f7cb8d57965a`. Its
[API deployment](https://github.com/OxyHQ/oxy/actions/runs/40068112086),
[frontend deployment](https://github.com/OxyHQ/oxy/actions/runs/40068112085) and
[package release](https://github.com/OxyHQ/oxy/actions/runs/40068112127) succeeded.
Core 7.1.0 is published: explicit streaming replay, the linked socket getter and
restricted private-document mediation are available to consumers. Later core
minors do not change the historical 7.0.0 foundation receipt below.

Clarity's reader reconciliation processed 512,538 evidenced own records with
zero remaining own records; it preserved 6,847 revoked external records and did
not release 38 pending external records. The later Clarity-to-Mercaria
producer receipt below establishes that separate cutover.

Authenticator and OxyOS are now registered active **public** clients in
production, with empty application/client scopes, no secret and zero workload
bindings. Bounded provisioning and repeat idempotence checks passed. Their
redirects are `oxyauthenticator://` and `tauri://localhost`, respectively.
Authenticator [PR #65](https://github.com/OxyHQ/Authenticator/pull/65) merged
as `c7142727142e237639c142281c4cfe2a2663fae0` after CI, adopting the registered
public client and published shared packages. Registration and a merged app
build are not proof of native distribution or a completed device sign-in.

At `2026-10-25T09:24:48.294Z`, the production Console displayed its ordinary
email/username sign-in dialog without scopes/permission text, with zero cookies
and no page errors. No personal account was signed in; this is a public-dialog
smoke, not authenticated Console settings or end-to-end sign-in acceptance.

A newly created, dedicated QA account completed normal signed registration and
session authentication at `2026-10-25T09:51:24.226Z`. Its empty personal Files
collection was readable without an app grant, and its session could read the
inference catalogue (HTTP 200, zero profiles). This establishes catalogue
reachability only: **no generation or inference execution was tested**. No
existing user's data or credentials were used.

A separate private-file canary at `2026-10-25T09:56:00.867Z` uploaded a QA file
without an app grant, matched its exact bytes through the owner's session,
refused anonymous access and deleted the test file. Guarded session revocation
at `2026-10-25T09:53:11.459Z` confirmed the original bearer returned 401 after
closing the other sessions and then the calling session. `logoutAll` alone
preserves the calling session; its SDK comment is corrected in this update.
Those initial receipts did not establish account deletion; the later deletion
receipt below completes that dedicated QA fixture's cleanup.

Alia's live stage-A reader canary at `2026-10-25T09:55:05.558Z` admitted the
exact scope-less workload to a missing synthetic link, while refusing anonymous,
wrong-recipient and forged raw-account requests. This verifies the reader's
authentication boundary, not a real user's linked data or the separate event
receiver required by Nilo.

The dedicated QA account was deleted normally using its own signed key proof at
`2026-10-25T09:58:35.192Z`. Its previous bearer returned 401, and the guarded
helper removed its local identity and session files. The preceding private-file
fixture had already been deleted. This does not claim inference generation,
real-user data access or physical-device acceptance.

Alia's stage-B API and integrations were verified live before Nilo's producer
was released. The event canary at `2026-10-25T10:38:14.605Z` used the Nilo
workload with its actual `noted` catalogue: anonymous and wrong-recipient
requests were refused, while the own workload reached the live catalogue's
invalid-event validation. It performed zero writes. Nilo
[PR #147](https://github.com/OxyHQ/Nilo/pull/147) subsequently deployed revision
109. SDK 22.0.0 is public; installed consumer copies were checked against all
212 files and the integrity of its registry archive.

Both Homiio API and worker satisfied Allo's receiver prerequisite before
[PR #268](https://github.com/OxyHQ/Allo/pull/268). Allo revision 180 and its
[frontend deployment](https://github.com/OxyHQ/Allo/actions/runs/40182305470)
then passed. Alia stage C is included in runtime `029702fb`, which also contains
the Codea/Cowork source changes from [PR #899](https://github.com/OxyHQ/Alia/pull/899).
Local VSIX and Linux AppImage artifacts were built; there is no claim of
Marketplace/Electron distribution, signing, or native desktop sign-in acceptance.
Infrastructure secret-removal source and its reviewed apply are separate from
operational credential cleanup, which has not been executed.

Atlas's [frontend deployment](https://github.com/OxyHQ/Atlas/actions/runs/40185771456)
and Inbox's [frontend deployment, attempt 2](https://github.com/OxyHQ/Inbox/actions/runs/40185828152)
succeeded on their recorded SDK-22 consumer commits. OxyOS's
[shell CI](https://github.com/OxyHQ/OxyOS/actions/runs/40185833072) passed; that
is not an installed ISO or physical-device acceptance. Website's consumer
update still requires queue/deployment acceptance. Alia's separate app/Syra
transport follow-up now has the runtime receipts recorded below.

Mention's readers and Move's producer are verified. Schedio's public DNS smoke
failed and its backend automatically rolled back to revision 17; its new
producer is **not deployed**. The finite v1 bridge retirement remains held on
that unresolved rollout and remaining consumer acceptance. The Oxy Inbox
producer now has its own deployment and canary evidence below. Mercaria
revision 142 and its reader canary
passed at `2026-10-25T11:10:10.567Z`: anonymous and own-workload catalogue reads
succeeded, while wrong-recipient and unproved-account requests were refused.
This satisfied Clarity's receiver prerequisite before the producer rollout
recorded below. These dated observations do **not** mark the fleet migration
complete.

## Latest verified follow-ups (2026-10-25)

| Runtime | Verified source | Live revisions / count |
|---|---|---|
| Alia app transport follow-up | `b1b0f9811f2ff028c25d7d4c90fb81bb9ab31822` | API 611: 2/2; integrations 191: 1/1; healthy and drained |
| Clarity producer | `9903515501271a982c2fba40b7a13af4099406c5` | API 159 and worker 145: each 1/1; healthy and drained |
| Oxy Inbox event producer | `7f2d10dc800948757155a7a085877a0690b1b4a4` | Oxy API 1077: 3/3; exact runtime digest verified |

The Clarity canary at `2026-10-25T11:26:47.532Z` used the deployed Clarity
image and workload identity with the published Mercaria SDK. It reached the
catalogue through the canonical recipient without scopes and performed zero
writes. The Inbox event canary at `2026-10-25T11:23:23.219Z` used the deployed
Oxy image and its actual Inbox catalogue: anonymous and wrong-recipient calls
were refused, while the own workload reached catalogue validation. It also
performed zero writes. These are service-boundary checks, not private user
operations or inference-generation acceptance.

The table above retains earlier rollout stages as dated evidence. Newer
consumer readbacks update Allo to revision 181, Peable to 120, CrowdSource to
127, GoWay to 163 and Willo to 36. Moovo's frontend-only Axios correction did
not deploy a new backend image: its verified backend remains revision 60 on
`999b1d1341c854f1032a1e54ecf7527148554c00`. Homiio's SDK-22/import update
[PR #746](https://github.com/OxyHQ/Homiio/pull/746) merged as `2263ccad`; its
source and passing CI are not a new runtime readback.

### Retired Noted backend identity

Oxy [PR #1987](https://github.com/OxyHQ/oxy/pull/1987), merged as `0a312b9b1`,
expired only the retired Noted workload binding. Read-only verification at
`2026-10-25T11:47:07.102Z` confirmed the exact expiry
`2026-10-25T00:00:00.000Z` and migration 0219's SHA-256:
`72a274e859055594fa5bb2cbfed3e277c26e01d4695a92e77ef036ef51031291`.
The migration ledger matches the committed SQL bytes. Noted's public client
and application remain active; Nilo's active workload and application remain
unchanged. This targeted retirement does not remove the global v1 bridge.

### Remaining acceptance and operational holds

Schedio's DNS/domain decision and rolled-back producer remain unresolved.
Website's consumer change still needs queue/deployment acceptance. The
storefront cookies instruction conflict still requires the owner's decision;
this ledger does not resolve or change that policy. Peable and Moovo socket
follow-ups, the remaining product socket changes, and Syra's follow-up SDK
publication/adoption need their own rollout receipts. Native physical-device
acceptance and desktop/store distribution are not established.

Alia operational credential cleanup has **not** been executed.
[Infrastructure docs PR #399](https://github.com/OxyHQ/oxy-infra/pull/399)
merged as `39eaf793`, but documentation is not a cleanup receipt. The finite
v1 retirement remains on hold; this checkpoint does not declare fleet completion.

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

## Audited caller inventory and explicit exclusions (2026-10-23)

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
ActivityWallpaper at `46a7d8e` uses public Socket.IO `/platform-activity` and
Cloudflare PoP data, with no bearer or Oxy SDK: no credential migration follows
from those reads. Fresh Astro `origin/main` at
`5a6bf7d71c11` has no Alia, `@oxy.so`, `@alia.onl`, or `api.oxy.so` references
in source/manifests; the earlier informational-panel description was stale.
No Oxy API consumer was found in Eufesio. The original OxyOS audit
(`815c65f`) found a legacy manual SSE client and no public registration. The
2026-10-25 readback above supersedes that registry finding; shared Alia SDK
adoption and native runtime acceptance remain separate checks. GWJ explicitly excludes itself
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

## Verified foundation rollout (2026-10-24)

[PR #1942](https://github.com/OxyHQ/oxy/pull/1942) merged as
`4d8cc12a797cbc9477bcfb8f6c2b99bc3a7ecb27`. Merge-queue CI
`40031157732` and image build `40031157558` passed. API deploy
[40032105204](https://github.com/OxyHQ/oxy/actions/runs/40032105204), frontend
deploy `40032105168`, and package release `40032105335` succeeded. Production
readback matched that source and image digest
`sha256:ae78be1220b7584ec65c5097699d6cd2ee26699676fd8512f195e5f869b5309b`.

The registry independently returned these eight published versions:

| Package | Version |
|---|---|
| `@oxy.so/contracts` | `6.0.0` |
| `@oxy.so/core` | `7.0.0` |
| `@oxy.so/services` | `13.0.0` |
| `@oxy.so/protocol` | `1.5.1` |
| `@oxy.so/federation` | `2.12.0` |
| `@oxy.so/mcp` | `1.4.0` |
| `@oxy.so/stickers` | `0.2.2` |
| `@oxy.so/ship` | `1.1.1` |

At `2026-10-24T05:16:43Z`, the ECS canary passed v2 workload minting without
scopes, live identity verification, canonical recipient introspection and
wrong-recipient refusal. It also verified that the central v1 compatibility
projection remains bounded to the finite legacy workload cohort. Evidence is
retained in the root workstream's `authority-canary-logs.json`.

This establishes the shared authority foundation. It does not establish every
product receiver, human interaction, background task, or private-data path in
production. The temporary manual-v1 issuance and finite compatibility projections
(including trusted metadata owner fields) remain until inventoried callers and
readers have moved. Core 7.1's explicit streaming replay, linked socket getter,
and private-document mediation subsequently shipped through PR #1951 as recorded
above; they are not part of this historical 7.0.0 receipt.

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

## Console source verification (2026-10-23)

`packages/console` separates own workload identity from external API products and
credential creation. General saves no scopes; Credentials labels and edits only the
external ceiling, including for official apps. Service and machine credentials
require explicit nonempty scopes, respect current application ceilings, and never
inherit own workload authority. External OAuth client registration and account RBAC
are preserved. Existing deployment tooling owns workload bindings; Console does not
claim a registration has an active binding.

Verification on `feat/first-party-console`: Console Jest 289 tests / 31 suites,
Console typecheck, lint and web export, and root AGENTS validation. Dependencies built locally
in the isolated worktree (contracts → protocol → core → services). No manifest,
version or lockfile changes; no package release or Console deployment performed.
The combined Oxy API/SDK rollout and public sign-in dialog smoke have since
passed. An authenticated Console own-app/external-credential smoke remains. See the Console README and
`credential-authority.test.tsx` for the tested boundary.

## Verified deployment checkpoint: Kaana (2026-10-23)

Parent rollout readback records Kaana PR #220 merged at `68b28c9`, deployment
Actions run `39930461232` and release run `39930897427`, publishing version
`8.0.0`. The live health endpoint reported version 8. Service task definition
revision 147 and publisher revision 148 had three running tasks on image digest
`sha256:599641f55a16e140c54fa18791850b3be9e9b19c729dc029d1ebbcb9283a8940`.
The local evidence artifact is
`/home/nate/Oxy/.scratch/first-party-root/kaana-rollout-20261023.json`.
The subsequent contracts `8.0.1` patch merged through PR #226 at
`a766d6252c90b329915a7016fc34611ad0ef0980`, published in release run
`40026959306`, and rolled out service/publisher task revisions 149/150 with
three tasks on the matching `e41b7e6a…` image. Root artifacts
`kaana-contracts-8.0.1-release.json` and `kaana-contracts-8.0.1-rollout.json`
contain the complete image and registry receipts. This verifies Kaana only;
it does not close the Alia or remaining product migration edges.

## Alia source acceptance checkpoint

Commits `fc0ef827b`, `c8c9fbfe5`, `bd8e64616` remove own service-key fallback,
per-app settings and grant/ceiling readers; bind own catalogue tools and Files
to verified requester/task proof; preserve managed effective accounts separately
from the human requester; and retain the task id through background/nested work.
Channel links store no new user bearer. The controlled legacy conversion validates
original sessions, removes proven/expired legacy bearer data, retries transient
outages and prevents concurrent relink from acquiring another person's root.
Legacy inactive links resume automatically from an ordinary verified account
session, without an internal consent/reconnect screen. Historical app-level data
remains inert pending archival.

Validation: full API 2,693 tests; PostgreSQL 43; focused task/managed-account and
channel-renewal HTTP tests; affected app 85 tests; API/app types and API build.
Those initial tests used locally packed candidate core/contracts; no local
package path was committed. Published pins, the combined gateway/SDK receivers,
and the stage-B/stage-C deployments are now recorded above. The pre-cutover
channel inventory contained zero linked bots or connected channels, so the live
rollout does not establish a populated legacy-channel conversion. Task, bot and
account behavior still requires its operation-specific acceptance evidence.
App-owned Files artifacts/reference reconciliation remain service-domain data;
personal Files access uses the requester facade. The remaining ecosystem rows
above are pending until their own caller→receiver changes and canaries are proven.


## Verified deployment checkpoint: Oxy environment preflight (2026-10-23)

[PR #1937](https://github.com/OxyHQ/oxy/pull/1937) merged as
`be619762b9a074346c701cc8d9527cf73c3720e9`. PR CI `40000148446`, merge-queue CI
`40001383156` and image build `40001383322` passed.
[Deploy run 40002409285](https://github.com/OxyHQ/oxy/actions/runs/40002409285)
succeeded. Live readback found three running API tasks on `oxy-oxy-api:1034`,
all using image digest
`sha256:ce2f52077a88690414646cbf4ef223a9abaa192fbab3da589046e66fed831696`.

The production migration ledger contains the exact immutable `0215` hash
`ba0bb2e1381911bc19c0bd564245150ba6f6ae23573a6fe6af6b0ef8dd1cddac`.
The reviewed inventory dry run reported 27 bindings needing provisioning; the
compare-and-set run provisioned exactly those 27; the independent second read
reported all 27 unchanged. Every report had zero workloads outside the cohort.
The temporary database diagnostic task definition was deregistered afterward.
The detailed operator receipt is
`/home/nate/Oxy/.scratch/first-party-root/oxy-environment-preflight-20261023.json`.

This completes the environment prerequisite for the reader-first API/SDK
release. It does not establish product-receiver adoption, v2 issuer rollout,
removal of legacy bridges, or fleet readiness. Follow the
[reader transition](../runbooks/first-party-reader-transition.md) and retain the
subsequent runtime receipts before marking those stages complete.

A subsequent read-only stage-two check against live API revision `1037` (source
`57748c691`) again reported 27 unchanged bindings, zero workloads outside the
cohort and `requiresInventoryReview: false`. Diagnostic task
`0faaed0fdab84b6ebd2da1ad375f3a99` exited successfully and its temporary task
definition was deregistered. Receipt:
`/home/nate/Oxy/.scratch/first-party-root/oxy-stage-two-environment-readiness-20261023.json`.
The pending authority migrations were regenerated after upstream's immutable
`0216_rendition_dispatch_lanes`: additive authority is `0217`, followed by the
separate task-link foreign-key validation in `0218`.
