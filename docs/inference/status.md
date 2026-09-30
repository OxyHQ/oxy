# Inference status board

**New to Oxy inference? Read the [developer guide](./README.md) first** — it
explains the modes (exact model, power level, app default), who owns what, and
how to call the API. This page is the status board: what is built, where it
lives, and which rollout gates remain. A reader who finds a topic missing
elsewhere finds the reason here rather than assuming it was overlooked.

The public Oxy inference endpoint and Kaana data plane are
separate deployment facts: code in either repository does not prove that an
audience, catalogue route, signing lane or charging stage is live. Verify the
current rollout readout and the exact deployed Kaana binding before invoking.
[rollout.md](./rollout.md) has the flags, gates and rollback plan.
Inbox's product-specific point-inference contract and bootstrap are in
[inbox-point-inference.md](./inbox-point-inference.md).

Tracking issue: [OxyHQ/oxy#972](https://github.com/OxyHQ/oxy/issues/972).
Design decisions: [ADR 0005](../adr/0005-oxy-is-the-single-control-plane.md) ·
[0007](../adr/0007-canonical-request-attribution.md) ·
[0008](../adr/0008-catalogue-concept-separation.md) ·
[0009](../adr/0009-usage-reservation-and-settlement.md) ·
[0010](../adr/0010-public-api-compatibility.md) ·
[0013](../adr/0013-byok-secret-custody.md) ·
[0019](../adr/0019-kaana-byok-custody.md) ·
[0014](../adr/0014-account-billing-and-entitlements.md).

---

## The one-paragraph version

Oxy is the **control plane**: accounts, applications, credentials, scopes,
attribution, the model catalogue, routing policy, BYOK metadata, the financial
ledger, the usage API and the Console. **Kaana** is the inference data plane:
provider adapters, routing execution, streaming, measurement and the encrypted
PostgreSQL/KMS custody of customer provider keys. Alia remains the agent
runtime. Kaana's only canonical signed origin is `https://kaana.ai`; it never
uses a hostname under `oxy.so`. The repository-level
`scripts/check-kaana-identity.mjs` gate keeps that identity exact without
renaming unrelated SMTP, ATProto, device, OAuth or MCP/TNP relay roles.

---

## What is built

| Capability | Where | Reachable by a caller? |
|---|---|---|
| The public inference edge | `packages/api/src/routes/inferenceEdge.ts` | Mounted — `POST /v1/responses`, `POST /v1/chat/completions` (text, and spoken output on models that declare it), `GET /v1/generations/:id`. Reachability is controlled by `INFERENCE_EDGE_AUDIENCE`; configured Kaana is the canonical execution path |
| Realtime sessions | `packages/api/src/routes/inferenceRealtime.ts` | `GET /v1/realtime` WebSocket, conversation sessions only, on models whose catalogue declares them — [realtime.md](./realtime.md) |
| `oxy_sk_*` machine credentials — create, rotate, revoke, audit | `packages/api/src/routes/applications.ts`, `.../utils/machineCredentialToken.ts` | Yes |
| The `oxy_sk_*` bearer middleware | `packages/api/src/middleware/machineCredential.ts` | Mounted on the edge with its per-credential and per-application limiters, and **the lane is shut by default** (`INFERENCE_MACHINE_CREDENTIAL_AUTH`) |
| Native service tokens (`clientId + clientSecret` → 1h JWT) | `POST /auth/service-token` | Yes |
| The `inference:*` scope family | `packages/api/src/utils/applicationScopes.ts` | Yes — see the caveat on `inference:models:read` below |
| Model catalogue tables + read API | `packages/api/src/routes/inferenceCatalogue.ts` | Yes — `/models` and `/v1/models`, same router. The reviewed exact-route writer is `packages/api/scripts/bootstrap-kaana-catalogue.ts`; its main-only dry-run/SHA/apply lane is `.github/workflows/bootstrap-kaana-catalogue.yml`. Source presence is not evidence that either ran in production, and public visibility remains gated by `INFERENCE_CATALOGUE_AUDIENCE` |
| Exact financial ledger: reserve → settle → refund | `packages/api/src/services/inferenceLedger.service.ts` | Yes — the edge reserves before forwarding and settles on every path out, **once charging is authorized**. Unset, it shadow meters: prices the request, records the amount, writes no financial record |
| Routing policy control plane | `packages/api/src/routes/inferenceRoutingPolicies.ts` | Yes — stored, validated, versioned, pinned onto every receipt, and **enforced against the candidate routes** (thirteen controls, the two price ceilings included; only `optimiseFor` is not). `allowedRoutingProfileIds` restricts which power levels a request may name |
| Power levels (routing profiles with a `powerLevel`) and the `auto` rule | `packages/api/src/services/inferencePowerLevels.service.ts`, `inference_model_power_classes` | Yes — [power-levels.md](./power-levels.md) |
| BYOK provider connections | `packages/api/src/routes/inferenceProviderConnections.ts`, `.../services/kaanaCredentialControl.ts` | Yes when the signed Kaana control lane is configured; every uncertain mutation is quarantined and recovered under the same operation ID |
| Usage, spend, balance, charges, budgets | `packages/api/src/routes/inferenceReporting.ts` | Yes |
| Account billing profile, Stripe boundary, entitlements | `packages/api/src/routes/accountBilling.ts` | Yes |
| Inference usage telemetry + daily rollups | `packages/api/src/db/schema/inferenceUsageEvents.ts` | Yes — written by the edge, read by the reporting API |
| Oxy↔data-plane contracts (Zod) | `packages/contracts/src/inference/` | Published as `@oxy.so/contracts` |
| The TypeScript SDK | `packages/core/src/inference/OxyInferenceClient.ts` | Catalogue, `respond()`, typed `stream()` and generation reads are merged and published in `@oxy.so/core` by [#1145](https://github.com/OxyHQ/oxy/pull/1145). Publication proves the client surface, not a live Kaana route — [sdk.md](./sdk.md) |
| Console: models, usage, billing, routing policy, BYOK | `packages/console` | Yes |
| Rollout flags + the staff readout | `packages/api/src/config/rolloutFlags.ts`, `GET /inference/admin/rollout` | Yes — [rollout.md](./rollout.md) |

**Since ADR 0027 (2026-09-25), deploying the API with the Kaana binding DOES
publish internal models:** the scheduled Kaana catalogue sync writes every
priced, fully described Kaana model as an approved `platform_internal` route
([catalogue.md](./catalogue.md#automatic-sync-from-kaana)). Nothing public is
written by it. The paragraph below is the pre-sync history of the reviewed
bootstrap, which remains the source for Inbox's profile and the speech route.
The reviewed
`bootstrap:kaana-catalogue` validates a fresh signed Kaana inventory and exact
reviewed facts before it can apply model, revision, deployment, pricing, score
and routing-profile rows. Production workflow run `33736747600` on 2026-09-03
found the exact Inbox profile PK absent; that is dated evidence, and the
bootstrap workflow's presence is not proof it later ran. `GET /models` returning
`[]` is valid for an empty or withheld audience, not proof of current production
contents. The current reviewed deployments are `internal_alia`; their profile
existing would not by itself make a route visible to the `first_party` Inbox
principal.

**`inference:models:read` is checked nowhere.** The catalogue is audience-scoped
by application type, not by scope: an anonymous caller, a user bearer and an
ordinary application's service token all see the public catalogue. Holding the
scope grants nothing that is checked — the same shape `chat:completions` had
before it was removed. `inference:invoke` and `inference:usage:read` ARE checked,
at the edge; `inference:routing:*` and `inference:providers:*` at their own
control planes.

---

## Cutover-dependent status

The sections below identify rollout dependencies. They are not a substitute for
the live checks in [request-routing.md](./request-routing.md#a-cutover-is-complete-only-when-measured).

### The Kaana data plane — workstream 13

The implementation lives in `~/Oxy/Kaana` and the signed service origin is
`https://kaana.ai`. This repository owns the Oxy half of the contracts and
deployment gates, not Kaana's runtime internals. A successful build or merge is
not reachability evidence: verify the exact deployed Kaana revision, signed
binding, catalogue route and audience before declaring inference live.

Past the rollout gates, the edge authenticates, attributes, authorizes, resolves
policy and route, reserves spend when charging is authorized, and forwards only
an exact signed request to Kaana. It never falls back to the Alia proxy, derives
an opaque ID from a name/order, or fabricates a completion.

### The catalogue's contents — workstream 5

The internal catalogue's contents come from the Kaana sync (ADR 0027); verify a
run's summary (`POST /inference/admin/catalogue/sync` or the
`inference.catalogue_sync.completed` log) rather than assuming it ran. The exact
reviewed model bootstrap is merged, but it is safe-by-default and
applies nothing unless an authorized operator sets `APPLY=1` with a live signed
Kaana inventory and catalogue reviewer. Until a route has reviewed commercial
permission it is not publicly exposed, and default-deny is the starting state.
Re-check the live catalogue and audience rather than treating source or the
dated empty readback as production evidence.

### Route selection — workstream 6

Live in source: every routing-policy control filters the candidate routes before
one is chosen (a request no route satisfies is refused with `policy_violation`,
never downgraded — [#1012](https://github.com/OxyHQ/oxy/pull/1012)), both price
ceilings included; survivors are ordered by profile priority, BYOK preference,
funding class, score and exact `deploymentId`. The single authoritative
statement of that order is
[routing.md](./routing.md#ranking-after-qualification); this page does not
repeat it.

### Power levels and per-app allowed levels — live in source

On `main`: the seven power-level profiles (`auto`, `instant`, `medium`,
`high`, `xhigh`, `pro`, `ultra`, fixed ids `power-<level>`) with their
reasoning efforts, reviewed per-model power classes with cited benchmark
sources, `auto`'s deterministic per-request choice, cross-model failover inside
a level recorded against the profile, a per-app `allowedRoutingProfileIds`
list, naming a level in `model` on both chat dialects, same-model deployment
failover on by default, and only servable models listed or chosen
([power-levels.md](./power-levels.md), migration
`0129_power_routing_profiles`). **Not in Oxy:** Alia's level picker, each
product's own policy rows (Inbox's `instant`-only policy is configuration to
write), and Kaana withholding deployments whose keys are all retired or that
fail persistently. Source is not production: verify the migration ran, the
seven preset rows exist and a real request at a level completed before calling
it deployed. The [developer guide](./README.md#what-is-live-and-what-is-rolling-out)
is the table of record.

### Kaana BYOK custody — workstream 10, [ADR 0019](../adr/0019-kaana-byok-custody.md)

Kaana is the sole credential custodian: KMS ciphertext is stored in Kaana
PostgreSQL and decrypted only inside inference. Oxy stores exact opaque
handle/revision metadata plus a durable same-operation recovery ledger; it
stores no provider credential plaintext/ciphertext and persists no prefix,
suffix, fingerprint, hash or other credential-derived hint.
Provider keys never come from environment variables or MongoDB. Create/rotate
accept exactly 1–4096 visible ASCII bytes, and an uncertain mutation remains
non-routable until the exact Kaana outcome is reconciled. In source, the
authenticated edge resolves and signs only an exact `ready + active + valid`
generation, applies `prefer`/`require`/`disabled`, and uses a separately linked
platform-fee version for BYOK settlement. A `pending_validation + unvalidated`
generation is never eligible for a normal authorized route. The dedicated
authenticated bootstrap that could validate that initial generation is absent,
so BYOK remains a fail-closed production launch gate alongside fee publication
and association, migrations, matching image deployment and live probes.
[byok.md](./byok.md) has the state machine, recovery rules and launch gates.

### Streaming and observable cancellation — workstream 4

The stream-event union, Oxy forwarding client and Kaana emitter exist in source.
Typed `OxyInferenceClient.stream()` is merged and published in
`@oxy.so/core` by #1145. Production readiness still requires a real
streamed request plus an explicit client-disconnect test proving cancellation
reaches the provider and settlement occurs exactly once.
[streaming.md](./streaming.md) documents the contract.

### Later modalities — workstream 4

`POST /v1/audio/speech` and `POST /v1/images/generations` are mounted in
`packages/api/src/routes/inferenceEdge.ts`, synchronous and gated on a route
whose catalogue capabilities declare that output; Kaana serves neither yet, so
a request today ends at the route gate. `POST /v1/embeddings` and `/v1/rerank`
do not exist. `/v1/audio/transcriptions` and `/v1/batches` are deliberately
not mounted — the comment above the audio route in `inferenceEdge.ts` records
why (no sound cost ceiling; batches do not fit the reserve → settle protocol
and need an ADR 0009 amendment).

Note also that `GET /v1/models/:id` is served as **two path segments**,
`GET /v1/models/:publisher/:model`, because a canonical model id contains a
slash.

### Console's playground — workstream 9

Console renders the real catalogue, real usage, real balance and spend, budgets,
routing policy and BYOK. **The playground sends nothing**: the lane it would use
authenticates a credential and an environment rather than an ambient session, so
it needs a different screen rather than this one with the fetch re-enabled.

### Scheduled housekeeping — workstreams 7, 8

Both sweeps are scheduled by `server.ts` in `bootstrap()`, unref'd and with
their failures logged, like every other sweep there: the 90-day telemetry
retention sweep hourly, and `expireReservations` — which releases a hold that
outlived its request as a refund with a reason — every minute. Neither is
load-bearing today, because every path out of the edge settles its own hold and
the telemetry readers bound their own windows; both become so the moment a
request can fail somewhere the edge does not see, which is what a live data
plane introduces.

They were implemented and tested long before anything called them, and that gap
was invisible precisely because every test passed. The registration is therefore
asserted against the real entrypoint (`packages/api/src/__tests__/scheduledSweeps.test.ts`),
not inferred from the sweepers' own coverage.
[data-policy.md](./data-policy.md#how-long-oxy-keeps-what-it-does-keep) records
the retention side.

### Every rollout stage — workstream 16

The flags exist and are tested; **no deployment has entered any stage**. The
internal Alia canary, the Oxy first-party canary, the closed external beta and
the prepaid public launch are all ahead of us, and each is additionally gated on
things a flag cannot switch — a data plane, a catalogue with contents, and the
anomaly controls below. [rollout.md](./rollout.md) has the configuration each
stage means and the rollback plan.

Dual-read/dual-write is **not** being built, and that is a decision rather than
an omission: every table this platform reads and writes is new and holds no
production rows, so there is no old store to cut over from.
[rollout.md](./rollout.md#dual-read-and-dual-write-there-is-nothing-to-build)
argues it.

### Abuse, fraud and anomaly controls — workstreams 4, 8, 12

Rate limits exist, per credential and per application, and they bound REQUESTS
rather than cost. Spend is bounded by the reservation and by spending limits.
Anomaly detection for sudden spend or token spikes does not exist, and #972 gates
public launch on it.

### Metrics dashboards, alerts and status-page signals — workstream 16

**There is no metrics library in this repository, deliberately.** Every metric
#972 names is a property of a row this platform already writes durably —
`inference_usage_events` and its daily rollups, the reservations and the
receipts — and the edge fills the three columns that existed and that nothing
wrote (`latency_ms`, `time_to_first_token_ms`, `route_switches`).

**All nine of those metrics are now SERVED**, from the durable record rather than
from a process registry: `GET /inference/admin/metrics` (staff-gated). Two of them
report `state: 'pending'` with a reason instead of a number, because they are
structurally unmeasurable here — time to first token needs a streaming data plane,
and fallback needs a data plane that switches a route — and a zero would be
indistinguishable from a correct measurement. Reconciliation drift became a stream
rather than a staff-triggered pass, with a window claim that keeps N ECS tasks from
multiplying it.

What is still missing is a scrape or export target, alert routing and a Console
audit surface. The first two belong to `~/Oxy/oxy-infra`, which today holds 58
Terraform files with zero alarms, zero SNS topics and zero dashboards; the third is
workstream 9's. [observability.md](./observability.md) has the derivation for each
metric, the concrete shape the export half would take, why no alarm is being added
before a destination exists, why provider execution metrics require exact v2
deployment identity plus a live failover/readback proof, the two places the audit
trail's actor is thinner than it looks, and why `isStaff` is still one
undifferentiated tier.

### Alia integration — workstream 14

The registration Alia needs in order to be an ordinary consumer is now DECLARED
in this repository — the `internal` application, its scope grant, its own owner
account, the five internal cost centres, and a per-environment service
credential. **None of it has been run against production by the change that
introduced it**: every piece is a seed script plus an ECS one-shot workflow a
person triggers, so what the live database holds is whatever the last run left —
read it back rather than inferring it from this repository.
[alia.md](./alia.md) is the runbook, the argument for each scope granted and
withheld, and the list of what remains blocked.

The Oxy-to-Alia infrastructure proxy (`/alia/*`, `/v1/voice/*`) is retired:
point-inference callers moved to Oxy endpoints backed by Kaana, and Alia's
agent, chat and voice product callers talk to Alia directly. See
[deprecation.md](./deprecation.md#the-alia-proxy-retirement-is-complete).

### A Python SDK — workstream 15

Not started, deliberately. [sdk.md](./sdk.md#there-is-no-official-python-sdk)
gives the two reasons.

---

## The rest of this doc set

The map of every deep doc is in the [developer guide](./README.md#deep-docs).

Ownership of every table, event and API across Oxy, the data plane and Alia is
in [architecture/inference-responsibility-matrix.md](../architecture/inference-responsibility-matrix.md).
