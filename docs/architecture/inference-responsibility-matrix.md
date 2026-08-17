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
| `account_credentials` — a second credential table that authenticated nothing | Oxy | dropped by `packages/api/drizzle/0048_retire_account_credentials.sql` | removed — see §1.1 below |
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
| Shared-secret vs asymmetric/JWKS cross-repo verification decision | Oxy | OxyHQServices `docs/` | planned |
| `APPLICATION_SCOPES` vocabulary | Oxy | OxyHQServices `packages/api/src/utils/applicationScopes.ts:61` | exists |
| `chat:completions`, `models:read` scopes | Oxy | dropped by `packages/api/drizzle/0031_inference_scope_family.sql`, which rewrote every stored row to a successor | removed — **not aliased**, deliberately: neither name was ever read by any middleware, route or service, so an alias would have been a second way to spell a no-op (`packages/api/src/utils/applicationScopes.ts:41-46`) |
| `inference:invoke`, `inference:models:read`, `inference:usage:read`, `inference:routing:read`, `inference:routing:write`, `inference:providers:read`, `inference:providers:write` | Oxy | OxyHQServices `packages/api/src/utils/applicationScopes.ts:83-89` | exists |
| Credential scopes intersected with application scopes | Oxy | OxyHQServices `packages/api/src/routes/auth.ts:3660-3662` | exists |
| Privileged / staff-approval scope list | Oxy | OxyHQServices `packages/api/src/utils/applicationScopes.ts:184` (`PRIVILEGED_APPLICATION_SCOPES`, including both inference writes) | exists |
| Account/application RBAC mappings for inference, usage, routing, BYOK, billing | Oxy | OxyHQServices `packages/api/src/utils/accountRoles.ts` | partially enforced as of this revision — every one of those routes IS gated, but by REUSED generic permissions (`account:read`/`account:update`, `app:read`/`app:update`, `billing:read`/`billing:manage`, `usage:read`); there is no inference-specific permission, so an account cannot grant "edit this app" without also granting "repoint where inference is served from". A separate pull request is landing the inference-specific vocabulary; it is not merged at this revision and this row is what is true without it |
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
| `POST /v1/embeddings` | Oxy | OxyHQServices `packages/api/src/routes` | planned |
| `POST /v1/images/generations` | Oxy | OxyHQServices `packages/api/src/routes` | planned |
| `POST /v1/audio/transcriptions`, `POST /v1/audio/speech` | Oxy | OxyHQServices `packages/api/src/routes` | planned |
| `POST /v1/rerank` | Oxy | OxyHQServices `packages/api/src/routes` | planned |
| `POST /v1/batches` | Oxy | OxyHQServices `packages/api/src/routes` | planned |
| `GET /models/stats` (static catalogue; retired by ADR 0008) | Oxy | `routes/models-stats.ts` was DELETED with the catalogue landing (#982); `/models` is now served by `routes/inferenceCatalogue.ts` (`server.ts:715`) | removed |
| Edge attribution resolution before forwarding | Oxy | OxyHQServices `packages/api/src/services/inferenceEdge.service.ts:310` (`resolveCredentialAttributionById`) | exists |
| Edge scope authorization before forwarding | Oxy | OxyHQServices `packages/api/src/services/inferenceEdge.service.ts:520-525` (`inference:invoke`) | exists |
| Spend reservation before the data plane | Oxy | OxyHQServices `packages/api/src/services/inferenceEdge.service.ts` (step 6, `reserve`) | exists |
| Streaming pass-through without buffering | Oxy | OxyHQServices `packages/api/src/services/httpRelayClient.ts` (SSE, both dialects) | exists |
| Client-cancellation propagation to Relay and upstream | Oxy → Relay | OxyHQServices `packages/api/src/services/httpRelayClient.ts:239-241` (`AbortController`, client signal → hop abort) | **Oxy half exists** (#1034) — whether Relay propagates the cancellation upstream is unaudited from here; the repository exists, so this is "not looked at", not "absent" |
| Normalized rate-limit and usage headers | Oxy | OxyHQServices `packages/api/src` | planned |
| Idempotency keys for non-streaming / batch-safe operations | Oxy | OxyHQServices `packages/api/src` | planned |
| Request-size, context-size, output-token limits | Oxy | OxyHQServices `packages/api/src` | planned |
| Abuse / fraud / anomaly controls before public launch | Oxy | OxyHQServices `packages/api/src` | planned |

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
| Schema-version compatibility tests (Oxy ↔ Relay) | Oxy + Relay | OxyHQServices + OxyHQ/Relay | planned — the only row here still absent from `OxyHQ/oxy`, and it is a CROSS-REPO suite, so Oxy building its half alone would not close it |

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

**Thirteen rows in this section are still `planned` and were NOT judged**, on
purpose. They are FIELD-level claims — knowledge cutoff, provenance, licence,
capability flags, model card, deprecation pointer — and the six TABLE-level rows
above them are now `exists` because the tables are present in
`meta/0049_snapshot.json` and in production. A table existing says nothing about a
column, so settling the thirteen needs a per-column read of
`inferenceModels.ts` / `inferenceModelRevisions.ts` / `inferenceDeployments.ts`.

That distinction is not pedantic; it is the trap that produced a false lead during
this review. A check that asked "does the file this row names exist?" flagged three
rows about `api_key_usage_events` — and the columns those rows name
(`account_id`, `application_credential_id`, `request_id`, `generation_id`) are
absent from that file, so all three were correctly `planned` and the check was
measuring the wrong thing. Ask of it what it would report if the feature were
absent: exactly what it did report, because the file exists either way.


| Item | Owner | Repo / path | Status |
|---|---|---|---|
| Static `alia-lite` / `alia-v1` / `alia-v1-pro` / `alia-v1-pro-max` array (retired) | Oxy | OxyHQServices `packages/api/src/routes/models-stats.ts` | **gone** — the file was deleted with the catalogue landing (#982). Every surviving occurrence of the four names is enumerated in `docs/inference/migration.md` |
| Same fake ids in Console model docs | Oxy | OxyHQServices `packages/console/src/routes/_layout/documentation/models.tsx:13-43` | exists |
| Same fake ids in quickstart / chat-completions examples | Oxy | OxyHQServices `packages/console/src/routes/_layout/documentation/quickstart.tsx:127`, `documentation/chat-completions.tsx:109` | exists |
| Playground default model string | Oxy | OxyHQServices `packages/console/src/routes/_layout/playground.tsx:103` | exists |
| `AI_LABELING_MODEL` default `alia-lite` (internal consumer) | Oxy | OxyHQServices `packages/api/src/config/email.config.ts:100` | exists |
| `Publisher` descriptor | Oxy | OxyHQServices `packages/api/src/db/schema/inferencePublishers.ts` | exists — table present in the migrated schema (`meta/0049_snapshot.json`) and in production (0 rows) |
| `Model` descriptor, canonical id `<publisher>/<model>` | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceModels.ts` | exists — table present in the migrated schema and in production (0 rows) |
| `ModelRevision` (immutable), id `<publisher>/<model>@<revision>` | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceModelRevisions.ts` | exists — table present in the migrated schema and in production (0 rows) |
| `InferenceProvider` identity | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceProviders.ts` | exists — table present in the migrated schema and in production (0 rows) |
| `Deployment` / endpoint identity and region | Relay (health/availability); Oxy (customer-safe projection) | OxyHQ/Relay + OxyHQServices | planned |
| `RoutingProfile` (`auto`, `fast`, `quality`, customer-defined) | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceRoutingProfiles.ts` | exists — table present in the migrated schema and in production (0 rows) |
| Capability fields (tools, vision, audio, structured output, reasoning, context, max output, caching, modalities) | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Publisher and model licence | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Provenance / base model | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Knowledge cutoff and release date | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Regions and deployment providers | Relay (truth); Oxy (projection) | OxyHQ/Relay + OxyHQServices | planned |
| Data-retention and training-on-customer-data policy | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Zero-data-retention availability | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Customer pricing by unit and price version | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Deprecation status and replacement pointer | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Model card, evaluation summary, safety metadata | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Upstream provider secrets, internal route ids, wholesale cost | Relay — **never exposed** to customers (ADR 0006) | OxyHQ/Relay | planned |
| `alia/*` namespace, reserved for real Alia-owned releases | Alia (publisher), Oxy (registry) | OxyHQServices `packages/api/src/db/schema` | planned |
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
`authorizedByPolicy: true`. **The field is OPTIONAL and the edge does not populate
it yet**, so the two fallback rows below are `contract only`: absent means no
failover is authorized, which is the behaviour the data plane already has. The
populating change is a follow-up in `inferenceEdge.service.ts`.

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
| Maximum customer price per unit/request — stored, versioned, pinned on the receipt, enforced by NEITHER side (named inert in `UNFILTERED_ROUTING_CONTROLS`, issue #1011) | Oxy | OxyHQServices `packages/api/src/db/schema` | exists |
| Sort by price / latency / throughput / balanced — the one routing decision the data plane makes | Oxy (policy), Relay (execution) | OxyHQServices + OxyHQ/Relay | planned |
| Oxy-hosted-only option | Oxy (policy + enforcement) | OxyHQServices `packages/api/src/services/inferenceCatalogue.service.ts` | exists |
| Licence / usage-right constraints | Oxy (policy + enforcement) | OxyHQServices `packages/api/src/services/inferenceCatalogue.service.ts` | exists |
| Fallback-disabled option | Oxy (policy + enforcement) | OxyHQServices `packages/api/src/services/inferenceRoutingPolicy.service.ts` | exists |
| The ordered list of PRE-AUTHORIZED ROUTES the envelope carries — the candidates that survived the policy, in preference order (ADR 0017) | Oxy (authorization), Relay (execution: take the next entry) | OxyHQServices `packages/contracts/src/inference/routingPolicy.ts` (`authorizedRouteSchema`) + `request.ts` | contract only — the shape exists and is OPTIONAL; `inferenceEdge.service.ts` does not populate it yet, and absent means no failover is authorized |
| Same-model deployment fallback option | Oxy (policy + authorization), Relay (execution) | OxyHQServices + OxyHQ/Relay | contract only — expressible as a `same_model` entry since ADR 0017; unpopulated, so still no failover in practice |
| Explicitly authorized cross-model fallback option | Oxy (policy + authorization), Relay (execution) | OxyHQServices + OxyHQ/Relay | contract only — expressible ONLY as a `cross_model` entry carrying `authorizedByPolicy: true`, and never for a request that pinned a revision; unpopulated |
| Dedicated endpoint / capacity for enterprise accounts | Oxy (entitlement + candidate filter), Relay (capacity) | OxyHQServices `packages/api/src/services/inferenceCatalogue.service.ts` + OxyHQ/Relay | planned |
| Routing-policy versioning; the request envelope and the receipt record a REFERENCE to the exact policy revision used, as provenance rather than as instructions | Oxy | OxyHQServices `packages/contracts/src/inference/routingPolicy.ts` (`routingPolicyReferenceSchema`) + `packages/api/src/db/schema` | exists |
| Customer-visible route-switch event/receipt | Oxy (emission to customer), Relay (source) | OxyHQServices + OxyHQ/Relay | planned |
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
| `api_key_usage_events` (append-only, 90-day retention) | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts:61`, retention `:54` | exists |
| `credits_used double precision` (telemetry only, never the ledger) | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts:95` | exists |
| `user_id` attribution | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts:83` | exists |
| `application_id` attribution | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts:87` | exists |
| `api_key_id` → `developer_api_keys` reference (obsolete) | Oxy | dropped by `packages/api/drizzle/0047_retire_developer_api_keys.sql`, together with the table it referenced | removed — asserted against the MIGRATED database in `packages/api/src/db/schema/__tests__/applications.test.ts`, because deleting the column from the TypeScript alone would leave every functional test green whether or not the migration ever ran |
| `account_id` column | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts` | planned |
| `application_credential_id` attribution | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts` | planned — it does not "replace `api_key_id`", which is simply gone; `inference_usage_events` already carries credential attribution for inference, and whether this general-telemetry table needs its own is workstream 8's call |
| `request_id`, optional `generation_id` | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts` | planned |
| Endpoint, status, latency columns | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts:89-97` | exists |
| Normalized unit totals (tokens/time/images, separate from money) | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Requested model, resolved model revision, customer-safe serving provider/deployment | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Upstream wholesale cost kept out of customer responses | Relay | OxyHQ/Relay | unverified — Relay-owned and not audited from here (rule 1); `planned` would claim Oxy owes something here, and it does not |
| Telemetry retention separated from financial receipt retention | Oxy | OxyHQServices `packages/api/src/db/expiry.ts` | planned |
| Aggregates by account, project, application, credential, model, provider, status, day | Oxy | OxyHQServices `packages/api/src` | planned |
| Customer-visible usage with documented eventual consistency | Oxy | OxyHQServices `packages/console` | planned |
| Exact billed amount sourced from the ledger, not telemetry | Oxy | OxyHQServices `packages/api/src` | planned |
| Enterprise reconciliation exports | Oxy | OxyHQServices `packages/api/src` | planned |
| Spend/token spike anomaly detection | Oxy | OxyHQServices `packages/api/src` | planned |
| `GET /applications/:appId/usage` | Oxy | OxyHQServices `packages/api/src/routes/applications.ts:1139` | exists |

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
| Playground (posts to `/v1/chat/completions`) | Oxy | OxyHQServices `packages/console/src/routes/_layout/playground.tsx:148` | exists |
| Usage page | Oxy | OxyHQServices `packages/console/src/routes/_layout/usage.tsx` | exists |
| Billing page | Oxy | OxyHQServices `packages/console/src/routes/_layout/billing.tsx` | exists |
| Account settings page | Oxy | OxyHQServices `packages/console/src/routes/_layout/settings/account.tsx` | exists |
| Documentation and SDK pages | Oxy | OxyHQServices `packages/console/src/routes/_layout/documentation/` | exists |
| Members / account-settings management surface | Oxy | OxyHQServices `packages/console` | planned |
| Per-app Inference overview | Oxy | OxyHQServices `packages/console` | planned |
| Per-app Usage and spend | Oxy | OxyHQServices `packages/console` | planned |
| Per-app Routing policy | Oxy | OxyHQServices `packages/console` | planned |
| Per-app Provider connections / BYOK | Oxy | OxyHQServices `packages/console` | planned |
| Per-app Limits and budgets | Oxy | OxyHQServices `packages/console` | planned |
| Per-app Webhooks / audit events | Oxy | OxyHQServices `packages/console` | planned |
| Per-app environment-specific configuration | Oxy | OxyHQServices `packages/console` | planned |
| Real model catalogue rendering (ids, publishers, revisions, capabilities, regions, providers, data policy, prices) | Oxy | OxyHQServices `packages/console` | planned |
| Routing profiles rendered separately from models | Oxy | OxyHQServices `packages/console` | planned |
| Catalogue filters (modality, tools, region, provider, price, data policy) | Oxy | OxyHQServices `packages/console` | planned |
| Playground bound to active account/application and selected credential/environment | Oxy | OxyHQServices `packages/console` | planned |
| Post-run detail: request id, model revision, provider route, latency, units, billed amount | Oxy | OxyHQServices `packages/console` | planned |
| Balance split: purchased / promotional / reserved | Oxy | OxyHQServices `packages/console` | planned |
| Pending reservations and settled charges | Oxy | OxyHQServices `packages/console` | planned |
| Spend by application / model / provider / time | Oxy | OxyHQServices `packages/console` | planned |
| Budget creation and alerts | Oxy | OxyHQServices `packages/console` | planned |
| Server-provided permission gating (no client role re-derivation) | Oxy | OxyHQServices `packages/console` | planned |
| Relay customer console | **forbidden** (ADR 0005 invariant 5) | — | must never exist |

## 10. BYOK provider connections (epic §10)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| Provider connection metadata (provider, owner account, application scope, environment, status) | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Provider secret material in Vault/KMS/managed secret storage | Vault/KMS (Oxy-managed) | oxy-infra | planned |
| Secret *reference* stored in Postgres | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Environment/account encryption separation | Oxy | OxyHQServices `packages/api/src` | planned |
| Safe prefixes / fingerprints / validation status in responses | Oxy | OxyHQServices `packages/api/src` | planned |
| Credential validation via a dedicated provider check (never logged) | Relay | OxyHQ/Relay | unverified — Relay-owned and not audited from here (rule 1); `planned` would claim Oxy owes something here, and it does not |
| Rotation, replacement, immediate disable | Oxy | OxyHQServices `packages/api/src` | planned |
| Audit log: create, validate, rotate, use, revoke | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Connection scope decision (account-wide / project-wide / application-only) | Oxy | OxyHQServices `docs/` | planned |
| Routing policy "prefer/require BYOK" | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| BYOK usage still produces Oxy usage receipts and platform-fee charges | Oxy | OxyHQServices `packages/api/src` | planned |
| Provider-terms acknowledgement record | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| BYOK secret in an application table | **forbidden** (ADR 0005 invariant 12) | — | must never exist |

## 11. Commercial permissions (epic §11)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| `availabilityScope` (`internal_alia`, `public_payg`, `enterprise`, `byok_only`, `oxy_hosted`) | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| `commercialPermission` (`standard_application_use`, `public_resale_approved`, `wholesale_contract`, `customer_byok`, `open_weight_hosting`) | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Public catalogue/routing block unless permission approved | Oxy | OxyHQServices `packages/api/src` | planned |
| Contract/legal review status and evidence reference | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Open-weight licence, attribution, acceptable-use requirements | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Base-model attribution requirement for derived names | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| "Available to Alia internally" vs "available to external customers" separation | Oxy | OxyHQServices `packages/api/src/db/schema/inferenceDeployments.ts:168` (`availability_scope`), vocabulary in `packages/contracts/src/inference/catalogue.ts:165` | exists — the enum IS the separation (`internal_alia`, `public_payg`, `enterprise`, `byok_only`, `oxy_hosted`), and it is ENFORCED rather than merely stored: `services/inferenceCatalogue.service.ts:200` filters every catalogue read to the viewer's permitted scopes |
| Admin workflow: approve, restrict, suspend, retire a route | Oxy | OxyHQServices `packages/console` + `packages/api/src` | planned |

## 12. Privacy, security, compliance (epic §12)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| No-user-IPs-at-rest invariant (platform-wide) | Oxy | OxyHQServices `packages/api/src/db/schema/securityActivities.ts:6-19`, `packages/api/src/utils/ipKey.ts` | exists |
| `security_activities` (account's own audit trail) | Oxy | OxyHQServices `packages/api/src/db/schema/securityActivities.ts` | exists |
| No prompt/response persistence by default | Oxy + Relay | OxyHQServices `docs/adr/0016-no-inference-payload-persistence.md`, `scripts/check-no-payload-persistence.mjs` + OxyHQ/Relay | exists for Oxy — no column in the schema can hold a prompt, a completion, a chat message body or a tool argument, enforced by a census over the drizzle barrel in the `Schema Payload Policy` CI job; for Relay, **unverified** — the repository exists and its payload handling has not been audited from here, which is a different claim from `planned` |
| Opt-in, time-limited, encrypted, audited debug payload retention | Oxy | OxyHQServices `docs/adr/0016-no-inference-payload-persistence.md` | refused, not planned — ADR 0016 makes the four properties PRECONDITIONS on building capture rather than follow-up work, and precondition 3 (a key Oxy does not hold in PostgreSQL) needs the same absent managed-secret backend as ADR 0013 |
| PII/redaction controls for opted-in traces | Oxy | OxyHQServices `docs/adr/0016-no-inference-payload-persistence.md` | blocked on the row above, and vacuous until then — no trace or span infrastructure exists in this repository, so there is nothing to redact PII from |
| Deployment policy fields (retention, training, region, subprocessors, ZDR) | Oxy (catalogue), Relay (truth) | OxyHQServices + OxyHQ/Relay | planned |
| Deletion/export preserving legally required financial records | Oxy | OxyHQServices `packages/api/src` | planned |
| Secret-scanning and accidental-serialization tests | Oxy | OxyHQServices `scripts/check-secret-scan.mjs` (scanning), `packages/api/src/services/__tests__/inferenceProviderConnection.service.test.ts` (serialization) | exists — twelve issued-token grammars plus a tracked-dotenv refusal over every tracked file, in the `Secret Scan` CI job, each rule verified against its own sample on every run; the serialization half walks a returned DTO to every leaf, its `JSON.stringify`, its exact key set, every stored column and the audit trail, with a positive control proving the credential really passed through |
| Rotation runbooks and break-glass procedures | Oxy (credentials Oxy issues), infra (AWS) | OxyHQServices `docs/runbooks/` + oxy-infra `docs/runbooks/` | exists for the five credential classes Oxy issues — application credential, `oxy_sk_…` machine key, BYOK provider connection, the token signing keys, and the Oxy→Relay edge signing key (that one written against ADR 0015 and pending it); `planned` for the AWS half, which is oxy-infra's and is deliberately not duplicated here |
| Immutable audit events for credential, billing, routing, provider-connection changes | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Staff vs customer action distinction in audit | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Least-privilege admin roles | Oxy | OxyHQServices `packages/api/src` | planned |
| Rate limits and fraud controls before prepaid public inference | Oxy | OxyHQServices `packages/api/src/middleware/rateLimiter.ts` (factory exists; inference limiters planned) | planned |
| Privacy/security review gate for public launch | Oxy | OxyHQServices `docs/` | planned |
| Signed Alia model release manifest ingestion contract | Oxy (ingest), Alia (issuer) | OxyHQServices `packages/api/src` | planned |
| Model card, licence, provenance, evaluation, safety results, artifact digests | Alia (produces), Oxy (stores/publishes) | OxyHQServices `packages/api/src/db/schema` | planned |
| EU AI Act / GPAI documentation metadata | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Content-provenance / marking metadata | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |

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
| Inference scopes granted to Alia | Oxy | OxyHQServices `packages/api/src/utils/applicationScopes.ts` | planned |
| Alia delegating an end-user id while billing the Alia account/cost center | Oxy | OxyHQServices `packages/api/src` | planned |
| Internal cost centers: Alia production chat, Codea, research, voice, evaluations | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Entitlement/billing API consumed by Alia product plans | Oxy | OxyHQServices `packages/api/src` | planned |
| Removal of the static Oxy→Alia infrastructure proxy | Oxy | OxyHQServices `packages/api/src/routes/alia.ts` | planned — **a removal row, so this means the proxy is STILL LIVE** (rule 2). All three of its routes are mounted and now gated by `requireFirstPartyInferenceCaller`; see §3.1. Workstream 14 owns retiring them |
| Deprecation of Alia-owned developer keys, provider billing, generic `/v1` endpoints | Alia | Alia repo | planned — **a removal row on a non-Oxy owner**, so it means neither that Oxy owes anything nor that Alia has done it: `alia_sk_…` keys are still Alia-issued and unaudited from here (rules 1 and 2 together) |
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
| Oxy↔Relay schema compatibility tests | Oxy + Relay | OxyHQServices + OxyHQ/Relay | planned |
| Attribution tests (account/application/credential) | Oxy | OxyHQServices `packages/api` | planned |
| Scope and RBAC tests | Oxy | OxyHQServices `packages/api` | planned |
| Credential create/rotate/revoke/expiry tests | Oxy | OxyHQServices `packages/api/src/routes/__tests__/applications.test.ts` (credential coverage exists; inference cases planned) | planned |
| Reservation/settlement/refund/idempotency tests | Oxy | OxyHQServices `packages/api` | planned |
| Price-version snapshot tests | Oxy | OxyHQServices `packages/api` | planned |
| Cross-account isolation tests | Oxy | OxyHQServices `packages/api` | planned |
| Commercial-permission route filtering tests | Oxy | OxyHQServices `packages/api` | planned |
| Retention-policy filtering tests | Oxy | OxyHQServices `packages/api` | planned |
| E2E: non-streaming, SSE streaming, disconnect-cancels, same-model failover, forbidden cross-model fallback | Oxy + Relay | OxyHQServices + OxyHQ/Relay | planned |
| E2E: Alia service token with delegated user, external machine key, BYOK route | Oxy + Relay | OxyHQServices + OxyHQ/Relay | planned |
| E2E: insufficient balance, partial stream settlement, retry with no duplicate charge, rotation during traffic | Oxy | OxyHQServices `packages/api` | planned |
| `requestId` correlation across edge, Relay, ledger and receipt | Oxy + Relay | OxyHQServices + OxyHQ/Relay | planned |
| Metrics: request rate, error rate, TTFT, total latency, cancellation, fallback | Oxy + Relay | OxyHQServices + OxyHQ/Relay | planned |
| Metrics: reserve failures, settlement lag, reconciliation drift | Oxy | OxyHQServices | planned |
| Alerts: ledger imbalance, duplicate event ids, provider error/cost spikes | Oxy | OxyHQServices + oxy-infra | planned |
| Audit dashboards for credential and billing changes | Oxy | OxyHQServices `packages/console` | planned |
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
