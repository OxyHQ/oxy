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
| Oxy auth, OAuth finalizers, Commons | Oxy API 1078 deployed; shared SDKs and registered native public clients adopted; dedicated QA session accepted | Own sign-in has no scopes/grant/permission screen; external PKCE/isolation/revocation pass |
| Oxy workload environment preflight | Deployed and provisioned; foundation v2 canary passed | Nullable DDL, exact 27-binding CAS and live readback; final retirement remains gated |
| Oxy core/contracts service authority | Core 7.3.0 / contracts 6.0.0 published; own authority and producer canaries passed | Workload proof, environment and audience; customer key stays external |
| Oxy API files/inference/agency/introspection | Oxy API 1078 deployed; service authority, Inbox event and QA private-file canaries passed; inference execution remains untested | Account/resource isolation without own scope/grant dependencies |
| Oxy Console application settings/credentials | Foundation frontend deployed; public sign-in dialog smoke passed; authenticated settings smoke remains | General does not mutate scopes; workload identity separate from external API products; all service/API-key credentials explicitly scoped |
| Alia own-app levels and tool admission | Stage B/C and app transport deployed in `596f8a7`; SDK 22.0.1 published | No app-level switches; owner/requester/bot and scheduled-task isolation |
| Alia gateway/integrations workload transport | Workload gateway 192 and API 612 verified on `596f8a7`; 782 old definitions and separate probe retired; exact two obsolete SSM parameters removed; post-cleanup runtime verified | Role-specific workload identity, live channel binding, requester task; no shared-secret identity |
| Kaana inference own-service receiver | Contracts 8.0.1 published; API 151 and publisher 152 verified on `8bba965d` | Retain requester/account, external scopes, audience and revocation |
| Product receivers and SDK adopters | Clarity reader reconciled and producer canary passed; CrowdSource, Peable, GoWay, Moovo, TNP, Allo, Homiio, Website, Mention, Syra, Move, Nilo and Mercaria runtime readbacks verified; remaining cutovers are separately gated | Caller→SDK→receiver tests for own and external identities |
| Mercaria storefront commerce transport | PR #1159 deployed: API 146 and all three frontends verified on `714f3ec4`; public HTTP/Chromium transport acceptance passed | Preserve Oxy-owned carts and independent guest/portal authority; bounded referral preservation only; real-identity/native acceptance not claimed |
| Registry/workload migration and deploy | Environment preflight and recorded product rollouts complete; Schedio launch deferred and prelaunch producer parked; final v1 publication/rollout remains gated; product acceptance is listed separately | Reviewed readback, rollout order, actual task digests and live canaries |

Record tested commits and commands in each implementation PR; update this table
only when that work is verified. SDK packages release through Actions/OIDC before
consumer dependency/lockfile updates. Migrate receivers before producers require
the new service audience, and retire compatibility only after every inventoried
caller is updated. The Oxy authority runtime and the product deployments
recorded below are live.
Unresolved acceptance is listed explicitly under Remaining acceptance and
operational holds; this checkpoint is not fleet completion.

## Verified rollout update (2026-10-25)

The [sanitized deployment receipt](evidence/first-party-live-20261025.json)
records source commits, exact image digests, task revisions and running counts
from operator readbacks; the [follow-up receipt](evidence/first-party-followups-20261025.json)
adds later package, runtime and bounded readiness observations. Neither contains
bearer credentials or user data. The following table shows the latest verified revision for each service; earlier
stages remain as dated history in the narrative and receipt array.

| Runtime | Verified source | Live revisions / count |
|---|---|---|
| Oxy API | `0a312b9b1fb26f26a6dfbb0d0bc8bb9da1c82d3d` | 1078: 3/3; healthy and drained |
| Alia API / integrations | `596f8a7dfecb0c3a80faf3077a7989143745ddbd` | 612: 2/2; 192: 1/1; healthy and drained |
| Kaana API / publisher | `8bba965d4b5aa2bb64b52238442c9559207344ac` | 151: 2/2; 152: 1/1; healthy and drained |
| Clarity API / worker | `9903515501271a982c2fba40b7a13af4099406c5` | 159: 1/1; 145: 1/1; healthy and drained |
| Peable | `3224178c28c5a0c34152aa242a834ab171bf5883` | 122: 1/1; healthy and drained |
| CrowdSource | `75b10396787abf6d994682192519d925d4e49e61` | 127: 1/1; healthy and drained |
| GoWay | `6e80a1edd9c943fa53a4b65de1b4f07b92b648cb` | 164: 1/1; healthy and drained |
| Moovo | `4438de919dcc3968fa2b385650c7d33189a8c129` | 61: 1/1; healthy and drained |
| Homiio API / worker | `2263ccad44e6918354e5643c8fe782008fe66e5d` | 275: 2/2; 278: 1/1; healthy and drained |
| Website API | `a30d271115fe9afb95e038e46d84e1ba51adff12` | 70: 2/2; healthy and drained |
| Mention API / MCP | `7587a6af619fa6c02d6b650bdf0ded8cb9746a07` | 723: 2/2; 423: 1/1; healthy and drained |
| Syra | `41da86f21471a44bcee898c6ab93a25a8dbec496` | 175: 2/2; healthy and drained |
| Move | `a1c041b758c47ff6766beb134b1618a0e4d54fad` | 52: 1/1; healthy and drained |
| Nilo | `a240f145de6844a0a871469e748d743eba8599fa` | 110: 2/2; healthy and drained |
| Mercaria | `714f3ec411b9abcaaa465278ad42a4fb75823a2b` | 146: 1/1; healthy and drained |
| Allo | `7582c9678a99c70cb718eaacd93c543db0a3f4e9` | 181: 2/2; healthy and drained |
| Willo | `42a8f738e0b84324eaa2a99af41b58317fc2460e` | 36: 1/1; healthy and drained |
| TNP API / DNS / relay | `be3303312ea4068c18a654c4358dc4362478c026` | 29 / 23 / 15: each 1/1; healthy targets |

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
operational credential cleanup. The later bounded definition-retirement receipt
below confirms that step and deletion of the exact two obsolete Alia parameters.

Atlas's [frontend deployment](https://github.com/OxyHQ/Atlas/actions/runs/40185771456)
and Inbox's [frontend deployment, attempt 2](https://github.com/OxyHQ/Inbox/actions/runs/40185828152)
succeeded on their recorded SDK-22 consumer commits. OxyOS's
[shell CI](https://github.com/OxyHQ/OxyOS/actions/runs/40185833072) passed; that
is not an installed ISO or physical-device acceptance. Website API 69 and its
frontend are now deployed; its installed-SDK canary is recorded below. Alia's
separate app/Syra transport follow-up also has runtime receipts.

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
| Alia SDK metadata patch | `596f8a7dfecb0c3a80faf3077a7989143745ddbd` | API 612: 2/2; integrations 192: 1/1; healthy and drained |
| Clarity producer | `9903515501271a982c2fba40b7a13af4099406c5` | API 159 and worker 145: each 1/1; healthy and drained |
| Oxy Inbox event producer | `7f2d10dc800948757155a7a085877a0690b1b4a4` | Oxy API 1077: 3/3; exact runtime digest verified |
| Oxy targeted Noted retirement | `0a312b9b1fb26f26a6dfbb0d0bc8bb9da1c82d3d` | Oxy API 1078: 3/3; exact runtime digest verified |

The Clarity canary at `2026-10-25T11:26:47.532Z` used the deployed Clarity
image and workload identity with the published Mercaria SDK. It reached the
catalogue through the canonical recipient without scopes and performed zero
writes. The Inbox event canary at `2026-10-25T11:23:23.219Z` used the deployed
Oxy image and its actual Inbox catalogue: anonymous and wrong-recipient calls
were refused, while the own workload reached catalogue validation. It also
performed zero writes. These are service-boundary checks, not private user
operations or inference-generation acceptance.

The earlier Moovo frontend-only Axios correction kept backend revision 60.
The later socket lifecycle change actually deployed revision 61 on `4438de91`;
all four Moovo web deployments passed. Peable's socket update deployed revision
122 on `3224178c`; GoWay's documentation follow-up also triggered a real rollout
of revision 164 on `6e80a1ed`. Homiio API 275 and worker 278 are both live on
`2263ccad`; its frontend deployment succeeded on attempt 2 after an external
Cloudflare upload failure. These later receipts supersede the earlier runtime
rows without attributing skipped jobs to a new backend image.

Website API 69 and its frontend are deployed on `c8746a7`. At
`2026-10-25T12:13:43.729Z`, the actual Website image and workload role used its
production Oxy client and installed Clarity factory for a filtered careers read.
Own authority had no scopes, the exact Clarity audience passed, and the platform
audience was rejected. It performed zero domain writes. The diagnostic task
stopped with exit 0 and its definition was confirmed `INACTIVE`.

Mention [PR #1627](https://github.com/OxyHQ/Mention/pull/1627) deployed its
frontend on `0ed30746`; backend and MCP deployment jobs were skipped. At that
stage, API 722 and MCP 422 remained on `683adf44`. Syra
[PR #258](https://github.com/OxyHQ/Syra/pull/258) and
[PR #259](https://github.com/OxyHQ/Syra/pull/259) are merged; the published SDK
and consumer follow-up below supersedes their initial publication-pending status. Mercaria backend 144
is verified on `5ef09822`; its separate renderer fix
[PR #1158](https://github.com/OxyHQ/Mercaria/pull/1158) is merged and is not a
new backend runtime receipt.

Alia SDK 22.0.1 is published with verified registry integrity and provenance
for `596f8a7`. It removes only the obsolete Bloom peer upper bound; the
core/services minimums remain. This metadata release does not require a
consumer runtime change from the already compatible SDK 22.0.0.

### Retired Noted backend identity

Oxy [PR #1987](https://github.com/OxyHQ/oxy/pull/1987), merged as `0a312b9b1`,
expired only the retired Noted workload binding. Read-only verification at
`2026-10-25T11:47:07.102Z` confirmed the exact expiry
`2026-10-25T00:00:00.000Z` and migration 0219's SHA-256:
`72a274e859055594fa5bb2cbfed3e277c26e01d4695a92e77ef036ef51031291`.
The migration ledger matches the committed SQL bytes. Noted's public client
and application remain active; Nilo's active workload and application remain
unchanged. The operator verification at `2026-10-25T11:51:09.149102+00:00`
and successful [API deployment](https://github.com/OxyHQ/oxy/actions/runs/40189808422)
record the same source and migration hash. This targeted retirement does not
remove the global v1 bridge.

### Published socket SDK and consumer follow-up (2026-10-25)

Syra SDK **0.24.0** was published by
[release 40192840084](https://github.com/OxyHQ/Syra/actions/runs/40192840084)
from `41da86f21471a44bcee898c6ab93a25a8dbec496`. Registry provenance, archive
integrity and installed Mention JS/declaration bytes matched. The optional peers
require Core `>=7.1.0 <8.0.0` and Services `>=13.0.0 <14.0.0`; the packed
socket entry was also tested against the actual published Core 7.1.0 minimum.
Real Socket.IO tests cover concurrent leases, account changes, late cleanup and
aborting a pending refresh after the last consumer leaves. External credential
connections remain a separate supported path. Syra's
[backend deployment](https://github.com/OxyHQ/Syra/actions/runs/40193313588)
also performed its rollout. Revision 175 was independently verified at
`13:07:04Z`, 2/2 healthy and drained, with the ECR source tag and both running
image digests matching that same `41da86f2` source.

Mention [PR #1628](https://github.com/OxyHQ/Mention/pull/1628) pins that published
artifact. Queue CI `40194448512` passed and merged
`7587a6af619fa6c02d6b650bdf0ded8cb9746a07`. API 723 and MCP 423 are verified
healthy and drained on the exact source image digests. Its
[frontend deployment](https://github.com/OxyHQ/Mention/actions/runs/40195079813)
also succeeded: real-browser gate, Worker promotion, exact production smoke,
unauthenticated shell refusal and public-apex smoke all passed; the deployment
record was written and rollback was skipped. These deployment receipts do not
establish a signed-in production room/player or cross-account operation canary.

Website's API 70 is verified on `a30d271115fe9afb95e038e46d84e1ba51adff12`;
its [frontend deployment](https://github.com/OxyHQ/website/actions/runs/40193616550)
also succeeded. Mercaria's storefront, dashboard and POS deployment steps each
confirmed `Shipped commit 6d077057888cadf68dcb9e6d27eab128a087b73c` in runs
`40195196181`, `40195196168` and `40195196169`. Earlier successful workflows with
skipped deploy jobs did not establish that rollout. Mercaria's
[API deployment](https://github.com/OxyHQ/Mercaria/actions/runs/40195196170)
also succeeded; revision 145 was independently verified at `13:04:03Z`, 1/1
healthy and drained on the matching source/runtime digest. These are historical
receipts for `6d077057`; the later approved cookie-free source change below is
not covered by those deployment receipts.

### Mercaria cookie-free commerce decision and verified rollout (2026-10-25)

The owner approved removal of storefront cookies while preserving carts and
existing access. Mercaria [PR #1159](https://github.com/OxyHQ/Mercaria/pull/1159)
merged as `714f3ec411b9abcaaa465278ad42a4fb75823a2b` at `16:26:15Z`.
**API 146 and all three frontend deployments are verified on this source.** The
[cutover runbook](https://github.com/OxyHQ/Mercaria/blob/714f3ec411b9abcaaa465278ad42a4fb75823a2b/docs/reviews/2026-10-25-cookie-free-commerce.md)
and amended Mercaria ADR 0003 govern that change; the owner's decision is no
longer an unresolved policy gate.

The permanent storefront transport uses Oxy's shared linked client with cookies
omitted. Guest cart credentials (`mgs_`) and order-portal grants (`mgp_`) travel
in explicit headers and remain independent domain credentials, not Oxy identities
or application scopes. Ownership, financial rules, revocation and absolute
expiry remain enforced. Durable persistence and account/domain-response fences
prevent stale responses from restoring cleared credentials or crossing account
contexts. Old clients without header support are refused before issuance or
one-time link consumption; they cannot silently create a replacement cart.

The [sanitized population evidence](https://github.com/OxyHQ/Mercaria/blob/714f3ec411b9abcaaa465278ad42a4fb75823a2b/docs/reviews/evidence/2026-10-25-cookie-free-commerce-population.json)
records read-only snapshots at `15:00:46.286Z` and `15:29:53.639Z`: both found
zero guest sessions and portal grants, with three carts all owned by Oxy
accounts; the second also verified zero guest checkouts and guest-origin orders.
Guest and referral issuance remained disabled in the observed revision 145
configuration. Consequently this implementation
performs no guest/portal backfill or exchange and leaves those carts untouched.
The fresh premerge preflight at `16:09:57.356Z` confirmed the same zero guest
sessions/grants/checkouts/orders and three Oxy-owned carts. It selected only
aggregates; its diagnostic task stopped with exit 0 and its definition became
`INACTIVE`. No guest/portal backfill or cart mutation was needed.

Only historical signed referral cookies have a temporary preservation path:
exact-origin exchange and acknowledgement copy the original signed carrier,
click time and expiry, without minting authority or enabling referrals. A carrier
must have been issued at or before the fixed `2026-10-25T15:00:46Z` cutoff; the bridge ends at
`2027-01-23T15:00:46Z`. Cookie deletion follows durable storage and exact-carrier
acknowledgement. Credentialed CORS is limited to those two endpoints; ordinary
storefront requests remain cookie-free. This finite exception does not change
Oxy's zero-cookie identity contract or authorize global protocol-v1 retirement.

The [sanitized rollout and acceptance receipt](evidence/mercaria-cookie-free-rollout-20261025.json)
records successful main CI `40211664494` and the actual API deployment
`40213492751`. At `16:57:45Z`, revision 146 was healthy and drained, 1/1,
with matching ECR/runtime digest
`sha256:7a009a17bf0da3c40c4bccba07a5479b2fa2f347e2e01b33b0d6a59167c584c1`.
Storefront `40213492875`, dashboard `40213492844` and POS `40213492781` each
completed deployment and logged the exact shipped commit `714f3ec4`.
Post-deploy configuration at `16:57:59Z` confirmed both guest/referral flags
absent from environment and secret references, retaining their false defaults.

Public production HTTP and Chromium checks passed at `16:58:19Z`: anonymous
cart read returned 200, legacy-cookie access 426, invalid Authorization 401,
and empty referral exchange 204. Ordinary cart responses were `no-store`,
with no credentialed CORS or `Set-Cookie`; foreign-origin CORS was refused.
A synthetic browser page exercised those production boundaries; it **did not
execute the deployed storefront bundle**, sign in a real identity, validate
native behavior or prove live guest/portal issuance and durable storage.
These limits do not undo the independently verified frontend deployments.

### Bounded protocol-retirement evidence (2026-10-25)

The follow-up receipt records a read-only census at `12:42:44Z`: 30 stable ECS
services in `us-west-2`/`oxy-cluster`, no obsolete own-auth configuration names
in those live definitions, zero Scheduler entries and six EventBridge rules
without fixed task-definition targets. The two Mention scheduled Lambda handlers
matched the reviewed infra source bytes and resolve the live service definition.
The Kaana credential-admin launcher points to reviewed source `de3db474` and its
verified image index; the index and both child manifests have retention tags.
No launcher was invoked and no infrastructure was created by this audit.

Oxy's asset-variant worker revision 543 was independently verified at `12:43:55Z`,
8/8 on the exact `0a312b9b` source image. The issuer observation from
`12:30:24Z` to `12:45:24Z` contained 232 parsed mints, all protocol 2 with
`first_party` authority. **Zero observed v1 mints does not prove that Schedio,
dormant launchers or rollback images have migrated.** It does not start the drain
clock or authorize retirement. The final process/launcher inventory, reviewed
Core minor release and consumer composition remain required. After the last old
producer stops, wait at least the deployed `OXY_SERVICE_TOKEN_MAX_LIFETIME_SECONDS`
value (currently 300 seconds in `packages/core/src/server/serviceTokenLifetime.ts`)
before removing compatibility. Product acceptance below remains a separate set
of checks; an untested native app or Console screen is not itself evidence of a
protocol-v1 dependency.

### Remaining acceptance and operational holds

The owner deferred Schedio's public launch on 2026-10-25 because the product
has not launched. Cloudflare zone access, DNS and ACM readiness remain future
launch prerequisites, not prerequisites for retiring an **effectively parked**
prelaunch producer. Source hold [PR #72](https://github.com/OxyHQ/Schedio/pull/72)
merged as `5be56680`; its deployment workflows are disabled. Infrastructure
parking [PR #401](https://github.com/OxyHQ/oxy-infra/pull/401) merged as
`c6e80da0`. The old task stopped at `19:36:26.289Z`. The exact binding expiry committed at
`19:38:09.468Z`, followed by a separate read-only database confirmation at
`19:38:09.471726Z`; every field except `expires_at` remained unchanged.
A fresh signed mint using the actual Schedio role was refused at `19:39:15.618Z`
with HTTP 403 `unbound_workload`. All diagnostic tasks stopped successfully and
their definitions are inactive. The post-drain service and task readback at `19:45:27–19:45:29Z` confirmed
Schedio at 0/0/0, 47 running fleet tasks and no standalone diagnostics. The
issuer window ending `19:45:05.578Z` covered more than 300 seconds after the
conservative boundary and contained 84 mints, all v2, with no unparsed events.
This observation supports the concrete stop/expiry/refusal evidence; quiet logs
alone would not establish parking. The `19:47:32Z` comparison also confirmed that every running service container retained the immutable digest already mapped to reviewed source at `19:13Z`; Schedio had no running container. A final task readback at `19:49:43Z` showed 47 running tasks and no standalone tasks. The intervening standalone task was the reviewed Mention sitemap launcher using revision 723 and the exact migrated service image; it exited successfully at `19:47:40Z`. Extending the issuer observation through `19:50:51.657Z` yielded 178 emissions, all protocol 2, with no unparsed events. The named Kaana administrative image and both manifest children remain available with `pinned-*` retention tags; the earlier empty tag list was a report filter, not a retention change.
No public launch or new producer deployment is claimed. The
[sanitized parking receipt](evidence/first-party-prelaunch-parking-20261025.json)
preserves those exact operational boundaries.

The fresh read-only publishing census at `19:33:42.003Z` found zero connections,
posts and deliveries, including no scheduled deliveries. The separate workload
registry census at `19:30:08.685606Z` checked exactly 27 reviewed tuples, found
zero bindings outside that cohort, and confirmed application/owner readiness.
Noted was expired; Schedio remained unexpired. Its read-only diagnostic stopped
with exit 0 and its definition became `INACTIVE` at `19:31:09Z`. Those pre-parking snapshots do not themselves establish the subsequent operation
or start the drain clock. The conservative drain starts at `19:39:52.720361Z`,
after process stop, commit, signed refusal and final diagnostic cleanup. Its
300-second deadline is `19:44:52.720361Z`; the retroactive expiry is not its start.

The bounded enabled-path review at `19:30:27Z` found no backend deployment
in progress, queued or waiting across the 19 reviewed own-product repositories.
Normal deployment rollback selects the current serving definition; the two
Mention scheduled handlers resolve that live definition. Named manual launchers
were reviewed separately. Historical task definitions and ECR images remain
preserved, but deliberately relaunching unsupported old workload producers is
outside the supported retirement procedure. This is not a claim to constrain
all possible administrator actions.

Mercaria's cookie-free decision is
approved, deployed and publicly transport-tested as recorded above; real-identity
and native product acceptance remain outside that probe's scope. Syra 0.24.0
publication and Mention's consumer adoption are recorded above; they do not establish signed-in production
live-room/player acceptance. Native physical-device
acceptance and desktop/store distribution are not established.

Alia's bounded retirement completed with 782 unique old definitions confirmed
`INACTIVE`. The final successful attempt inspected all 782, retired the remaining
182 and verified 600 already inactive. Its complete final snapshot at
`2026-10-25T12:25:32.905Z` found no remaining references within exactly the two
Alia task-definition families. Two earlier attempts stopped safely when AWS
returned an incomplete task snapshot; the reviewed retry then succeeded.
Probe revision 1 is separately `INACTIVE`. Running API 612 and gateway 192 were
preserved. The exact `/oxy/alia/INTEGRATIONS_SECRET` and
`/oxy/alia/SERVICE_SECRET` parameters were deleted; metadata readback at
`2026-10-25T12:27:04.684Z` confirmed both absent, without reading their values.
The fresh safety census inspected 46 active definitions in nine selected Alia
and diagnostic families plus all current runtime references. Subsequent checks
confirmed API 612 and gateway 192 healthy on source `596f8a7`, comparing the
correct ARM64 image child digest. This is not a global historical secret census.
The earlier 52-definition progress snapshot remains dated history in the JSON
evidence.

The separate commerce cleanup retired only obsolete Mercaria task definition 3,
preserving live revision 144 and Terraform's protected revision 128. It then
removed exactly `/oxy/mercaria/SERVICE_SECRET` and
`/oxy/marketplace/SERVICE_SECRET`; metadata readback at
`2026-10-25T12:29:19.748Z` confirmed both absent without reading their values.
The safety census covered 170 active definitions in four selected families and
all current runtime references. No active or live references to those two
parameters remained. The post-deletion health and exact image readback confirmed
Mercaria 144 healthy on `5ef09822`. That cleanup receipt predates the approved
cookie-free commerce change above and establishes neither its deployment nor
activation of global v1 retirement.

[Infrastructure docs PR #399](https://github.com/OxyHQ/oxy-infra/pull/399)
merged as `39eaf793`; the operational receipts, rather than documentation,
establish the bounded retirement. Oxy
[PR #1984](https://github.com/OxyHQ/oxy/pull/1984) remains a separate draft
retirement change; its current release gates are tracked in that PR. Independent comparison against
the actual Core 7.3.0 archive found no public API removal, supporting a 7.x minor
once all retirement gates pass. Core 7.4.0 is prepared in that change; publication and runtime activation
remain separate and are not yet established here. The verified prelaunch parking
and 300-second drain remove Schedio's old producer from the active rollout path,
without making its future public launch a prerequisite. Final release, consumer
composition and runtime acceptance still require their own receipts. This
checkpoint does not declare fleet completion.

## Historical source audit (2026-10-23)

The following edges were inspected at remote `origin/main` on 2026-10-23.
This is the original source inventory, not the current backlog: the verified
rollouts and explicit remaining holds above supersede it. A runtime code path
alone is not evidence that a feature is enabled in production.

| Caller → receiver | Transport and identity found at audit | Initial work identified |
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
personal Files access uses the requester facade. The current rollout table and
explicit remaining holds above supersede the historical source inventory below.


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
