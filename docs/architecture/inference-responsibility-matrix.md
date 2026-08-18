# Inference platform — responsibility matrix

- Issue: #972 (workstream 0/A)
- Date: 2026-08-15. **§15 was re-verified and updated on 2026-08-16**, when the
  SDK catalogue client and the `docs/inference/` doc set landed; one §5 row was
  corrected at the same time because `models-stats.ts` no longer exists. **§6
  and one §7 row were re-verified on 2026-08-16** against #1012's route-selection
  enforcement and the usage-unit contract (#1017, #1018). **Five §12 rows were
  re-verified and updated on 2026-08-17** — the two payload-retention rows and the
  PII row against [ADR 0016](../adr/0016-no-inference-payload-persistence.md), and
  the secret-scanning and rotation-runbook rows against the gates and
  [`docs/runbooks/`](../runbooks/README.md) that landed with it. **§1, §1.1, §2,
  §3, §3.1, §4, §4.1, §5, §7, §8, §12, §13 and §14 were re-verified and corrected
  on 2026-08-17** by workstream 2.3, and the STATUS LEGEND was rewritten because
  the corrections were blocked on a definition rather than on facts — see the two
  rules under it. Census: **298 table rows scanned, 121 carrying a `planned`
  status**, with a positive control (the `/v1/responses` row is found and reads
  `exists`) and a negative control (no row matches a fabricated `/v1/zzz-nope`).
  The corrections fall into four classes: rows marked `planned`
  that already existed (the large majority, spread across §1, §2, §3 and §4), rows
  marked `exists` whose subject had been deleted, the two retired key tables, and
  the `Relay` naming decision. Each was checked against the source before the row
  was edited; no count is given here because a tally in prose is the kind of claim
  that rots without anything failing. Every other row is
  still a claim about 2026-08-15, and §5's descriptor rows in particular predate
  the catalogue merging (#982) — re-verify before citing them.

  A pattern worth naming, since it has now recurred three times in this file: the
  rows that go stale are the `planned` ones, because nothing forces a revisit when
  the thing gets built. `exists` rows rot only when something is deleted, which is
  rarer. **Re-verify every `planned` row before citing this document as evidence
  that work remains.**

- **2026-08-18: the STATUS column was audited row by row against `main` at
  `2a25ca3e`, and 97 of the 111 `planned` rows were wrong** — 71 fully shipped, 21
  `partial` (a status value this pass added to the legend) plus 2 rows split
  instead, and 3 that rule 1 makes `unverified` rather than `planned`. 13 were
  correctly `planned`; §7's zero-usage
  reconciliation row was left for the workstream holding the ledger service. Census
  for this pass: **302 data rows before the edit, 111 carrying exactly `planned`**,
  with the same positive control (`/v1/responses` reads `exists`) and negative
  control (`/v1/zzz-nope` matches nothing). **Nine `planned` rows remain** after the
  same-day follow-up below, and they are the honest ones: normalized rate-limit
  headers, the three `api_key_usage_events` columns, the static Alia proxy's removal
  (a row whose `planned` means it is still LIVE), the Python SDK, alerts firing into
  a destination that does not exist, status-page signals, and §7's reconciliation
  row. Whole
  sections had finished without their rows moving: §11 all seven, §9 fifteen of
  eighteen, §16 thirteen of eighteen, §10 nine of eleven. Every re-judged row now
  cites `file.ts:line`, and rows 393 and 399 were split so each owner carries its
  own status.

  **The direction was one-way and that is the useful result: not one row claimed a
  feature that is absent.** The dangerous direction was swept three ways — every
  backticked symbol, table and route in all 146 `exists` rows resolved against the
  migrated table list and an index of 849 non-test source files (zero unresolved,
  with a fabricated-symbol control); every `file:line` anchor checked for
  plausibility (9 flagged, 8 drift, 1 real error); and all 13 `exists` rows
  asserting an ENFORCEMENT read in full. What that sweep cannot see is a row whose
  subject still exists while its assertion is false — the §5 fake-id rows were
  exactly that, and only reading caught them. The behavioural truth of the
  remaining `exists` rows is unaudited; §1 and §2 are where a false one would cost
  most.

  Four corrections beyond the statuses: §1's `account_credentials` row cited
  `0048_…` for a migration that is `0051_retire_account_credentials.sql`; §8's
  `api_key_usage_events` anchors had drifted 10–25 lines; §9's playground row named
  `/v1/chat/completions` when it posts to `/v1/responses`; and §2's RBAC row was
  written before the inference-specific permission vocabulary landed, which it now
  has.
- **2026-08-18, same day: §3's five later-modality rows re-judged, and the rule
  added above had already been broken.** #1055 shipped `/v1/audio/speech` and
  `/v1/images/generations` without editing their rows, so both were stale within
  hours of the pass above — which is the argument FOR that rule rather than an
  embarrassment to it. Measured against `origin/main`: `inferenceEdge.ts` registers
  `/audio/speech` and `/images/generations`, and none of the other four. Those four
  were carrying `planned`, and `planned` was the wrong reading for every one of
  them — they are DECLINED, with reasons already recorded in the code — so the
  `blocked` value was added to the legend and each row now names its own blocker: a
  missing contract output arm plus a data-plane gap for embeddings and rerank, a
  measurement for transcriptions, an ADR 0009 mismatch for batches.
- Governing decisions: [ADR 0005](../adr/0005-oxy-is-the-single-control-plane.md),
  [ADR 0006](../adr/0006-oxy-relay-boundary.md),
  [ADR 0007](../adr/0007-canonical-request-attribution.md),
  [ADR 0008](../adr/0008-catalogue-concept-separation.md),
  [ADR 0009](../adr/0009-usage-reservation-and-settlement.md),
  [ADR 0010](../adr/0010-public-api-compatibility.md),
  [ADR 0011](../adr/0011-inference-data-plane-name.md)

This is the committed ownership record the epic's *"Define ownership of every
table/event/API in a responsibility matrix committed to the repo"* checkbox
refers to. It is exhaustive over every table, event and API surface named in
issue #972.

**Owner** is the single source of truth for the item (ADR 0006). Another system
may *consume* it; only the owner may write it.

**Status** is a claim about **`OxyHQ/oxy`** on the date above — this repository and
no other. Saying so explicitly is not pedantry: the previous wording was "a claim
about this repository", and two whole classes of row cannot be read under it. Both
are spelled out after the list, because getting them wrong made rows in this file
*false* rather than merely stale.

- `exists` — present in the repo at the path given, verified by reading it.
- `planned` — named by the epic, and confirmed **absent from `OxyHQ/oxy`**. It
  carries NO claim about any other system, and for a row describing a removal it
  reads inverted — see the two rules below.
- `removed` — was present, and has since been deleted rather than renamed,
  aliased or deprecated. Distinct from `planned`, which has never existed: a
  reader who finds neither the thing nor a row saying it went cannot tell an
  intentional deletion from an incomplete port.
- `unverified` — a fact about production data or an external system that cannot
  be established from the repo. Used sparingly, and each occurrence says what
  would settle it.
- `contract only` — the published SHAPE exists and no producer writes it, so the
  behaviour does not happen. Distinct from both neighbours on purpose, and the
  distinction this whole matrix nearly lost once: `exists` would claim a working
  feature, `planned` would claim an absent one, and the state that actually
  misleads is a schema field a reviewer reads as evidence of the behaviour it
  describes. Each occurrence names what has to write the field.
- `blocked` — not built, and NOT merely unbuilt: something identifiable has to
  change first, and the row names it. Added 2026-08-18 for the four endpoints
  §3 had carried as `planned`, which is the reading that misleads — a reader
  correctly takes `planned` to mean "nobody has got to it yet", and reaches for
  it. Two of those four are blocked on a two-repo contract release, one is
  refused on a MEASUREMENT (no sound ceiling exists in the request), and one
  needs an ADR amendment. A row using this value states the blocker, and states
  it in enough detail that somebody can tell whether their change removes it —
  where two blockers are independent, say so, because fixing one ships nothing.
- `partial` — one clause of the row shipped and another did not. **The status text
  MUST say which**, or the value is a hedge: "some of this is done" is not a
  finding anybody can act on. Added 2026-08-18, when 21 rows turned out to need
  it — a row asking for four things and holding three is the single most common
  shape in this file, and forcing it into `exists` or `planned` is what made it
  rot. Where the missing clause is another system's, prefer splitting the row so
  each half carries its own owner and status; two rows were split that day rather
  than made `partial`.

### Two rules the status list cannot carry on its own

**1. A row owned by another system says what OXY can see, never what that system
has built.** `Relay` is a real repository (below), and Alia is a real product, so
"absent from `OxyHQ/oxy`" is trivially true of everything they own and therefore
says nothing. On a row whose **Owner** is not Oxy:

- `planned` means *Oxy has not built its half* — use it only where Oxy owes
  something. It is never a statement that the other system lacks the feature.
- `unverified` means *the thing would live in the other system and nobody has
  audited it from here.* This is the honest status for most Relay-owned rows and
  it is what §13 now uses throughout. It is not a hedge; it is the difference
  between "I looked and it is absent" and "I did not look".
- `exists` on a non-Oxy row requires evidence gathered from outside this
  repository, and the row must say what that evidence was. The Relay repository
  row in §13 is the one that qualifies: `gh repo view` is the evidence.

**2. A row describing a REMOVAL reads with inverted polarity.** "Removal of the
static Oxy→Alia infrastructure proxy" is `planned`, and that means **the proxy is
still there** — the opposite of what `planned` means on every other row. A reader
skimming the status column sees `planned` and concludes the thing is absent, when
the row is asserting it is present. Every such row now says so in its status text
rather than relying on the reader noticing that the Item is a verb. The general
rule: on a removal row, `planned` = not yet removed = **still live**, and
`removed` = done.

`Relay` is the production name. ADR 0011 is closed: all four of its prohibitions
are lifted, so the name may appear in a published package name, in public
documentation, in a public API path, header or field, and in a public repository
or domain. Two things that decision did NOT include, recorded because a closed ADR
reads as "everything was cleared" otherwise: trademark clearance and
domain/package availability were **never run** and remain outstanding, and the
term-of-art collision with atproto's `Relay` was considered and overruled rather
than absent.

**`OxyHQ/Relay` now exists.** Re-verified 2026-08-17: `gh repo view OxyHQ/Relay`
returns a PUBLIC, non-empty repository whose primary language is Go, last pushed
2026-08-16. The 2026-08-15 note this paragraph used to carry — `Could not resolve
to a Repository with the name 'OxyHQ/Relay'` — was true when written and is not
any more.

That settles existence and nothing else. **§13's rows are about what is BUILT
inside that repository, and this document cannot answer them**: they describe an
external codebase nobody has audited from here, so they are marked
`unverified` rather than flipped to `exists`. Reading a repository's existence as
evidence that its contents are done is the same error as reading a built wire as
evidence that it is deployed (§4.1).

---

## 1. Account, application and credential ownership (epic §1, §2)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| Account graph (`users`, `kind`, `parent_account_id`) | Oxy | OxyHQServices `packages/api/src/db/schema/users.ts:144,353` | exists |
| Account kind vocabulary (`personal`/`organization`/`project`/`bot`/`channel`) | Oxy | OxyHQServices `packages/contracts/src/accountGraph.ts:35` | exists |
| Account membership and roles (`account_members`) | Oxy | OxyHQServices `packages/api/src/db/schema/accountMembers.ts:68` | exists |
| Effective-access resolution (caller → effective account role) | Oxy | OxyHQServices `packages/api/src/services/account.service.ts:724` | exists |
| Account graph client surface | Oxy | OxyHQServices `packages/core/src/mixins/OxyServices.accounts.ts` | exists |
| `applications` (`owner_account_id`) | Oxy | OxyHQServices `packages/api/src/db/schema/applications.ts:172` | exists |
| Application access derived from owning account, no per-app member table | Oxy | OxyHQServices `packages/api/src/routes/applications.ts:72-79` | exists |
| `application_credentials` (public key, secret hash, rotation grace, lineage) | Oxy | OxyHQServices `packages/api/src/db/schema/applicationCredentials.ts:55,71,87,102` | exists |
| Credential usability predicate (active OR deprecated-in-grace) | Oxy | OxyHQServices `packages/api/src/utils/credentialUsability.ts` | exists |
| `developer_api_keys` (legacy, epic §2.3) | Oxy | dropped by `packages/api/drizzle/0047_retire_developer_api_keys.sql` | removed |
| `developer_api_keys` confirmed empty in production | Oxy | production database, read from a one-shot Fargate task on `oxy-oxy-api:201` | **verified 2026-08-17: 0 rows**, as were `api_key_usage_events` (0) and its rows with a non-null `api_key_id` (0). Controls that make the zero mean something: 69,432 users, 31 applications, 34 application_credentials, 153 public tables, 46 of 46 migrations applied. Read-only queries |
| `account_credentials` — a second credential table that authenticated nothing | Oxy | dropped by `packages/api/drizzle/0051_retire_account_credentials.sql` | removed — see §1.1 below |
| Machine/API-key credential type (`oxy_sk_*`), one-time bearer | Oxy | OxyHQServices `packages/api/src/db/schema/applicationCredentials.ts:87` (`'machine'`), minted by `packages/api/src/utils/machineCredentialToken.ts`, resolved by `packages/api/src/middleware/machineCredential.ts` | exists — accepted on the `/v1` edge, gated per deployment by `INFERENCE_MACHINE_CREDENTIAL_AUTH` (`config/rolloutFlags.ts`), which is OFF when unset |
| Helper: application → owner account | Oxy | OxyHQServices `packages/api/src/services/attribution.service.ts:130` | exists |
| Helper: credential → application → owner account | Oxy | OxyHQServices `packages/api/src/services/attribution.service.ts:220,244` | exists |
| Helper: owner account → billing profile | Oxy | OxyHQServices `packages/api/src/services/attribution.service.ts:513,561` | exists |
| Relay organization / workspace / project / membership table | **forbidden** (ADR 0005 invariants 1–3) | — | must never exist |
| Relay application-id or API-key issuance | **forbidden** (ADR 0005 invariants 2–3) | — | must never exist |

### 1.1 `account_credentials` — the second key table, and how it hid

**Resolved: removed** (`packages/api/drizzle/0048_retire_account_credentials.sql`).
Kept in this document because *how* it survived is the reusable part.

The §2 invariant reads *"there is exactly one customer credential lifecycle: Oxy
`ApplicationCredential`."* `developer_api_keys` was the one removal on anybody's
checklist. `account_credentials` was on none of them, and it had been violating
the same invariant the whole time.

**What it was.** A `service`-only credential issued against a `bot`-kind account
rather than an application, with a full public lifecycle (list / create / rotate /
revoke on `/accounts/:id/credentials`), a `secret_hash`, `APPLICATION_SCOPES`
validation, a staff gate on privileged scopes, and the same seven-day rotation
grace `application_credentials` uses. Deliberate, documented, and reviewed.

**What it was not.** *Nothing authenticated against it.* Its only resolver,
`accountService.resolveUsableCredential`, had zero callers anywhere in the
repository, tests included — the identically named calls in `routes/auth.ts` are a
different, file-local function over `application_credentials`. No middleware read
it. So a customer could mint, rotate and revoke a secret that granted access to
nothing, and a revocation performed on one did nothing, because there was nothing
to revoke.

**The owner's decision was removal**, over the alternative of naming it as an
exception with its reason ("an account-owned bot principal, not a customer
inference credential"). The argument that settled it: the invariant forbids a
second key TABLE, not a second working credential — so "it authenticates nothing"
argues for deleting it, never for exempting it. A credential a customer can create
but never use is a support burden plus a revocation that lies.

Production was measured empty first — 0 rows, 0 distinct accounts, beside a
control of 34 `application_credentials` on the same database, because a bare zero
from a query is not evidence that a thing is absent.

**Why three reviews missed it, which is the point.** Each worked from a *list* of
known key tables, and a list cannot report what is not on it. The audit that found
it was reading the schema. So the invariant now has a gate that derives its answer
from column shape instead of an enumeration:
`packages/api/src/db/schema/__tests__/schemaInvariants.test.ts` asserts that
exactly two tables in the migrated database carry a `*secret_hash` —
`application_credentials` (the permitted lifecycle) and `device_sessions` (the
device-first session transport, a different lifecycle with a different owner). A
third fails it. Mutation-tested both ways: a planted third table fails the
assertion, and a `LIKE` pattern that matches nothing fails the positive control
rather than passing on an empty set.

ADR 0005 invariant 3 now names both removals and states that a future
account-owned credential store is an amendment to the ADR, not a table that
appears beside `application_credentials`.

## 2. Authentication and authorization (epic §2.2, §3)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| `POST /auth/service-token` (client credentials → 1h service JWT) | Oxy | OxyHQServices `packages/api/src/routes/auth.ts:3663` | exists |
| Service-token claims: `appId`, `appName`, `credentialId`, `scopes`, `environment` | Oxy | OxyHQServices `packages/api/src/routes/auth.ts:3663-3673` | exists |
| Service-token claims: `ownerAccountId`, effective scopes envelope | Oxy | OxyHQServices `packages/api/src/routes/auth.ts:3688` (`ownerAccountId`), `:3680-3681` (scopes intersected into the claim) | exists |
| Delegated end-user header `X-Oxy-User-Id` | Oxy | OxyHQServices `packages/core/src/mixins/OxyServices.auth.ts:734`, `OxyServices.utility.ts:514` | exists |
| Service-token verification (signature required) | Oxy | OxyHQServices `packages/core/src/mixins/OxyServices.utility.ts` | exists |
| Shared-secret vs asymmetric/JWKS cross-repo verification decision | Oxy | OxyHQServices `docs/adr/0012-service-token-signing-key-model.md` | exists — the DECISION is recorded and accepted (2026-08-16): asymmetric signing with a published JWKS, the shared HMAC secret retired. The MIGRATION is not written and that ADR names two sub-decisions still needing the owner, so this row is the decision alone |
| `APPLICATION_SCOPES` vocabulary | Oxy | OxyHQServices `packages/api/src/utils/applicationScopes.ts:61` | exists |
| `chat:completions`, `models:read` scopes | Oxy | dropped by `packages/api/drizzle/0031_inference_scope_family.sql`, which rewrote every stored row to a successor | removed — **not aliased**, deliberately: neither name was ever read by any middleware, route or service, so an alias would have been a second way to spell a no-op (`packages/api/src/utils/applicationScopes.ts:41-46`) |
| `inference:invoke`, `inference:models:read`, `inference:usage:read`, `inference:routing:read`, `inference:routing:write`, `inference:providers:read`, `inference:providers:write` | Oxy | OxyHQServices `packages/api/src/utils/applicationScopes.ts:83-89` | exists |
| Credential scopes intersected with application scopes | Oxy | OxyHQServices `packages/api/src/routes/auth.ts:3660-3662` | exists |
| Privileged / staff-approval scope list | Oxy | OxyHQServices `packages/api/src/utils/applicationScopes.ts:184` (`PRIVILEGED_APPLICATION_SCOPES`, including both inference writes) | exists |
| Account/application RBAC mappings for inference, usage, routing, BYOK, billing | Oxy | OxyHQServices `packages/api/src/utils/accountRoles.ts:37-74,103` | exists — the inference-specific vocabulary this row was written without has since landed. `accountRoles.ts:103` carries `inference:invoke`, `inference:routing:read`/`:write`, `inference:providers:read`/`:write` and `inference:usage:read`, spelled deliberately like the SCOPES, plus `inference:byok:read`/`:write`, which appear in no scope list. The earlier reading — generic permissions only, so granting "edit this app" also granted "repoint where inference is served from" — is no longer what the code does |
| Relay-side customer authorization | **forbidden** (ADR 0006) — the edge authorizes before forwarding | — | must never exist |

## 3. Public API edge (epic §4, ADR 0010)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| `POST /v1/chat/completions` | Oxy | OxyHQServices `packages/api/src/routes/inferenceEdge.ts`, mounted `server.ts:690` BEFORE the Alia router | exists — owned by the inference edge, no longer an Alia proxy. Mount order is gated by `routes/__tests__/inferenceEdgeMount.test.ts` |
| `POST /v1/voice/token`, `POST /v1/voice/transcribe` (Alia product endpoints) | Alia | OxyHQServices `packages/api/src/routes/alia.ts:322,327` | exists — behind `requireFirstPartyInferenceCaller` since #972 w2.3; see §3.1 |
| `/alia` mount (same router) | Alia | OxyHQServices `packages/api/src/server.ts:643` | exists |
| Static `ALIA_API_KEY` upstream forwarding (to be removed, epic §4, §14) | Alia | OxyHQServices `packages/api/src/routes/alia.ts:8,46-50,75-81` | exists |
| `POST /v1/responses` (preferred endpoint) | Oxy | OxyHQServices `packages/api/src/routes/inferenceEdge.ts` | exists — asserted served by the edge in `routes/__tests__/inferenceEdgeMount.test.ts` |
| `GET /v1/models`, `GET /v1/models/:id` | Oxy | OxyHQServices `packages/api/src/routes/inferenceCatalogue.ts`, mounted `server.ts:694` | exists |
| `GET /v1/generations/:id` (receipt lookup) | Oxy | OxyHQServices `packages/api/src/routes/inferenceEdge.ts` | exists — asserted served by the edge in `routes/__tests__/inferenceEdgeMount.test.ts` |
| `POST /v1/embeddings` | Oxy | OxyHQServices `packages/api/src/schemas/inferenceEdge.schemas.ts:418-421` (the ceiling) — no route | blocked — TWO independent blockers, and fixing either alone ships nothing. (1) The response shape `number[][]` has no arm in the contract. Both need an additive OUTPUT arm in `@oxyhq/contracts`, then a Relay pin bump and a descriptor regeneration or its `contract drift` job goes red — a release decision, not an endpoint. (2) #1055's audit measured ZERO `modality` hits in Relay's `adapter.go` and `executor.go`, so an `embedding` envelope would validate and then be handed to a chat adapter — evidence gathered outside this repository, per rule 1. The CEILING is built and asserted (`embeddings` is exact, the caller says how many inputs they sent), so whoever adds the output shape inherits a reviewed bound |
| `POST /v1/images/generations` | Oxy | OxyHQServices `packages/api/src/routes/inferenceEdge.ts:1137` | exists — shipped by #1055. `images` = `n ?? 1`, exact and declared, so the hold is not an estimate. This row read `planned` for several hours after that PR merged, because the PR did not edit it — the maintenance rule at the foot of this file exists for exactly that |
| `POST /v1/audio/transcriptions`, `POST /v1/audio/speech` | Oxy | OxyHQServices `packages/api/src/routes/inferenceEdge.ts:1042` (speech) — transcriptions has no route, and the reason is recorded at `:1242-1268` | partial — **speech shipped, transcriptions did not**, and the halves are different kinds of not-built. Speech: `characters` = `input.length`, exact, and it deliberately carries NO duration, so a duration-priced route fails to quote and is refused rather than guessed at. Transcriptions is REFUSED on a measurement: providers bill by duration, duration is a property of the uploaded bytes, and `bytes ÷ bitrate` spans about 7x across the formats such an endpoint accepts — so no byte-derived ceiling is both safe and useful, and an under-sized hold is how a balance goes negative |
| `POST /v1/rerank` | Oxy | OxyHQServices `packages/api/src/schemas/inferenceEdge.schemas.ts:425-428` (the ceiling), `services/inferenceCatalogue.service.ts:1303-1317` (the modality gap) — no route | blocked — the response shape `{index, relevanceScore}[]` has no arm in the contract, and `INFERENCE_MODALITIES` (text, image, audio, video, embedding) cannot express a RANKING either, so rerank constrains its input and leaves its output unconstrained rather than claiming a modality that would be false. Both need an additive OUTPUT arm in `@oxyhq/contracts`, then a Relay pin bump and a descriptor regeneration or its `contract drift` job goes red — a release decision, not an endpoint. The ceiling is built and asserted (`chars(query)` plus the sum over the documents, and no output-token arm) |
| `POST /v1/batches` | Oxy | OxyHQServices `packages/api/src/routes/inferenceEdge.ts:1272-1288` (the reason, beside the routes that do exist) — no route | blocked — and the disqualifying half is the LEDGER, not the ceiling. `reserve` → `settle` assumes one hold per HTTP request settled inside `RESERVATION_TTL_SECONDS`, while a batch's completion window is twenty-four hours: `expireReservations` would release the hold mid-batch and the work would settle against a reservation that no longer stands. Raising the TTL is not the fix — a day-long hold on a shared balance is a different financial product. What batches need is an amendment to ADR 0009 (a hold per sub-request at dispatch, or a long-lived reservation class with partial settlement) |
| `GET /models/stats` (static catalogue; retired by ADR 0008) | Oxy | `routes/models-stats.ts` was DELETED with the catalogue landing (#982); `/models` is now served by `routes/inferenceCatalogue.ts` (`server.ts:715`) | removed |
| Edge attribution resolution before forwarding | Oxy | OxyHQServices `packages/api/src/services/inferenceEdge.service.ts:310` (`resolveCredentialAttributionById`) | exists |
| Edge scope authorization before forwarding | Oxy | OxyHQServices `packages/api/src/services/inferenceEdge.service.ts:520-525` (`inference:invoke`) | exists |
| Spend reservation before the data plane | Oxy | OxyHQServices `packages/api/src/services/inferenceEdge.service.ts` (step 6, `reserve`) | exists |
| Streaming pass-through without buffering | Oxy | OxyHQServices `packages/api/src/services/httpRelayClient.ts` (SSE, both dialects) | exists |
| Client-cancellation propagation to Relay and upstream | Oxy → Relay | OxyHQServices `packages/api/src/services/httpRelayClient.ts:239-241` (`AbortController`, client signal → hop abort) | **Oxy half exists** (#1034) — whether Relay propagates the cancellation upstream is unaudited from here; the repository exists, so this is "not looked at", not "absent" |
| Normalized rate-limit and usage headers | Oxy | OxyHQServices `packages/api/src` | planned |
| Idempotency keys for non-streaming / batch-safe operations | Oxy | OxyHQServices `packages/api/src/routes/inferenceEdge.ts:269-285`, `services/inferenceEdge.service.ts:1462`, `services/inferenceLedger.service.ts:410,639` | partial — the NON-STREAMING half is complete: the header is parsed and an over-long key REFUSED rather than truncated, the ledger key is namespaced per credential, a replay is refused `idempotency_conflict` (`inferenceEdge.service.ts:771`) and the ledger dedupes reservations and entries on it. "Batch-safe operations" cannot ship while `/v1/batches` does not exist |
| Request-size, context-size, output-token limits | Oxy | OxyHQServices `packages/api/src/services/inferenceEdge.service.ts:715-728` | partial — context and maximum output are checked TOGETHER before forwarding, so a request that cannot fit is refused rather than paid for. A request-BODY size limit specific to this edge is absent |
| Abuse / fraud / anomaly controls before public launch | Oxy | OxyHQServices `packages/api/src/server.ts:1188-1210` | partial — spend-anomaly detection is wired and running over `inference_spend_anomalies`, and every inference route carries its own rate limiter (§12). Abuse and fraud controls beyond those two are absent |

### 3.1 The remaining shared-upstream-key paths — an exception list, counted

The epic's §1 checkbox is that an application inherits access and billing
responsibility from `Application.ownerAccountId`. Three routes still forward a
caller-supplied body to Alia on one static `ALIA_API_KEY`, where the financially
responsible principal is Oxy's shared upstream budget and no `ownerAccountId` at
all. They are listed here **exhaustively and by count**, because an exception list
without an exact count grows silently:

| Route | Gate | Reference |
|---|---|---|
| `POST /alia/chat/completions` | `requireFirstPartyInferenceCaller` (#981) | `packages/api/src/routes/alia.ts:246` |
| `POST /v1/voice/token` | `requireFirstPartyInferenceCaller` (#972 w2.3) | `packages/api/src/routes/alia.ts:322` |
| `POST /v1/voice/transcribe` | `requireFirstPartyInferenceCaller` (#972 w2.3) | `packages/api/src/routes/alia.ts:327` |

**Exactly three, and zero of them ungated.** Both halves are asserted in
`packages/api/src/routes/__tests__/inferenceEdgeMount.test.ts` against the route
declarations in `routes/alia.ts`, as two independent cases: a fourth shared-key
route fails the second one even when written in a form the first cannot see (an
inline handler with no named middleware — measured, and the reason the census is
two regexes rather than one).

All three offer no reservation and no metering, so the exposure the gate closes is
the one that route's header states: "no per-caller stop — `max_tokens` and the
prompt are the caller's, so a request limiter bounds the COUNT of requests and
never their cost" (`alia.ts:96-108`). Gating bounds WHO may spend, not how much.

**Why the voice routes were exempt until now, and why the reason was false.** #981
left them on `authMiddleware` on the stated grounds that they "are reached by
signed-in users of Oxy's own voice surfaces, which hold no service credential", so
gating them would remove a working feature. A read-only census across every
repository under `~/Oxy` found **no caller of either route anywhere**:

- Inbox's voice feature is `VoiceSession` from `@alia.onl/sdk`, and the INSTALLED
  package (5.1.0 — not the sibling source tree) builds `/v1/voice/token` and
  `/v1/voice/transcribe` against `https://api.alia.onl`, naming no Oxy host at all.
  Inbox's only Oxy-routed Alia call is `/alia/chat/completions`.
- Alia's own `alia-chat` hooks and `integrations` client target
  `EXPO_PUBLIC_ALIA_API_URL ?? 'https://api.alia.onl'` and Alia's own API port —
  Alia has its OWN `/v1/voice/*` routes, which is what those call.
- No `@oxyhq/services` / `@oxyhq/core` surface exposes a voice method, and no
  installed copy of either across fourteen consumer repositories references the
  paths.
- Mention's LiveKit usage is its own rooms feature against `livekit.oxy.so`, minted
  by its own backend.

So the exemption was protecting nothing while leaving the exposure open. The
`(inbox, etc.)` attribution in the old route comment was the specific claim that
did not survive checking.

Separately, two server-side services call Alia on the same key —
`services/aiLabeling.service.ts` and `services/cardExtraction.service.ts`. They
are not customer-reachable inference paths (no caller-supplied body, no
per-customer attribution question), so they are not in the count above, but they
are on the same key and a rotation touches them.

`POST /v1/chat/completions` is **not** in this list: the inference edge owns that
path, mounted before the Alia router, which the same test file gates by mount
order. Retiring these three is workstream 14 (ADR 0010); until then, the §1
checkbox is honest only if it is explicitly scoped to `/v1` minus `/v1/voice/*`.

## 4. Oxy↔Relay contracts (epic §0 "Contract package")

The package `@oxyhq/contracts` exists (`packages/contracts`, zod-only, epic's
"dependency-light" requirement already met).

**Almost every schema below now exists**, in `packages/contracts/src/inference/`
(thirteen modules). The blanket "every schema below is absent today" this section
opened with was a claim about 2026-08-15 and was already false when #1034 shipped
the signed hop over these shapes; the rows are re-verified against the source
below. The one that remains genuinely absent is the cross-repo compatibility
suite, which needs agreement from the other side rather than more code here.

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| `@oxyhq/contracts` package | Oxy | OxyHQServices `packages/contracts` | exists |
| Authenticated principal and attribution schema | Oxy | `packages/contracts/src/inference/attribution.ts` (`authenticatedPrincipalSchema`, `billingPrincipalSchema`, `inferenceAttributionSchema`) | exists |
| Normalized inference request schema (internal envelope, ADR 0010) | Oxy | `packages/contracts/src/inference/request.ts` | exists |
| Normalized stream event schemas | Relay (shape agreed with Oxy) | `packages/contracts/src/inference/streamEvents.ts` (`inferenceStreamStartEventSchema`, `…DeltaEvent…`, `…ToolCallEvent…`, `…UsageEvent…`) | exists — Oxy has defined the shape. Whether Relay produces it is unaudited from here, and "agreed" is a cross-repo fact this document cannot settle either way |
| Model catalogue descriptor schemas | Oxy | `packages/contracts/src/inference/catalogue.ts` | exists |
| Routing policy schema | Oxy | `packages/contracts/src/inference/routingPolicy.ts` | exists |
| Usage reservation schema | Oxy | `packages/contracts/src/inference/usage.ts` (`usageReservationRequestSchema`, `usageReservationSchema`) | exists |
| Usage settlement / receipt schema | Oxy | `packages/contracts/src/inference/usage.ts` (`usageReceiptSchema`, `normalizedUsageReportSchema`) | exists |
| Refund / reversal schema | Oxy | `packages/contracts/src/inference/usage.ts` §4 (`usageRefundSubjectSchema`) — compensating entries, never deletions | exists |
| Provider / BYOK connection metadata schema (no secrets) | Oxy | `packages/contracts/src/inference/providerConnection.ts` (`providerSecretReferenceSchema` carries a REFERENCE, never the secret — ADR 0013) | exists |
| Price-version schema | Oxy | `packages/contracts/src/inference/priceVersion.ts` | exists |
| Error and retryability schema | Oxy | `packages/contracts/src/inference/errors.ts` (`inferenceErrorCodeSchema`, `upstreamErrorCategorySchema`, `safeErrorTextSchema`) | exists |
| Envelope/event version fields on every externally consumed shape | Oxy | `packages/contracts/src/inference/version.ts` (`INFERENCE_CONTRACT_VERSION`) | exists |
| Schema-version compatibility tests (Oxy ↔ Relay) | Oxy + Relay | OxyHQServices `packages/contracts/src/__tests__/inference.compatibility.test.ts` + OxyHQ/Relay | partial — Oxy's half EXISTS, and is not a thin scan: a frozen version map asserted with EXACT equality, a census over `readdirSync` of `src/inference/` so a new file cannot hide, a frozen list of the exported unions, and a round-trip fixture per versioned shape. The CROSS-REPO half needs Relay and is `unverified` from here, not `planned` |

### 4.1 The Oxy→Relay wire is BUILT and NOT DEPLOYED — two facts, kept apart

#1034 shipped the signed hop. `packages/api/src/services/httpRelayClient.ts` sends
the envelope with `X-Oxy-Relay-Key-Id` and
`X-Oxy-Relay-Signature: v1=<base64 Ed25519 signature>`, signs a hash of the
**exact serialized bytes** that go on the wire (re-serializing between signing and
sending is how a signature check becomes decorative — ADR 0015), streams
`text/event-stream` on both dialects through one decoder, and propagates client
cancellation to the hop via `AbortController` (`:239-241`). Ed25519 key rotation
has a runbook (`docs/runbooks/relay-edge-signing-key-rotation.md`).

**No deployment is configured, and that is a different fact.**
`createHttpRelayClient()` returns `undefined` unless all three of `RELAY_BASE_URL`,
`RELAY_EDGE_SIGNING_KEY_ID` and `RELAY_EDGE_SIGNING_PRIVATE_KEY` are set
(`config/relayDataPlane.ts`, `services/httpRelayClient.ts:202-204`). None is set,
so every invoke still answers a typed `service_unavailable` and `stream: true` is
refused — byte-for-byte the behaviour from before the hop existed.

Both halves are stated because merging them is a real failure mode, not a
stylistic preference: "the wire works" and "requests reach a data plane" have
opposite operational consequences, and the same conflation in
`middleware/machineCredential.ts` had that file asserting nothing mounted its lane
while the edge was calling its resolver. A row that says only `exists` invites
somebody to close the workstream; a row that says only `planned` invites somebody
to rebuild the wire.

The far side is a THIRD fact, and also not a consequence of configuration.
`OxyHQ/Relay` exists (public, Go, last pushed 2026-08-16), so "Relay does not
exist" is no longer the reason an invoke refuses — the three unset variables are.
What that repository actually implements has not been audited from here; see §13.

## 5. Model catalogue (epic §5, ADR 0008)

**The thirteen field-level rows were judged on 2026-08-18, per column, and all
thirteen were wrong.** They had stood at `planned` — which this file's legend
defines as *confirmed absent* — while every field they name was present in the
migrated schema (`meta/0051_snapshot.json`, created by
`drizzle/0035_inference_catalogue.sql`) and read by the customer projection.
Eleven are now `contract only` and two are `exists`; each says which file and
line settles it.

`contract only` rather than `exists` is the whole point of the re-judgement, and
it is a stronger statement than either neighbour would have been. The columns are
real and the read path is real, and **nothing in the repository can write them**:
outside tests, the only writer of any catalogue table is
`packages/api/scripts/seed-inference-catalogue.ts:130`, and it writes publishers
only. `exists` would have read as a working feature; `planned` claimed an absent
one; the state that actually misleads is a schema field a reviewer takes as
evidence of the behaviour it describes.

Two traps produced false readings during these reviews, and both are worth
keeping:

**A path is not a citation.** Ten of these thirteen rows cited the bare directory
`packages/api/src/db/schema`, which exists whether or not a single column the row
names does — so nothing could confirm or refute them. They now cite `file.ts:line`.
The same shape produced a false lead earlier in this file's history: a check that
asked "does the file this row names exist?" flagged three rows about
`api_key_usage_events`, and the columns those rows name are absent from that file,
so all three were correctly `planned` and the check was measuring nothing. Ask of
any check what it would report if the feature were absent.

**A grep matches the comment that documents a removal.** Three rows in this
section read `exists` for the four retired model ids after #982/#991 had deleted
them, because the surviving text is the comment explaining the retirement. A
comment-aware, boundary-anchored census finds **three** code occurrences of those
names in the whole repository — one in production
(`packages/api/src/config/email.config.ts:112`, correct, see
`docs/inference/migration.md`) and two test fixtures — and **zero** anywhere in
Console.


| Item | Owner | Repo / path | Status |
|---|---|---|---|
| Static `alia-lite` / `alia-v1` / `alia-v1-pro` / `alia-v1-pro-max` array (retired) | Oxy | OxyHQServices `packages/api/src/routes/models-stats.ts` | **gone** — the file was deleted with the catalogue landing (#982). Every surviving occurrence of the four names is enumerated in `docs/inference/migration.md` |
| Same fake ids in Console model docs | Oxy | OxyHQServices `packages/console/src/routes/_layout/documentation/models.tsx:13-43` | removed — gone from this page as DATA. The two surviving lines (`:15-16`, four occurrences) are the comment explaining what was retired, which is exactly why this row read `exists` after #982/#991 deleted the array: a grep returns hits in both worlds |
| Same fake ids in quickstart / chat-completions examples | Oxy | OxyHQServices `packages/console/src/routes/_layout/documentation/quickstart.tsx:127`, `documentation/chat-completions.tsx:109` | removed — **0 occurrences** in either file, measured comment-aware and boundary-anchored so `alia-v1-voice` is not counted as `alia-v1` |
| Playground default model string | Oxy | OxyHQServices `packages/console/src/routes/_layout/playground.tsx:103` | removed — **0 occurrences**; the playground selects from the real catalogue |
| `AI_LABELING_MODEL` default `alia-lite` (internal consumer) | Oxy | OxyHQServices `packages/api/src/config/email.config.ts:112` (`:100` begins the comment explaining why it is correct) | exists — and it is the ONLY production-code occurrence of the four names in the repository. Repo-wide there are three in code: this one plus two test fixtures (`services/__tests__/aiLabeling.service.test.ts:105`, `routes/__tests__/alia.test.ts:197`). `docs/inference/migration.md` carries the reasoning |
| `Publisher` descriptor | Oxy | OxyHQServices `packages/api/src/db/schema/inferencePublishers.ts` | exists — table present in the migrated schema (`meta/0049_snapshot.json`) and in production (0 rows) |
| `Model` descriptor, canonical id `<publisher>/<model>` | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceModels.ts` | exists — table present in the migrated schema and in production (0 rows) |
| `ModelRevision` (immutable), id `<publisher>/<model>@<revision>` | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceModelRevisions.ts` | exists — table present in the migrated schema and in production (0 rows) |
| `InferenceProvider` identity | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceProviders.ts` | exists — table present in the migrated schema and in production (0 rows) |
| `Deployment` / endpoint identity and region | Relay (health/availability); Oxy (customer-safe projection) | OxyHQServices `packages/api/src/db/schema/inferenceDeployments.ts:124,140-155` + `services/inferenceCatalogue.service.ts:560` | exists — the table and its `regions` column are in the migrated schema, and the customer-safe projection is an explicit allow-list. This row was `planned` while Oxy's half was built, which rule 1 forbids: on a row Oxy part-owns, `planned` claims Oxy owes something |
| Deployment HEALTH and route availability | Relay | OxyHQ/Relay | unverified — Relay-owned and not audited from here (rule 1). `inference_deployments.status` is the CATALOGUE's offerability decision and deliberately not a health signal |
| `RoutingProfile` (`auto`, `fast`, `quality`, customer-defined) | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceRoutingProfiles.ts` | exists — table present in the migrated schema and in production (0 rows) |
| Capability fields (tools, vision, audio, structured output, reasoning, context, max output, caching, modalities) | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceModels.ts:135-146` | contract only — `input_modalities`, `output_modalities`, seven `supports_*` flags, `max_context_tokens` and `max_output_tokens`, all in the migrated schema and all read by `services/inferenceCatalogue.service.ts:899-911`; `max_context_tokens` is additionally ENFORCED at `services/inferenceEdge.service.ts:715`. Nothing WRITES it: outside tests the only writer of any catalogue table is `packages/api/scripts/seed-inference-catalogue.ts:130`, and it writes publishers only. What has to write it is the catalogue authoring surface — §11's admin API moves a deployment's permission state and publishes nothing. Vision and audio are modality MEMBERS, not `supports_*` flags — a search for either column name finds nothing while the capability is fully expressible |
| Publisher and model licence | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceModels.ts:151-162,174` | contract only — `license_id`, `license_display_name`, `license_url`, `commercial_use_allowed`, `requires_attribution`, `acceptable_use_policy_url`, plus `base_model_attribution_required`. Licence attaches to the MODEL and never to the publisher: `inference_publishers` has no licence column and `modelPublisherSchema` no licence field, deliberately. Nothing WRITES it: outside tests the only writer of any catalogue table is `packages/api/scripts/seed-inference-catalogue.ts:130`, and it writes publishers only. What has to write it is the catalogue authoring surface — §11's admin API moves a deployment's permission state and publishes nothing |
| Provenance / base model | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceModels.ts:178-187`, `inferenceModelProvenance.ts:98-170` | contract only — `release_kind`, `base_model_reference` and `training_organization`, with the two content-provenance triggers beside them. Nothing WRITES it: outside tests the only writer of any catalogue table is `packages/api/scripts/seed-inference-catalogue.ts:130`, and it writes publishers only. What has to write it is the catalogue authoring surface — §11's admin API moves a deployment's permission state and publishes nothing |
| Knowledge cutoff and release date | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceModels.ts:197-198` | contract only — `knowledge_cutoff` and `released_on`, both `date` rather than `timestamptz`, because a cutoff is published as a DAY and inventing a timezone makes two records of one published fact compare unequal. Nothing WRITES it: outside tests the only writer of any catalogue table is `packages/api/scripts/seed-inference-catalogue.ts:130`, and it writes publishers only. What has to write it is the catalogue authoring surface — §11's admin API moves a deployment's permission state and publishes nothing |
| Regions and deployment providers | Relay (truth); Oxy (projection) | OxyHQServices `packages/api/src/db/schema/inferenceDeployments.ts:155`, `inferenceProviders.ts:61`, `services/inferenceCatalogue.service.ts:869-884` | exists — Oxy's projection is built: the union of the routes' regions and the customer-safe serving providers, both on the catalogue entry. Was `planned` while built, which rule 1 forbids on a row Oxy part-owns |
| Deployment availability and provider health as the source of REGION truth | Relay | OxyHQ/Relay | unverified — Relay-owned and not audited from here (rule 1). Oxy consumes a customer-safe projection; it does not own the availability fact |
| Data-retention and training-on-customer-data policy | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceDeployments.ts:159-164,314-321`, `inferenceProviders.ts:65-72` | contract only — the ROUTE's own policy and the PROVIDER's published one, deliberately two copies, with coherence CHECKs on both. Already enforced against a customer routing policy wherever rows exist (`services/inferenceCatalogue.service.ts:432-443`). Nothing WRITES it: outside tests the only writer of any catalogue table is `packages/api/scripts/seed-inference-catalogue.ts:130`, and it writes publishers only. What has to write it is the catalogue authoring surface — §11's admin API moves a deployment's permission state and publishes nothing |
| Zero-data-retention availability | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceDeployments.ts:162`, `inferenceProviders.ts:69` | contract only — and the capability-versus-actual distinction is already enforced: `services/inferenceCatalogue.service.ts:432-439` excludes a route that merely OFFERS zero retention while still retaining. Nothing WRITES it: outside tests the only writer of any catalogue table is `packages/api/scripts/seed-inference-catalogue.ts:130`, and it writes publishers only. What has to write it is the catalogue authoring surface — §11's admin API moves a deployment's permission state and publishes nothing |
| Customer pricing by unit and price version | Oxy | OxyHQServices `packages/api/src/db/schema/priceVersions.ts:116,196` + `inferenceDeployments.ts:228` | contract only — `price_versions` and its child `price_version_unit_prices` (unit drawn from `USAGE_UNITS`) exist, a route links one through `price_version_id`, and the catalogue entry publishes a price SNAPSHOT (`services/inferenceCatalogue.service.ts:806`). **Nothing writes either table**, which that file says of itself at `:48-54`; the intended home is the same catalogue authoring surface. Note the path: pricing is the LEDGER's `priceVersions.ts`, not an `inference*` schema file |
| Deprecation status and replacement pointer | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceModels.ts:202-210,272-275` | contract only — `deprecation_status`, `replacement_model_reference`, `deprecation_announced_at`, `deprecation_sunset_at`, with the CHECK refusing a sunset date on an `active` model, so the deprecation must be announced first. Nothing WRITES it: outside tests the only writer of any catalogue table is `packages/api/scripts/seed-inference-catalogue.ts:130`, and it writes publishers only. What has to write it is the catalogue authoring surface — §11's admin API moves a deployment's permission state and publishes nothing |
| Model card, evaluation summary, safety metadata | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceModelRevisions.ts:111,121-129,168-171`, `inferenceModelEvaluations.ts:26-70` | contract only — `model_card_url`, the safety group with a CHECK making it present-or-absent as a WHOLE, and evaluations as a child table keyed on `(revision, suite, metric)` rather than `jsonb`. All three hang off the REVISION, because they describe specific weights. Nothing WRITES it: outside tests the only writer of any catalogue table is `packages/api/scripts/seed-inference-catalogue.ts:130`, and it writes publishers only. What has to write it is the catalogue authoring surface — §11's admin API moves a deployment's permission state and publishes nothing |
| Upstream provider secrets, internal route ids, wholesale cost | Relay — **never exposed** to customers (ADR 0006) | OxyHQServices `packages/api/src/db/schema/inferenceDeployments.ts:239,259-265`, `protectedColumns.ts:172-179`, `services/inferenceCatalogue.service.ts:560-614` + OxyHQ/Relay | exists — and this row was in the wrong repository. `internal_route_id` and the four `upstream_wholesale_cost_*` columns are OXY columns: Relay owns the MEASURED upstream cost (ADR 0006) while Oxy stores a contracted rate for margin review, and the NON-EXPOSURE is enforced here twice — a default-DENY allow-list (`CUSTOMER_SAFE_DEPLOYMENT_COLUMNS`) plus the protected-column registry, with `schema/__tests__/inferenceCatalogue.test.ts:555-585` failing on any deployment column classified in neither list. Upstream provider SECRETS are genuinely absent from Oxy: BYOK stores a reference, never the secret (ADR 0013) |
| `alia/*` namespace, reserved for real Alia-owned releases | Alia (publisher), Oxy (registry) | OxyHQServices `packages/api/src/db/schema/inferenceModels.ts:294-297` | contract only — the reservation is a live CHECK in the database (`inference_models_reserved_namespace_is_first_party`, present in `meta/0051_snapshot.json`), mirrored by the contract refinement at `packages/contracts/src/inference/catalogue.ts:283-293` and driven against real rows by `schema/__tests__/inferenceCatalogue.test.ts:211-270`. The enforcement works; what is absent is any model row for it to constrain. Nothing WRITES it: outside tests the only writer of any catalogue table is `packages/api/scripts/seed-inference-catalogue.ts:130`, and it writes publishers only. What has to write it is the catalogue authoring surface — §11's admin API moves a deployment's permission state and publishes nothing |
| Catalogue SEEDED in production (`inference_publishers` non-empty) | Oxy | OxyHQServices `packages/api/scripts/seed-inference-catalogue.ts`, `bun run seed:inference-catalogue` | **verified 2026-08-17: NOT seeded.** `inference_publishers` is 0 rows in production, as is every other inference table (models, revisions, evaluations, providers, deployments, routing profiles and policies, provider connections and their audit events, route-switch events, usage events, receipts, reservations, price versions), read-only from a one-shot Fargate task on `oxy-oxy-api:206`. Controls: `users` 69,465, `applications` 31, 47 migrations applied, a nonexistent table 0. The script exists and is idempotent, but **no workflow or deploy script invokes it** — only the manual `bun run`, verified by grep over `.github/workflows/` and `.github/scripts/`. Consequence, which is stronger than a missing display name: `inference_models.publisher_slug` carries an FK to `inference_publishers.slug` (`onDelete: restrict`, confirmed in `meta/0049_snapshot.json`), so with the publishers table empty **no model row can be inserted at all**. Note the CHECK `inference_models_reserved_namespace_is_first_party` is NOT affected — it is a self-contained predicate over `publisher_slug` and `release_kind` and needs no publisher row |

## 6. Routing policy (epic §6)

**Re-verified 2026-08-16 (#1018)**, by reading `inferenceCatalogue.service.ts`
and `inferenceEdge.service.ts` rather than by inference from the schema. The
correction this section needed: the request envelope carries a policy
**reference** (`{routingPolicyId, policyVersion}`), never the resolved values, so
a row reading "Oxy (policy), Relay (execution)" was a promise the data plane had
no way to keep. Since #1012, ROUTE SELECTION IS COMPLETE BEFORE THE ENVELOPE IS
BUILT: the control plane filters candidates against every control expressible as
a predicate over one candidate and refuses with `policy_violation` when none
qualifies. What is left to the data plane is ranking among routes that already
qualify, and failover within destinations the policy authorized.

**Re-verified again 2026-08-17 ([ADR 0017](../adr/0017-authorized-routes-in-the-envelope.md)).**
That last clause described a capability the envelope did not support: it named no
destinations, so `resolveEdgeRoute` computed the ordered survivor set
(`permitted.kept`), served `[0]` and discarded the rest. The contract now carries
`authorizedRoutes` — the survivors, in preference order, each naming a deployment,
a revision-pinned model, a provider and its regions, with cross-model
substitution expressible only through an entry carrying
`authorizedByPolicy: true`.

**Re-verified 2026-08-18.** The field is OPTIONAL and `inferenceEdge.service.ts`
now POPULATES it, for the `same_model` half. `resolveEdgeRoute` returns
`permitted.kept[0]` as the route and the rest as `alternates`; `buildEnvelope`
sends `[primary, ...alternates]` as `authorizedRoutes` when the customer's
`fallback` controls authorize failover among them, and `[primary]` alone when they
do not — always as an explicit list, never by omitting the field, so absence keeps
exactly one meaning (an envelope built before ADR 0017). Two consequences worth
reading as rows in their own right: `fallback.sameModelDeployment` acquired its
FIRST enforcement point here (`recordRouteSwitch` reads only `fallbackDisabled`
for a deployment-scope switch), and the hold is now sized at the dearest
AUTHORIZED route rather than at the admitted one, which is what makes ADR 0017's
"no failover among them can exceed the hold" true of the code. The `cross_model`
half is still unpopulated.

Every control of `routingPolicySchema` is either enforced by
`violatedConstraints` or named with its reason in `UNFILTERED_ROUTING_CONTROLS`;
a control in neither list fails `tsc`, so this table cannot silently fall behind
the contract.

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| Per-application default model or routing profile | Oxy (policy + resolution) | OxyHQServices `packages/api/src/services/inferenceEdge.service.ts` | exists |
| Provider allowlist / denylist | Oxy (policy + enforcement) | OxyHQServices `packages/api/src/services/inferenceCatalogue.service.ts` | exists |
| Region / data-residency constraints | Oxy (policy + enforcement) | OxyHQServices `packages/api/src/services/inferenceCatalogue.service.ts` | exists |
| Zero-retention requirement | Oxy (policy + enforcement) | OxyHQServices `packages/api/src/services/inferenceCatalogue.service.ts` | exists |
| Prohibit-training-on-customer-data constraint | Oxy (policy + enforcement) | OxyHQServices `packages/api/src/services/inferenceCatalogue.service.ts` | exists |
| Maximum customer price per unit/request — stored, versioned, pinned on the receipt, enforced by NEITHER side (named inert in `UNFILTERED_ROUTING_CONTROLS`, issue #1011) | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceRoutingPolicyPriceCaps.ts` (the per-UNIT half) + `inferenceRoutingPolicyVersions.ts` (`max_price_per_request_amount`, the per-REQUEST half) | exists |
| Sort by price / latency / throughput / balanced — the one routing decision the data plane makes | Oxy (policy), Relay (execution) | OxyHQServices `packages/api/src/db/schema/inferenceRoutingPolicyVersions.ts` + `services/inferenceCatalogue.service.ts:277-298` + OxyHQ/Relay | partial — Oxy's half is stored and versioned (`optimise_for`) and deliberately classified INERT on this side in `UNFILTERED_ROUTING_CONTROLS`, because ranking among routes that already qualify is the data plane's (ADR 0006). Oxy owes nothing further here; the execution half is `unverified`, not `planned` |
| Oxy-hosted-only option | Oxy (policy + enforcement) | OxyHQServices `packages/api/src/services/inferenceCatalogue.service.ts` | exists |
| Licence / usage-right constraints | Oxy (policy + enforcement) | OxyHQServices `packages/api/src/services/inferenceCatalogue.service.ts` | exists |
| Fallback-disabled option | Oxy (policy + enforcement) | OxyHQServices `packages/api/src/services/inferenceRoutingPolicy.service.ts` | exists |
| The ordered list of PRE-AUTHORIZED ROUTES the envelope carries — the candidates that survived the policy, in preference order (ADR 0017) | Oxy (authorization), Relay (execution: take the next entry) | OxyHQServices `packages/contracts/src/inference/routingPolicy.ts` (`authorizedRouteSchema`) + `request.ts` + `packages/api/src/services/inferenceCatalogue.service.ts` (`EdgeRouteResolution.alternates`) + `inferenceEdge.service.ts` (`buildEnvelope`) | exists on Oxy's side for `same_model`, verified 2026-08-18 — every envelope carries an explicit non-empty list, driven against a real Postgres by `routes/__tests__/inferenceEdge.test.ts`. Relay's half (take the next entry) is `unverified`: it is not deployed and cannot honour the list yet, so the mechanism is DARK rather than absent |
| Same-model deployment fallback option | Oxy (policy + authorization), Relay (execution) | OxyHQServices `packages/api/src/services/inferenceEdge.service.ts` + OxyHQ/Relay | exists on Oxy's side — a policy permitting it puts every other surviving deployment in `authorizedRoutes` as a `same_model` entry, and one refusing it puts none there. This is the control's FIRST enforcement point: `recordRouteSwitch` reads only `fallbackDisabled` for a deployment-scope switch, so `sameModelDeployment: false` was enforced nowhere before. An application on the platform default authorizes none, because there is no policy version a switch could be recorded against (`PLATFORM_DEFAULT_AUTHORIZES_SAME_MODEL_FAILOVER`) |
| Explicitly authorized cross-model fallback option | Oxy (policy + authorization), Relay (execution) | OxyHQServices + OxyHQ/Relay | contract only — expressible ONLY as a `cross_model` entry carrying `authorizedByPolicy: true`, and never for a request that pinned a revision; the edge emits no such entry, so no envelope it builds can express a cross-model substitution. Populating it needs each `inference_routing_policy_fallbacks` destination resolved to concrete deployments and re-filtered |
| Dedicated endpoint / capacity for enterprise accounts | Oxy (entitlement + candidate filter), Relay (capacity) | OxyHQServices `packages/api/src/services/inferenceCatalogue.service.ts:254,347,369` + OxyHQ/Relay | exists — `dedicated_capacity` is a real candidate FILTER, not merely a stored preference. The capacity itself is Relay's and is `unverified` from here |
| Routing-policy versioning; the request envelope and the receipt record a REFERENCE to the exact policy revision used, as provenance rather than as instructions | Oxy | OxyHQServices `packages/contracts/src/inference/routingPolicy.ts` (`routingPolicyReferenceSchema`) + `packages/api/src/db/schema/inferenceRoutingPolicyVersions.ts` + `usageReceipts.ts:181` (`routing_policy_version_id`) | exists |
| Customer-visible route-switch event/receipt | Oxy (emission to customer), Relay (source) | OxyHQServices `packages/api/src/db/schema/inferenceRouteSwitchEvents.ts` + `services/inferenceEdge.service.ts:157,1042` + OxyHQ/Relay | partial — the event is RECORDED: the table exists and the edge writes it. No customer-visible surface renders it yet, and the switch itself is the data plane's to report |
| Contradictory-policy validation | Oxy | OxyHQServices `packages/contracts/src/inference/routingPolicy.ts` | exists |
| Circuit breakers, health scoring, provider failover execution | Relay | OxyHQ/Relay | unverified — Relay-owned and not audited from here (rule 1); `planned` would claim Oxy owes something here, and it does not |

## 7. Financial ledger and billing (epic §7, ADR 0009)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| `user_credits` (balance keyed on `users.id`, `bigint` counts) | Oxy | OxyHQServices `packages/api/src/db/schema/userCredits.ts:58,65` | exists |
| `billing_transactions` (`amount_minor_units bigint`) | Oxy | OxyHQServices `packages/api/src/db/schema/billingTransactions.ts:154,179` | exists |
| `billing_subscriptions` (Stripe-written) | Oxy | OxyHQServices `packages/api/src/db/schema/billingSubscriptions.ts` | exists |
| `subscriptions` (legacy plan record, pre-Stripe) | Oxy | OxyHQServices `packages/api/src/db/schema/subscriptions.ts` | exists |
| `GET /credits`, `GET /credits/usage` | Oxy | OxyHQServices `packages/api/src/routes/credits.ts:56,85`, mounted `server.ts:648` | exists |
| Billing checkout / subscription / portal / transactions routes | Oxy | OxyHQServices `packages/api/src/routes/billing.ts:107-362`, mounted `server.ts:649` | exists |
| Stripe webhook endpoint | Oxy | OxyHQServices `packages/api/src/routes/billing.ts:362` | exists |
| Account (not user) as the billable principal | Oxy | OxyHQServices `packages/api/src/routes/accountBilling.ts`, mounted `server.ts` at `/billing/accounts` | exists |
| Billing profile for organization/project accounts | Oxy | OxyHQServices `packages/api/src/db/schema/billingProfiles.ts` + `services/accountBilling.service.ts` | exists |
| Child-project shared balance vs allocated budget decision | Oxy | OxyHQServices `docs/adr/0014-account-billing-and-entitlements.md` | exists |
| `price_versions` | Oxy | OxyHQServices `packages/api/src/db/schema/priceVersions.ts` | exists |
| `usage_reservations` | Oxy | OxyHQServices `packages/api/src/db/schema/usageReservations.ts` | exists |
| `usage_receipts` (immutable) | Oxy | OxyHQServices `packages/api/src/db/schema/usageReceipts.ts` | exists |
| `billing_ledger_entries` (double-entry or equivalently auditable) | Oxy | OxyHQServices `packages/api/src/db/schema/billingLedgerEntries.ts` | exists |
| Account balance projections / read models | Oxy | OxyHQServices `packages/api/src/db/schema/accountBalances.ts` | exists |
| Spending-limit / budget tables (account, project, application, credential) | Oxy | OxyHQServices `packages/api/src/db/schema/spendingLimits.ts` | exists |
| Invoice aggregation references | Oxy | OxyHQServices `packages/api/src/db/schema/billingInvoices.ts` + `services/accountInvoicing.service.ts` | exists |
| Prepaid balance, promotional grants, auto-recharge | Oxy | OxyHQServices `packages/api/src/services/accountBilling.service.ts`, `db/schema/billingAutoRechargeAttempts.ts` | exists |
| Invoiced enterprise accounts and credit limits | Oxy | OxyHQServices `packages/api/src/services/accountInvoicing.service.ts` | exists |
| Alert thresholds, hard-stop / soft-stop behaviour | Oxy | OxyHQServices `packages/api/src/services/spendingLimit.service.ts`, read surface `routes/accountBilling.ts` | exists |
| Reserve → settle → refund protocol | Oxy | OxyHQServices `packages/api/src/services/inferenceLedger.service.ts` | exists |
| Idempotency by stable request/event id | Oxy | OxyHQServices `packages/api/src/services/inferenceLedger.service.ts` | exists |
| Estimation/reconciliation when a provider omits usage | Oxy (settlement), Relay (measurement) | OxyHQServices + OxyHQ/Relay | planned |
| **What a metered unit MEANS** — the unit set partitions a request, so `cached_input_tokens` and `reasoning_tokens` are siblings of their parents and not details inside them. Oxy owns the definition because settlement prices every unit and sums; Relay owns the subtraction that turns a provider's nested counts into it. Re-verified 2026-08-16 (#1017) | Oxy (definition), Relay (normalisation) | OxyHQServices `packages/contracts/src/inference/money.ts` (`USAGE_UNITS`) + OxyHQ/Relay | exists |
| Stripe as payment/invoicing processor only | Stripe (external) | — | exists |
| `billing_external_payments` (the ONE ledger↔processor join) | Oxy | OxyHQServices `packages/api/src/db/schema/billingExternalPayments.ts` | exists |
| Ledger ↔ Stripe reconciliation + discrepancy report | Oxy | OxyHQServices `packages/api/src/services/billingReconciliation.service.ts`, `db/schema/billingReconciliation.ts` | exists |
| Account-scoped checkout and portal migration | Oxy | OxyHQServices `packages/api/src/services/stripeAccountBilling.service.ts` | exists (unverified against a live Stripe account) |
| Webhook idempotency audit for account billing | Oxy | OxyHQServices `packages/api/src/routes/billing.ts` + `services/__tests__/stripeAccountBilling.service.test.ts` | exists |
| Safe deletion of an account with live subscriptions or retained financial history | Oxy | OxyHQServices `packages/api/src/services/accountFinancialHolds.service.ts`, used by `routes/users.ts` | exists |
| Entitlement interface consumed by Alia product plans | Oxy | OxyHQServices `packages/api/src/services/entitlement.service.ts`, `GET /billing/accounts/:accountId/entitlements` | exists |
| Internal cost-center attribution (Alia, Codea, research, voice, evaluations) | Oxy | OxyHQServices `packages/api/src/db/schema/internalCostCenters.ts` + `routes/costCenters.ts` | exists (table empty; the five centres are workstream 14's to register) |
| Upstream provider cost measurement and reconciliation | Relay | OxyHQ/Relay | unverified — Relay-owned and not audited from here (rule 1); `planned` would claim Oxy owes something here, and it does not |
| Relay balance, quota counter or customer-visible credit | **forbidden** (ADR 0005 invariant 4) | — | must never exist |

## 8. Usage telemetry and reporting (epic §8)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| `api_key_usage_events` (append-only, 90-day retention) | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts:85`, retention constant `:78` | exists |
| `credits_used double precision` (telemetry only, never the ledger) | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts:118` | exists |
| `user_id` attribution | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts:96` | exists |
| `application_id` attribution | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts:110` | exists |
| `api_key_id` → `developer_api_keys` reference (obsolete) | Oxy | dropped by `packages/api/drizzle/0047_retire_developer_api_keys.sql`, together with the table it referenced | removed — asserted against the MIGRATED database in `packages/api/src/db/schema/__tests__/applications.test.ts`, because deleting the column from the TypeScript alone would leave every functional test green whether or not the migration ever ran |
| `account_id` column | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts` | planned — measured against the migrated schema rather than inferred: `api_key_usage_events` has no `account_id`. Same nuance as the row below, which this one was missing: `inference_usage_events.account_id` DOES exist, so inference attribution is not waiting on this, and whether general telemetry needs its own is workstream 8's call |
| `application_credential_id` attribution | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts` | planned — it does not "replace `api_key_id`", which is simply gone; `inference_usage_events` already carries credential attribution for inference, and whether this general-telemetry table needs its own is workstream 8's call |
| `request_id`, optional `generation_id` | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts` | planned — absent from `api_key_usage_events`. `inference_usage_events` carries both, so inference correlation is not waiting on this row either |
| Endpoint, status, latency columns | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts:112-120` | exists |
| Normalized unit totals (tokens/time/images, separate from money) | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceUsageEvents.ts` | exists — `inference_usage_events` carries `input_tokens`, `output_tokens`, `cached_input_tokens`, `reasoning_tokens`, `audio_input_milliseconds`, `audio_output_milliseconds`, `images`, `embeddings`, `characters` and `video_milliseconds`, and NO money column at all — the amount lives on `usage_receipts`, which is the separation this row asks for |
| Requested model, resolved model revision, customer-safe serving provider/deployment | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceUsageEvents.ts` | exists — `requested_model_reference`, `resolved_model_reference`, `serving_provider` and `deployment_id`, all four on `inference_usage_events` |
| Upstream wholesale cost kept out of customer responses | Relay | OxyHQ/Relay | unverified — Relay-owned and not audited from here (rule 1); `planned` would claim Oxy owes something here, and it does not |
| Telemetry retention separated from financial receipt retention | Oxy | OxyHQServices `packages/api/src/db/expiry.ts:263-268` | exists — ninety days of inference telemetry, with `usage_receipts`, `usage_refunds` and `usage_reservations` deliberately EXCLUDED from the sweep registry and the reason written beside them: a receipt swept on a telemetry schedule is a destroyed financial record |
| Aggregates by account, project, application, credential, model, provider, status, day | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceUsageDailyRollups.ts` | partial — `inference_usage_daily_rollups` aggregates by account, application, credential, `requested_model_reference`, `serving_provider`, `outcome`, `environment` and `day`. There is no PROJECT dimension of its own; a project is an account KIND, so say which reading is intended before treating this as closed |
| Customer-visible usage with documented eventual consistency | Oxy | OxyHQServices `packages/console/src/routes/_layout/usage.tsx:32,44,154` | exists — the page tags its own source `{ source: 'usage_telemetry_rollups', consistency: 'eventual' }` and says so to the reader in the empty state, rather than letting a lag read as a missing charge |
| Exact billed amount sourced from the ledger, not telemetry | Oxy | OxyHQServices `packages/api/src/services/inferenceReporting.service.ts:7,23,69` | exists — the reporting service reads `usage_receipts`; telemetry is never the money source |
| Enterprise reconciliation exports | Oxy | OxyHQServices `packages/api/src/routes/inferenceReporting.ts:518-521,954-960` | exists — CSV export, with its own rate limiter |
| Spend/token spike anomaly detection | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceSpendAnomalies.ts` + `server.ts:1188-1210` | partial — SPEND spike detection exists and runs: an hour's amount against a baseline median and a threshold multiple. TOKEN spike detection is absent at this revision |
| `GET /applications/:appId/usage` | Oxy | OxyHQServices `packages/api/src/routes/applications.ts:1440` | exists |

## 9. Oxy Console (epic §9)

There is **no second customer-facing console**; a Relay dashboard is forbidden by
ADR 0005 invariant 5.

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| Account switcher and account-derived access | Oxy | OxyHQServices `packages/console/src/hooks/use-account.tsx:138,178` | exists |
| Applications list and detail | Oxy | OxyHQServices `packages/console/src/routes/_layout/apps/` | exists |
| Per-app General | Oxy | OxyHQServices `packages/console/src/components/apps/general-section.tsx` | exists |
| Per-app Credentials | Oxy | OxyHQServices `packages/console/src/components/apps/credentials-section.tsx` | exists |
| Per-app Usage | Oxy | OxyHQServices `packages/console/src/components/apps/usage-section.tsx` | exists |
| Per-app Store / Updates | Oxy | OxyHQServices `packages/console/src/components/apps/store-section.tsx`, `updates-section.tsx` | exists |
| Models page (static catalogue today) | Oxy | OxyHQServices `packages/console/src/routes/_layout/models.tsx` | exists |
| Playground (posts to `/v1/chat/completions`) | Oxy | OxyHQServices `packages/console/src/routes/_layout/playground.tsx`, `hooks/use-playground.ts:133` | exists — but it posts to **`/v1/responses`**, not `/v1/chat/completions`. The feature is there; this row's parenthetical named the wrong endpoint |
| Usage page | Oxy | OxyHQServices `packages/console/src/routes/_layout/usage.tsx` | exists |
| Billing page | Oxy | OxyHQServices `packages/console/src/routes/_layout/billing/` (a directory since the page grew tabs: `index`, `spend`, `charges`, `budgets`, `plans`) | exists |
| Account settings page | Oxy | OxyHQServices `packages/console/src/routes/_layout/settings/account.tsx` | exists |
| Documentation and SDK pages | Oxy | OxyHQServices `packages/console/src/routes/_layout/documentation/` | exists |
| Members / account-settings management surface | Oxy | OxyHQServices `packages/console/src/routes/_layout/settings/account.tsx:144-147` | exists — members, active versus invited, and role labels |
| Per-app Inference overview | Oxy | OxyHQServices `packages/console/src/components/apps/inference-overview-section.tsx`, mounted at `routes/_layout/apps/$appId/inference.tsx:15` | exists |
| Per-app Usage and spend | Oxy | OxyHQServices `packages/console/src/components/apps/application-usage-spend-section.tsx`, mounted at `routes/_layout/apps/$appId/inference.tsx:18` | exists |
| Per-app Routing policy | Oxy | OxyHQServices `packages/console/src/components/apps/routing-policy-section.tsx` + `routing-policy-form.tsx`, mounted at `routes/_layout/apps/$appId/inference.tsx:16` | exists |
| Per-app Provider connections / BYOK | Oxy | OxyHQServices `packages/console/src/components/apps/provider-connections-section.tsx`, mounted at `routes/_layout/apps/$appId/inference.tsx:17` | exists |
| Per-app Limits and budgets | Oxy | OxyHQServices `packages/console/src/components/apps/application-budgets-section.tsx`, mounted at `routes/_layout/apps/$appId/inference.tsx:19` | exists |
| Per-app Webhooks / audit events | Oxy | OxyHQServices `packages/console/src/components/apps/provider-connections-section.tsx:628`, `components/apps/credentials-section.tsx`, `lib/credential-audit.ts` | partial — audit trails render for provider connections and, since #1053, for credentials. There is no per-app WEBHOOKS surface: `general-section.tsx:366-382` configures two webhook URLs, which is configuration rather than an event trail |
| Per-app environment-specific configuration | Oxy | OxyHQServices `packages/console/src/components/apps/credentials-section.tsx:72,136` | partial — credentials are environment-scoped (`credentials-section.tsx:72,136`) and the playground carries an environment. The per-app inference page has no environment dimension of its own |
| Real model catalogue rendering (ids, publishers, revisions, capabilities, regions, providers, data policy, prices) | Oxy | OxyHQServices `packages/console/src/routes/_layout/models.tsx` + `hooks/use-models.ts` | exists — renders the real catalogue read, which answers `[]` until the catalogue is written (§5). An empty list is the honest render, not an error state |
| Routing profiles rendered separately from models | Oxy | OxyHQServices `packages/console/src/routes/_layout/models.tsx:43,66` | exists — two tabs, with the reason in the comment: a profile is not a model |
| Catalogue filters (modality, tools, region, provider, price, data policy) | Oxy | OxyHQServices `packages/console/src/routes/_layout/models.tsx:28-33`, `lib/model-catalogue-filters.ts` | exists |
| Playground bound to active account/application and selected credential/environment | Oxy | OxyHQServices `packages/console/src/routes/_layout/playground.tsx:21-22,73,81`, `hooks/use-playground.ts:178` | exists |
| Post-run detail: request id, model revision, provider route, latency, units, billed amount | Oxy | OxyHQServices `packages/console/src/components/playground/playground-receipt.tsx:71-108` | partial — request id, model revision, provider route, routing policy, finish reason, generation id, metered units and billed amount all render. LATENCY does not: what is shown is a client-measured round trip, and the component says so rather than passing it off as the server's measurement |
| Balance split: purchased / promotional / reserved | Oxy | OxyHQServices `packages/console/src/components/billing/account-balance-card.tsx:111-119` | exists |
| Pending reservations and settled charges | Oxy | OxyHQServices `packages/console/src/routes/_layout/billing/charges.tsx:46-76` | exists — a reservation is shown as money HELD and not charged, which is the distinction the ledger draws |
| Spend by application / model / provider / time | Oxy | OxyHQServices `packages/console/src/routes/_layout/billing/spend.tsx:53,99-102` | exists — selectable dimensions |
| Budget creation and alerts | Oxy | OxyHQServices `packages/console/src/components/billing/budget-form-dialog.tsx:90,128,315-335`, `routes/_layout/billing/budgets.tsx` | exists — thresholds come from the closed set the column's CHECK admits, and each is recorded once per period so an alert does not re-fire on every request |
| Server-provided permission gating (no client role re-derivation) | Oxy | OxyHQServices `packages/console/src/hooks/use-applications.ts:283-291,348-361` | exists — the Console reads `callerMembership.permissions` as serialised by the server and re-derives no roles |
| Relay customer console | **forbidden** (ADR 0005 invariant 5) | — | must never exist |

## 10. BYOK provider connections (epic §10)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| Provider connection metadata (provider, owner account, application scope, environment, status) | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceProviderConnections.ts` | exists — `provider`, `owner_account_id`, `application_id`, `scope_kind`, `environment` and `status`, all in the migrated schema |
| Provider secret material in Vault/KMS/managed secret storage | Vault/KMS (Oxy-managed) | oxy-infra | unverified — the owner is not Oxy and the path is `oxy-infra`, so rule 1 applies: `planned` would claim Oxy owes something here, and Oxy's half (a reference, never the secret) is done |
| Secret *reference* stored in Postgres | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceProviderConnections.ts` (`secret_ref`) | exists — the column holds a reference; the secret itself never reaches Postgres (ADR 0013) |
| Environment/account encryption separation | Oxy | OxyHQServices `packages/api/src/services/inferenceProviderConnection.service.ts:555-565` | partial — the REFERENCE is partitioned by environment, owner account and connection id, and a partition CHECK enforces that the reference contains them. Whether the encryption KEY differs per environment and account is a secret-store fact this repository cannot settle |
| Safe prefixes / fingerprints / validation status in responses | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceProviderConnections.ts` | exists — `key_prefix`, `fingerprint`, `validation_state`, `validation_failure_code` and `last_validated_at`, and no response carries the secret |
| Credential validation via a dedicated provider check (never logged) | Relay | OxyHQ/Relay | unverified — Relay-owned and not audited from here (rule 1); `planned` would claim Oxy owes something here, and it does not |
| Rotation, replacement, immediate disable | Oxy | OxyHQServices `packages/api/src/routes/inferenceProviderConnections.ts:618,665,718` | exists |
| Audit log: create, validate, rotate, use, revoke | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceProviderConnectionAuditEvents.ts:123-126` | exists — the event vocabulary covers all five plus `disabled`/`enabled`, and the table is append-only (see §12) |
| Connection scope decision (account-wide / project-wide / application-only) | Oxy | OxyHQServices `docs/inference/byok.md:54,63,80` + `inference_provider_connections.scope_kind` | exists — the decision is recorded and the column implements it |
| Routing policy "prefer/require BYOK" | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceRoutingPolicyVersions.ts` (`byok_preference`) | exists — stored on the versioned policy and applied as a candidate filter |
| BYOK usage still produces Oxy usage receipts and platform-fee charges | Oxy | OxyHQServices `packages/api/src/db/schema/usageReceipts.ts` (`platform_fee_only`) + `schemas/inferenceEdge.schemas.ts:298-303` | exists — a BYOK request settles a receipt flagged `platform_fee_only`, so `billed_amount` is Oxy's fee rather than the cost of the tokens, and reporting and the CSV export both carry the flag |
| Provider-terms acknowledgement record | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceProviders.ts:76-115` + `inference_provider_connections.terms_acknowledged_at` | exists — and it is structural: a composite foreign key refuses an un-acknowledged connection for a provider whose terms require one, and refuses turning the requirement ON while such connections exist |
| BYOK secret in an application table | **forbidden** (ADR 0005 invariant 12) | — | must never exist |

## 11. Commercial permissions (epic §11)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| `availabilityScope` (`internal_alia`, `public_payg`, `enterprise`, `byok_only`, `oxy_hosted`) | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceDeployments.ts:168,291-294` | exists — the column's enum is taken from the contract's own zod enum rather than restated, so the column, the CHECK and the wire cannot disagree |
| `commercialPermission` (`standard_application_use`, `public_resale_approved`, `wholesale_contract`, `customer_byok`, `open_weight_hosting`) | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceDeployments.ts:169,295-298` | exists — same derivation from the contract |
| Public catalogue/routing block unless permission approved | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceDeployments.ts:172-174` + `services/inferenceCatalogue.service.ts:201` | exists — default DENY as a column default (`pending_review`) and ONE selectability predicate requiring `approved`, with no internal-routes-are-exempt branch |
| Contract/legal review status and evidence reference | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceDeployments.ts:186-198,359-374` | exists — and the CHECKs make the cheapest green the honest one: a route cannot be `approved` until its legal review is, and an approved review needs a non-blank evidence reference, tested with `length(btrim(...)) > 0` so an empty string cannot pass for one |
| Open-weight licence, attribution, acceptable-use requirements | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceModels.ts:151-162` | exists as columns — see §5's licence row for the fact that nothing writes them yet |
| Base-model attribution requirement for derived names | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceModels.ts:174` | exists — `base_model_attribution_required`, deliberately distinct from `requires_attribution`: some licences constrain what a fine-tune may be CALLED, separately from the right to serve it |
| "Available to Alia internally" vs "available to external customers" separation | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceDeployments.ts:168` (`availability_scope`), vocabulary in `packages/contracts/src/inference/catalogue.ts:165` | exists — the enum IS the separation (`internal_alia`, `public_payg`, `enterprise`, `byok_only`, `oxy_hosted`), and it is ENFORCED rather than merely stored: `services/inferenceCatalogue.service.ts:200` filters every catalogue read to the viewer's permitted scopes |
| Admin workflow: approve, restrict, suspend, retire a route | Oxy | OxyHQServices `packages/api/src/services/inferenceCatalogueAdmin.service.ts:37-44,123,182` + `routes/inferenceAdmin.ts:152,367,393` | exists — all four actions behind a staff gate, with the legal-review recording beside them |

## 12. Privacy, security, compliance (epic §12)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| No-user-IPs-at-rest invariant (platform-wide) | Oxy | OxyHQServices `packages/api/src/db/schema/securityActivities.ts:6-19`, `packages/api/src/utils/ipKey.ts` | exists |
| `security_activities` (account's own audit trail) | Oxy | OxyHQServices `packages/api/src/db/schema/securityActivities.ts` | exists |
| No prompt/response persistence by default | Oxy + Relay | OxyHQServices `docs/adr/0016-no-inference-payload-persistence.md`, `scripts/check-no-payload-persistence.mjs` + OxyHQ/Relay | exists for Oxy — no column in the schema can hold a prompt, a completion, a chat message body or a tool argument, enforced by a census over the drizzle barrel in the `Schema Payload Policy` CI job; for Relay, **unverified** — the repository exists and its payload handling has not been audited from here, which is a different claim from `planned` |
| Opt-in, time-limited, encrypted, audited debug payload retention | Oxy | OxyHQServices `docs/adr/0016-no-inference-payload-persistence.md` | refused, not planned — ADR 0016 makes the four properties PRECONDITIONS on building capture rather than follow-up work, and precondition 3 (a key Oxy does not hold in PostgreSQL) needs the same absent managed-secret backend as ADR 0013 |
| PII/redaction controls for opted-in traces | Oxy | OxyHQServices `docs/adr/0016-no-inference-payload-persistence.md` | blocked on the row above, and vacuous until then — no trace or span infrastructure exists in this repository, so there is nothing to redact PII from |
| Deployment policy fields (retention, training, region, subprocessors, ZDR) | Oxy (catalogue), Relay (truth) | OxyHQServices `packages/api/src/db/schema/inferenceDeployments.ts:155-164` + OxyHQ/Relay | exists as columns, enforced against a routing policy at `services/inferenceCatalogue.service.ts:432-443`; see §5 for the absent writer. The TRUTH of a route's policy is Relay's and is `unverified` from here |
| Deletion/export preserving legally required financial records | Oxy | OxyHQServices `packages/api/src/db/expiry.ts:263-269` + `routes/users.ts:1590-1617` | partial — the retention side is done: financial tables are excluded from the telemetry sweep, with the reason recorded. Whether an EXPORT of those records exists for a deletion request is not established here |
| Secret-scanning and accidental-serialization tests | Oxy | OxyHQServices `scripts/check-secret-scan.mjs` (scanning), `packages/api/src/services/__tests__/inferenceProviderConnection.service.test.ts` (serialization) | exists — twelve issued-token grammars plus a tracked-dotenv refusal over every tracked file, in the `Secret Scan` CI job, each rule verified against its own sample on every run; the serialization half walks a returned DTO to every leaf, its `JSON.stringify`, its exact key set, every stored column and the audit trail, with a positive control proving the credential really passed through |
| Rotation runbooks and break-glass procedures | Oxy (credentials Oxy issues), infra (AWS) | OxyHQServices `docs/runbooks/` + oxy-infra `docs/runbooks/` | exists for the five credential classes Oxy issues — application credential, `oxy_sk_…` machine key, BYOK provider connection, the token signing keys, and the Oxy→Relay edge signing key (that one written against ADR 0015 and pending it); `planned` for the AWS half, which is oxy-infra's and is deliberately not duplicated here |
| Immutable audit events for credential, billing, routing, provider-connection changes | Oxy | OxyHQServices `packages/api/src/db/schema/applicationCredentialAuditImmutability.ts`, `ledgerImmutability.ts`, `accountBillingImmutability.ts`, `inferenceRoutingImmutability.ts`, `inferenceProviderConnectionImmutability.ts` | exists — all four domains: `application_credential_audit_events`, `billing_ledger_entries`, `inference_routing_policy_versions` and `inference_provider_connection_audit_events`, each with its immutability enforced by a trigger rather than by convention |
| Staff vs customer action distinction in audit | Oxy | OxyHQServices `packages/api/src/db/schema/billingLedgerEntries.ts:249,316-318`, `inferenceProviderConnectionAuditEvents.ts:144,300-303` | partial — `actor_kind` + `actor_user_id` exist on TWO of the four audit surfaces, each with a CHECK pairing the kind against the presence of a user id. `application_credential_audit_events` carries `actor_user_id` and NO kind, and `inference_routing_policy_versions` only `created_by_user_id`. A null `actor_kind` means "written before the column existed", which is why both CHECKs are written with `is not distinct from` |
| Least-privilege admin roles | Oxy | OxyHQServices `packages/api/src/routes/inferenceAdmin.ts:6,51` | exists — every catalogue-admin action is behind a staff capability gate, and the staff-only application fields are gated separately |
| Rate limits and fraud controls before prepaid public inference | Oxy | OxyHQServices `packages/api/src/routes/inferenceEdge.ts:128-131` and the limiter in each `routes/inference*.ts` | partial — the limiters this row's earlier note called planned now EXIST: ten of them, each with its own `rl:inference:*` prefix, including `rl:inference:edge:` on the public edge. Fraud controls beyond those and the spend-anomaly detector (§8) do not |
| Privacy/security review gate for public launch | Oxy | OxyHQServices `docs/inference/rollout.md:25,85-89` (`INFERENCE_PRIVACY_REVIEW`) | exists — the GATE is built and fails CLOSED: a public audience with no review recorded resolves closed with the reason `public_requires_privacy_review`. The review itself is unrecorded, which is an open decision rather than a missing mechanism |
| Signed Alia model release manifest ingestion contract | Oxy (ingest), Alia (issuer) | OxyHQServices `packages/contracts/src/inference/aliaModelRelease.ts` | partial — the CONTRACT ships, which is what the epic's box asks for ("define an ingestion contract"). No INGEST exists: a census over non-test `packages/api/src` finds zero references to it, so nothing can accept a manifest yet |
| Model card, licence, provenance, evaluation, safety results, artifact digests | Alia (produces), Oxy (stores/publishes) | OxyHQServices `packages/api/src/db/schema/inferenceModelRevisions.ts:110-129`, `inferenceModels.ts:151-187`, `inferenceModelEvaluations.ts` | partial — all six are STORABLE today (model card url, licence block, release kind plus base model, the evaluations child table, the safety group, `artifact_digest`). What is missing is a path that ACCEPTS them: no HTTP route and no writer outside the publisher seed (§5) |
| EU AI Act / GPAI documentation metadata | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceModelRevisions.ts:121-129`, `inferenceModels.ts:178-187` | partial — the FIELDS the regime expects beside a served model exist (safety metadata, model card, provenance, licence). There is no dedicated GPAI documentation artifact, and the only textual reference to the regime in the repository is a doc comment in `packages/contracts/src/inference/catalogue.ts:214` |
| Content-provenance / marking metadata | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceModelProvenance.ts` + `drizzle/0050_inference_model_provenance_marking.sql` | exists — `provenance_marking` on a revision, and two triggers make an unmarked revision under a non-text-output model unreachable from either direction: inserting or updating the revision, and widening the model's output modalities afterwards. `text` is the only exemption, and `none` counts as a declaration |

## 13. Relay data plane (epic §13 — external dependency)

**The repository EXISTS** — re-verified 2026-08-17 (`OxyHQ/Relay`: public,
non-empty, Go, last pushed 2026-08-16). The previous note here said it did not,
which was true on 2026-08-15.

Every row below is `unverified` EXCEPT the repository row itself, which is
`exists`: each of the others describes what is built INSIDE an external
repository, and nothing in this document has read it. `planned` would assert
absence, which is an unsupported claim now that the repository is there; `exists`
would assert presence, which is equally unsupported. The repository row is the
exception because its evidence — `gh repo view` — is obtainable without auditing
any contents. Whoever closes the rest should audit that repository and say so.

Workstream 13 remains an external dependency of this epic, and none of
workstreams 0–12 may block on it.

| Item | Owner | Repo | Status |
|---|---|---|---|
| Relay repository and ownership model | Relay | [OxyHQ/Relay](https://github.com/OxyHQ/Relay) | **exists** — `gh repo view OxyHQ/Relay` on 2026-08-17: PUBLIC, non-empty, primary language Go, last pushed 2026-08-16. This is the one row in this section whose evidence can be gathered from outside the repo without auditing its contents (rule 1), which is why it is `exists` while its siblings are `unverified` |
| High-concurrency streaming data plane | Relay | OxyHQ/Relay | unverified — external repository, not audited from here |
| Provider adapter interface (translation, streaming, cancellation, usage normalization, errors, health) | Relay | OxyHQ/Relay | unverified — external repository, not audited from here |
| Provider adapters migrated out of Alia | Relay | OxyHQ/Relay | unverified — external repository, not audited from here |
| Same-model deployment fallback, circuit breakers, health scoring | Relay | OxyHQ/Relay | unverified — external repository, not audited from here |
| Cross-model fallback, only when Oxy policy allows | Relay | OxyHQ/Relay | unverified — external repository, not audited from here |
| Configuration snapshots for control-plane outage | Relay | OxyHQ/Relay | unverified — external repository, not audited from here |
| Technical usage receipts with stable request/event ids | Relay | OxyHQ/Relay | unverified — external repository, not audited from here |
| Provider-cost measurement and reconciliation | Relay | OxyHQ/Relay | unverified — external repository, not audited from here |
| Oxy-hosted deployments on established runtimes (vLLM/SGLang) | Relay | OxyHQ/Relay | unverified — external repository, not audited from here |
| Orchestration (e.g. KServe), only when scale justifies it | Relay | OxyHQ/Relay | unverified — external repository, not audited from here |
| Internal health/status exposure to Oxy (no secrets, no unsafe route detail) | Relay | OxyHQ/Relay | unverified — external repository, not audited from here |
| Per-provider conformance tests before public availability | Relay | OxyHQ/Relay | unverified — external repository, not audited from here |

## 14. Alia integration (epic §14)

| Item | Owner | Repo | Status |
|---|---|---|---|
| Alia registered as an Oxy first-party/internal Application under the correct account | Oxy (registry), Alia (consumer) | production registry | unverified — settled by reading the production `applications` row, not the repo |
| Separate development / staging / production credentials for Alia | Oxy | production registry | unverified — settled by reading production `application_credentials` rows |
| Inference scopes granted to Alia | Oxy | OxyHQServices `packages/api/src/utils/applicationScopes.ts:83-89` | unverified — the scope VOCABULARY exists; whether Alia's application holds those grants is production data, which is the same class of fact this file marks `unverified` elsewhere |
| Alia delegating an end-user id while billing the Alia account/cost center | Oxy | OxyHQServices `packages/api/src/routes/inferenceEdge.ts:261-266` + `db/schema/inferenceUsageEvents.ts` (`delegated_user_id`) | exists — the header is parsed and length-bounded, the delegated id is recorded on the usage event and the receipt, and the BILLING principal stays the caller's own account (ADR 0007) |
| Internal cost centers: Alia production chat, Codea, research, voice, evaluations | Oxy | OxyHQServices `packages/api/src/db/schema/internalCostCenters.ts` + `scripts/internalCostCenterSpecs.ts:85,93,99,105,111` | exists — the table plus all five specifications, each addressed by a slug that IS the project account's username |
| Entitlement/billing API consumed by Alia product plans | Oxy | OxyHQServices `packages/api/src/routes/accountBilling.ts:88,816`, `routes/costCenters.ts:46`, `packages/contracts/src/inference/entitlement.ts` | exists — the contract and the routes. Whether Alia consumes them is Alia's half and is `unverified` from here |
| Removal of the static Oxy→Alia infrastructure proxy | Oxy | OxyHQServices `packages/api/src/routes/alia.ts` | planned — **a removal row, so this means the proxy is STILL LIVE** (rule 2). All three of its routes are mounted and now gated by `requireFirstPartyInferenceCaller`; see §3.1. Workstream 14 owns retiring them |
| Deprecation of Alia-owned developer keys, provider billing, generic `/v1` endpoints | Alia | Alia repo | unverified — **a removal row on a non-Oxy owner**, which is what rules 1 and 2 together make of it: `planned` would claim Oxy owes something, and no reading of it would say whether Alia has done the work. `alia_sk_…` keys are still Alia-issued as far as this repository can see, and that is the limit of what it can see |
| Alia assistant product, conversations, memory, agents, tools, approvals | Alia | Alia repo | exists (outside this repo) |

## 15. SDKs and documentation (epic §15)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| `@oxyhq/core` client SDK | Oxy | OxyHQServices `packages/core` | exists |
| Typed inference methods on `@oxyhq/core` | Oxy | OxyHQServices `packages/core/src/inference/OxyInferenceClient.ts` | exists — catalogue reads, `respond()` and `getGeneration()`. No `stream()`: the edge refuses `stream: true`, so a method that could only fail would be a worse artefact than an absent one |
| Machine-credential lifetime and rotation-grace options on the SDK | Oxy | OxyHQServices `packages/core/src/mixins/OxyServices.accounts.ts` | exists — `createAppCredential({expiresInSeconds})` and `rotateAppCredential(…, {graceSeconds})`; the API accepted both since epic §2.3, the SDK could not send either |
| TypeScript SDK surface accepting both Oxy auth and OpenAI-style keys | Oxy | OxyHQServices `packages/core/src/inference/OxyInferenceClient.ts`, `packages/core/src/mixins/OxyServices.inference.ts` | exists — one client, one `credential` that is a static `oxy_sk_*` string or a function returning an Oxy bearer. `oxyServices.inference()` binds the session lane; the mixin declares no request of its own, so there is one spelling of each call. `packages/api/src/schemas/__tests__/sdkRequestCompatibility.test.ts` fails the build if the request type and the edge schema drift |
| Python SDK or generated client | Oxy | new repo | planned, and deliberately NOT started — the epic §4 contract has not stabilised: no endpoint serves a request, streaming has no wire format at the edge, and the catalogue that decides what `model` may say is empty. Reasoning in `docs/inference/sdk.md` |
| `docs/SERVICE_TOKENS.md` (native service-token flow) | Oxy | OxyHQServices `docs/SERVICE_TOKENS.md` | exists |
| Console authentication page (documents `oxy_dk_*` as the public client id, and names the two mechanisms that do authenticate) | Oxy | OxyHQServices `packages/console/src/routes/_layout/documentation/authentication.tsx` | exists — corrected in epic §2.1; the bearer-secret framing it used to carry is gone |
| Console quickstart / chat-completions / SDK pages | Oxy | OxyHQServices `packages/console/src/routes/_layout/documentation/` | exists |
| Static machine API-key flow documentation | Oxy | OxyHQServices `docs/inference/credentials.md` | exists — creation, one-time token display, environments, opt-in rotation grace, revocation, audit and limits, and that **no endpoint accepts one yet** (epic §4 mounts it) |
| A bare `oxy_dk_*` is refused on every lane requiring a secret or a bearer | Oxy | OxyHQServices `packages/api/src/routes/__tests__/publicIdentifierNotASecret.test.ts`, `packages/api/src/middleware/__tests__/publicIdentifierNotABearer.test.ts` | exists — 4 lanes, each rejection paired with a positive control |
| Native service-token flow, as one of the three credential lanes | Oxy | OxyHQServices `docs/inference/credentials.md` | exists — frames the lane and defers to `docs/SERVICE_TOKENS.md`, which stays authoritative for the claim set (epic §2.2) |
| Attribution documentation (account/application/credential) | Oxy | OxyHQServices `docs/inference/attribution.md` | exists |
| Streaming, cancellation, retry documentation | Oxy | OxyHQServices `docs/inference/streaming.md` | exists — the CONTRACT for all three, plus which parts cannot be observed. No endpoint streams; an abandoned request today answers `service_unavailable` rather than `cancelled`, because the no-data-plane classification is checked first. Retries and idempotency ARE live and are documented as such |
| Model vs deployment vs routing profile documentation | Oxy | OxyHQServices `docs/inference/catalogue.md` | exists |
| Routing controls and fallback semantics documentation | Oxy | OxyHQServices `docs/inference/routing.md` | exists — every control, with an explicit split between the eleven filtered against the candidate routes since [#1012](https://github.com/OxyHQ/oxy/pull/1012) (and the `policy_violation` refusal when none qualifies), the fallback authorisation, and the three that are not enforced — the two price ceilings, which need a different mechanism, and `optimiseFor`, which is a ranking the data plane owns |
| Exact billing / reservations / usage-dashboard documentation | Oxy | OxyHQServices `docs/inference/billing.md` | exists — including why dashboard usage is eventually consistent while the billed amount comes from the ledger, and the `/inference/reporting` surface |
| BYOK behaviour and limits documentation | Oxy | OxyHQServices `docs/inference/byok.md` | exists — the metadata Oxy holds, the endpoints that work, the `503 provider_secret_store_unavailable` on create/rotate, why the refusal beats a Postgres column, and the three things that would wire a store |
| Data retention and regional policy documentation | Oxy | OxyHQServices `docs/inference/data-policy.md` | exists — what Oxy retains and for how long (including that neither the 90-day telemetry sweep nor the reservation-expiry sweep is scheduled), the no-user-IP invariant, the per-route `dataPolicy` fields, and the residency/retention routing controls, which ARE enforced against the candidate routes since [#1012](https://github.com/OxyHQ/oxy/pull/1012) — subset-not-overlap for regions, actually-not-retaining for zero retention |
| Migration guides for `chat:completions`, `models:read`, `alia_sk_*`, `oxy_dk_*` | Oxy | OxyHQServices `docs/inference/migration.md` | exists — `alia_sk_*` established as an Alia-issued key with zero references in this repo, cited to the Alia repo; plus the Alia proxy's move from `/v1/chat/completions` to `/alia/chat/completions` |
| Status board naming what is NOT built and what tracks it | Oxy | OxyHQServices `docs/inference/README.md` | exists |
| Published deprecation and sunset dates | Oxy | OxyHQServices `docs/inference/deprecation.md` | policy written, no date published, and none invented. Notice windows are relative to events rather than calendar dates, and are PROPOSED pending the owner's confirmation. Nothing an external developer can reach has been deprecated; the things retired so far did nothing, and each is recorded with why no notice was owed |

## 16. Testing, observability, rollout (epic §16)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| Oxy↔Relay schema compatibility tests | Oxy + Relay | OxyHQServices `packages/contracts/src/__tests__/inference.compatibility.test.ts` + OxyHQ/Relay | partial — Oxy's half exists (frozen version map with exact equality, a `readdirSync` census so a new contract file cannot hide, a frozen union list, a round-trip fixture per shape). The cross-repo half is `unverified` |
| Attribution tests (account/application/credential) | Oxy | OxyHQServices `packages/api/src/services/__tests__/attribution.service.test.ts` | exists |
| Scope and RBAC tests | Oxy | OxyHQServices `packages/api/src/routes/__tests__/inferenceEdgeCredentialLanes.test.ts`, `accountsMemberPermissions.test.ts`, `applicationPermissionOverrides.test.ts`, `accountBillingAuthorization.test.ts` | exists |
| Credential create/rotate/revoke/expiry tests | Oxy | OxyHQServices `packages/api/src/routes/__tests__/machineCredentials.test.ts:370-535`, `credentialAuditTrail.test.ts`, `serviceTokenCredentials.test.ts` | exists — including the inference cases this row's earlier note called planned: the machine token is returned exactly once, the stored hash is asserted never to be the plaintext WITH a control proving that check can fail, an unscoped or over-scoped credential is refused, and an expired one is refused on the bearer lane |
| Reservation/settlement/refund/idempotency tests | Oxy | OxyHQServices `packages/api/src/services/__tests__/inferenceLedger.service.test.ts` | exists — reserve → settle → refund against a REAL Postgres, with the interleavings FORCED by a second reserved connection and the contender observed BLOCKED, rather than hoping a race reproduces |
| Price-version snapshot tests | Oxy | OxyHQServices `packages/api/src/services/__tests__/inferenceLedger.service.test.ts:43` + `db/schema/__tests__/inferenceLedger.test.ts` | exists |
| Cross-account isolation tests | Oxy | OxyHQServices `packages/api/src/routes/__tests__/inferenceRoutingPolicies.test.ts:462,485,1088`, `inferenceProviderConnections.test.ts` | exists |
| Commercial-permission route filtering tests | Oxy | OxyHQServices `packages/api/src/routes/__tests__/inferenceCataloguePublication.test.ts:199` | exists |
| Retention-policy filtering tests | Oxy | OxyHQServices `packages/api/src/services/__tests__/inferenceRoutingConstraints.test.ts:170,210,245` | exists — including the subtle case: a route offering zero retention as a CAPABILITY while still retaining is excluded |
| E2E: non-streaming, SSE streaming, disconnect-cancels, same-model failover, forbidden cross-model fallback | Oxy + Relay | OxyHQServices `packages/api/src/routes/__tests__/relayStreaming.test.ts`, `inferenceEdge.test.ts`, `inferenceEdgeRouteSwitchEvents.test.ts` + OxyHQ/Relay | exists against the injected data-plane fake, which is what makes these runnable with no Relay. End to end against a live Relay is a different claim and is `unverified` |
| E2E: Alia service token with delegated user, external machine key, BYOK route | Oxy + Relay | OxyHQServices `packages/api/src/routes/__tests__/inferenceEdgeCredentialLanes.test.ts:4-28` | partial — that file states in its own header which halves it covers: the delegated user IS covered on the machine lane, and what is not is that the delegated user is never the BILLING principal on that lane |
| E2E: insufficient balance, partial stream settlement, retry with no duplicate charge, rotation during traffic | Oxy | OxyHQServices `packages/api/src/routes/__tests__/inferenceEdgeRollout.test.ts:847`, `relayStreaming.test.ts`, `services/__tests__/inferenceLedger.service.test.ts` | exists — the refusal is asserted on the error CODE (`insufficient_balance`), not on a phrase |
| `requestId` correlation across edge, Relay, ledger and receipt | Oxy + Relay | OxyHQServices `packages/api/src/routes/__tests__/inferenceEdge.test.ts:424,623` + OxyHQ/Relay | exists for Oxy's three hops (edge → ledger → receipt); the Relay hop is `unverified` |
| Metrics: request rate, error rate, TTFT, total latency, cancellation, fallback | Oxy + Relay | OxyHQServices `packages/api/src/services/inferenceMetrics.service.ts:24,32,318` + OxyHQ/Relay | exists on Oxy's side; whether Relay emits its half is `unverified` |
| Metrics: reserve failures, settlement lag, reconciliation drift | Oxy | OxyHQServices `packages/api/src/services/inferenceMetrics.service.ts:345-347` | exists |
| Alerts: ledger imbalance, duplicate event ids, provider error/cost spikes | Oxy | OxyHQServices + oxy-infra | planned |
| Audit dashboards for credential and billing changes | Oxy | OxyHQServices `packages/console/src/components/apps/credentials-section.tsx`, `lib/credential-audit.ts` | partial — the CREDENTIAL trail renders since #1053, and it derives attribution from the event type rather than from a null actor id, which is the correct reading for that table. There is no BILLING audit dashboard |
| Status-page signals from customer-safe model/deployment availability | Oxy (surface), Relay (source) | OxyHQServices + OxyHQ/Relay | planned |
| Feature flags for new auth, API edge, ledger, catalogue | Oxy | OxyHQServices `packages/api/src/config/rolloutFlags.ts` | exists |
| Rollout-flag readout (`GET /inference/admin/rollout`) | Oxy | OxyHQServices `packages/api/src/routes/inferenceAdmin.ts` | exists |
| Shadow technical metering before charging | Oxy | OxyHQServices `packages/api/src/services/inferenceEdge.service.ts` | exists |
| Bounded dual-read/dual-write migration window | Oxy | OxyHQServices `docs/inference/rollout.md` | not applicable — every table is new and holds no production rows, so there is no store to cut over from |
| Canaries: internal Alia, Oxy first-party, closed external beta | Oxy | OxyHQServices `packages/api/src/config/rolloutFlags.ts` | mechanism exists, no stage entered |
| Rollback plan preserving financial-event integrity | Oxy | OxyHQServices `docs/inference/rollout.md` | exists |

---

## Maintaining this matrix

- **An item in neither this matrix nor a stated not-applicable line FAILS the
  review.** A gate that silently skips what is missing from a hand-maintained map
  is not a gate; being absent from both lists is not permission to place a fact
  wherever is convenient.
- **`exists` is a claim about a path, and it is re-verified when the path
  changes.** A row whose path no longer resolves is a defect in this file, not a
  detail.
- **`unverified` must name what would settle it**, and must not be used where the
  repo can answer the question.
- **New tables, events and API surfaces are added here in the same PR that adds
  them**, with their owner, not afterwards.
- **The PR that SHIPS a thing edits its row in the same change.** This is the rule
  the file was missing, and its absence is measurable: on 2026-08-18 a per-row
  audit found **97 of the 111 `planned` rows wrong** — 71 fully shipped, 23
  partial, 3 that rule 1 makes `unverified`. Three separate audits have now
  rediscovered overlapping subsets of the same rows, because nothing forces a
  revisit when work lands. A `planned` row is the one that rots; an `exists` row
  rots only when something is deleted, which is rarer.
- **A JUDGED row cites its subject, never an ANCESTOR of it.** A path cell reading
  `packages/api/src` or `packages/console` beside `exists`, `partial` or
  `contract only` is satisfied by the repository existing, so it confirms nothing
  and can never be refuted — which is how ten §5 rows survived two reviews. Cite
  `file.ts:line`; a directory is right only where the row's SUBJECT is a directory
  or a package (`@oxyhq/contracts`, `docs/runbooks/`, a route folder), and a bare
  ancestor is acceptable only on a `planned` or `unverified` row, where it names
  the intended home of something absent. No judged row cites an ancestor as of
  2026-08-18; the eight citing a directory each have one as their subject.
- **A row with two owners gets two rows.** One status cannot describe both halves
  of an Oxy/Relay item: whichever half a reader has in mind, the single word is
  wrong about the other. Rows 393 and 399 were split for this reason on
  2026-08-18.
- **Re-measure a status immediately before WRITING it. An audit's finding has a
  shelf life, and the gap between measuring and writing is where the staleness
  enters this file.** Not a theoretical hazard: the 2026-08-18 pass measured "no
  Console credential-audit surface, census zero", which was TRUE when measured
  and FALSE by the time it was written, because #1053 landed in between — a
  rebase caught it, and writing the document from the audit notes would have
  shipped an already-wrong claim into the very file whose defect is stale
  statuses. Then it happened again in the other direction within hours: #1055
  shipped `/v1/audio/speech` and `/v1/images/generations` and edited neither row,
  so two rows this file had just re-verified went stale the same day. Rebase onto
  the current remote tip and re-run the specific check for every row you are
  about to touch — not the whole audit, just the rows in the diff.
