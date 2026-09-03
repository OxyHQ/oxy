# Oxy inference platform — what exists, and what does not

**This page is the status board.** Everything else under `docs/inference/`
documents a mechanism that is already in the repository; this page is where the
gaps live, so a reader who finds a topic missing elsewhere finds the reason here
rather than assuming it was overlooked.

Read this first. The public Oxy inference endpoint and Kaana data plane are
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
[0014](../adr/0014-account-billing-and-entitlements.md).

---

## The one-paragraph version

Oxy is the **control plane**: accounts, applications, credentials, scopes,
attribution, the model catalogue, routing policy, BYOK metadata, the financial
ledger, the usage API and the Console. **Kaana** is the inference data plane:
provider adapters, routing execution, streaming, measurement and the encrypted
PostgreSQL/KMS custody of customer provider keys. Alia remains the agent
runtime. Kaana's only canonical signed origin is `https://kaana.ai`; it never
uses a hostname under `oxy.so`.

---

## What is built

| Capability | Where | Reachable by a caller? |
|---|---|---|
| The public inference edge | `packages/api/src/routes/inferenceEdge.ts` | Mounted — `POST /v1/responses`, `POST /v1/chat/completions`, `GET /v1/generations/:id`. **Closed to every audience by default** (`INFERENCE_EDGE_AUDIENCE`), and every invoke refuses even when opened (below) |
| `oxy_sk_*` machine credentials — create, rotate, revoke, audit | `packages/api/src/routes/applications.ts`, `.../utils/machineCredentialToken.ts` | Yes |
| The `oxy_sk_*` bearer middleware | `packages/api/src/middleware/machineCredential.ts` | Mounted on the edge with its per-credential and per-application limiters, and **the lane is shut by default** (`INFERENCE_MACHINE_CREDENTIAL_AUTH`) |
| Native service tokens (`clientId + clientSecret` → 1h JWT) | `POST /auth/service-token` | Yes |
| The `inference:*` scope family | `packages/api/src/utils/applicationScopes.ts` | Yes — see the caveat on `inference:models:read` below |
| Model catalogue tables + read API | `packages/api/src/routes/inferenceCatalogue.ts` | Yes — `/models` and `/v1/models`, same router. **The catalogue is EMPTY**, and is withheld from public viewers until published (`INFERENCE_CATALOGUE_AUDIENCE`) |
| Exact financial ledger: reserve → settle → refund | `packages/api/src/services/inferenceLedger.service.ts` | Yes — the edge reserves before forwarding and settles on every path out, **once charging is authorized**. Unset, it shadow meters: prices the request, records the amount, writes no financial record |
| Routing policy control plane | `packages/api/src/routes/inferenceRoutingPolicies.ts` | Yes — stored, validated, versioned, pinned onto every receipt, and **enforced against the candidate routes** (thirteen controls, the two price ceilings included; only `optimiseFor` is not) |
| BYOK provider connections | `packages/api/src/routes/inferenceProviderConnections.ts`, `.../services/kaanaCredentialControl.ts` | Yes when the signed Kaana control lane is configured; every uncertain mutation is quarantined and recovered under the same operation ID |
| Usage, spend, balance, charges, budgets | `packages/api/src/routes/inferenceReporting.ts` | Yes |
| Account billing profile, Stripe boundary, entitlements | `packages/api/src/routes/accountBilling.ts` | Yes |
| Inference usage telemetry + daily rollups | `packages/api/src/db/schema/inferenceUsageEvents.ts` | Yes — written by the edge, read by the reporting API |
| Oxy↔data-plane contracts (Zod) | `packages/contracts/src/inference/` | Published as `@oxyhq/contracts` |
| The TypeScript SDK | `packages/core/src/inference/OxyInferenceClient.ts` | Yes — [sdk.md](./sdk.md) |
| Console: models, usage, billing, routing policy, BYOK | `packages/console` | Yes |
| Rollout flags + the staff readout | `packages/api/src/config/rolloutFlags.ts`, `GET /inference/admin/rollout` | Yes — [rollout.md](./rollout.md) |

**The catalogue itself is EMPTY.** The tables and the read API exist; the
contents do not. `packages/api/scripts/seed-inference-catalogue.ts` seeds five
publisher slugs and **no models**, because the repository does not record which
weights Oxy can serve, under which contract, at what price. `GET /models`
answers `[]`, and that is the correct answer, not a failure. Nothing in these
docs invents a model id to make an example look complete.

**`inference:models:read` is checked nowhere.** The catalogue is audience-scoped
by application type, not by scope: an anonymous caller, a user bearer and an
ordinary application's service token all see the public catalogue. Holding the
scope grants nothing that is checked — the same shape `chat:completions` had
before it was removed. `inference:invoke` and `inference:usage:read` ARE checked,
at the edge; `inference:routing:*` and `inference:providers:*` at their own
control planes.

---

## What is NOT built

Each line names the workstream of #972 that owns it. Nothing here has a date, for
the reason given in [deprecation.md](./deprecation.md).

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

Zero models. Until a route has a reviewed commercial permission it is not
publicly exposed, and default-deny is the starting state. So `GET /models`
answers `[]`, `getModel(...)` throws for every id, and the edge refuses any
model you name with `model_not_found`.

### One routing control — workstream 6

`optimiseFor` is not enforced: it ranks the routes that already qualify, which is
routing execution and therefore the data plane's (ADR 0006) — and there is no
data plane.

The two price ceilings, `maxPricePerUnit` and `maxPricePerRequest`, WERE the
other two and are now compared against the price version each candidate is
actually charged at. `maxPricePerRequest` is still only half of a spend control:
it bounds a route's flat per-request fee, while the estimated cost of one
particular request against the same limit is the edge's check and is not
implemented. A spending limit and the account balance remain the controls that
bound spend.

Every other routing control IS enforced against the candidate routes as of
[#1012](https://github.com/OxyHQ/oxy/pull/1012), which closed
[#1011](https://github.com/OxyHQ/oxy/issues/1011) — a request no route satisfies
is refused with `policy_violation` rather than downgraded.
[routing.md](./routing.md#what-is-enforced-today) has the classification, which
is also held in code by a `tsc` gate that fails naming any control in neither
list.

### Kaana BYOK custody — workstream 10, [ADR 0013](../adr/0013-byok-secret-custody.md)

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

The stream-event union exists in `@oxyhq/contracts`; nothing emits one, and the
edge refuses `stream: true`. Cancellation is wired into the forward and settled
correctly in the ledger, and cannot be exercised end to end because there is
nothing to cancel. [streaming.md](./streaming.md) documents the contract and
says plainly which parts you cannot observe.

### Later modalities — workstream 4

`POST /v1/embeddings`, `/v1/images/generations`, `/v1/audio/transcriptions`,
`/v1/audio/speech`, `/v1/rerank`, `/v1/batches` — none exists.

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
before a destination exists, the reported-vs-admitted provider gap that would make
a per-provider rate wrong, the two places the audit trail's actor is thinner than it
looks, and why `isStaff` is still one undifferentiated tier.

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

Alia also remains the upstream of the proxy above. That does not change here:
removing it is conditioned on Kaana being LIVE, which is a claim about a
deployment Oxy can reach and not about a repository. The proxy kept a working
path when the edge took `/v1/chat/completions`; retiring it requires a verified
Kaana production route and a dated notice. See
[deprecation.md](./deprecation.md#the-alia-proxy-now-at-alia).

### A Python SDK — workstream 15

Not started, deliberately. [sdk.md](./sdk.md#there-is-no-python-sdk-and-this-is-not-the-moment-to-start-one)
gives the two reasons.

---

## The rest of this doc set

| Doc | What it covers |
|---|---|
| [sdk.md](./sdk.md) | `OxyInferenceClient`, the OpenAI SDK, the response headers, and what you actually observe |
| [credentials.md](./credentials.md) | The three credential lanes: native service tokens, `oxy_sk_*` machine keys, and why `oxy_dk_*` is never a bearer |
| [attribution.md](./attribution.md) | `accountId`, `applicationId`, `credentialId`, delegated `userId`, `requestId` — and why the delegated user never pays |
| [catalogue.md](./catalogue.md) | Model vs. revision vs. provider vs. deployment vs. routing profile, the canonical id forms, and the SDK's read methods |
| [routing.md](./routing.md) | Routing controls, fallback semantics, and exactly which controls are enforced |
| [byok.md](./byok.md) | Kaana PostgreSQL/KMS custody, provider connections, exact-ID mutations, same-operation recovery and closure fencing |
| [billing.md](./billing.md) | Reserve → settle → refund, exact amounts, price snapshots, and why dashboard usage is eventually consistent while a bill is not |
| [streaming.md](./streaming.md) | Streaming, cancellation, retries and idempotency |
| [data-policy.md](./data-policy.md) | What is retained, for how long, and where — plus what a route does with your payload |
| [deprecation.md](./deprecation.md) | The deprecation policy, why no date is published, and what will need one |
| [migration.md](./migration.md) | The scope migration, `oxy_dk_*`, `alia_sk_*`, and the retired `alia-*` model names |
| [alia.md](./alia.md) | Alia as a consumer: its registration, its scopes and the ones withheld, the internal cost centres, and the runbook for the operational steps |
| [rollout.md](./rollout.md) | The four rollout flags, shadow metering, the stage table, and the rollback plan an append-only ledger forces |
| [observability.md](./observability.md) | The `requestId` correlation column, why there is no metrics library, what each named metric is derivable from, and how staff actions are told apart from customer ones |

Ownership of every table, event and API across Oxy, the data plane and Alia is
in [architecture/inference-responsibility-matrix.md](../architecture/inference-responsibility-matrix.md).
