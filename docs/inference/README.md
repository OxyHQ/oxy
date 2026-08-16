# Oxy inference platform — what exists, and what does not

**This page is the status board.** Everything else under `docs/inference/`
documents a mechanism that is already in the repository; this page is where the
gaps live, so a reader who finds a topic missing elsewhere finds the reason here
rather than assuming it was overlooked.

Read this first. **There is no public Oxy inference endpoint today**, and no
credential an external developer can obtain will call one.

Tracking issue: [OxyHQ/oxy#972](https://github.com/OxyHQ/oxy/issues/972).
Design decisions: [ADR 0005](../adr/0005-oxy-is-the-single-control-plane.md) ·
[0006](../adr/0006-oxy-relay-boundary.md) ·
[0007](../adr/0007-canonical-request-attribution.md) ·
[0008](../adr/0008-catalogue-concept-separation.md) ·
[0009](../adr/0009-usage-reservation-and-settlement.md) ·
[0010](../adr/0010-public-api-compatibility.md).

---

## The one-paragraph version

Oxy is the **control plane**: accounts, applications, credentials, scopes,
attribution, the model catalogue, the financial ledger and the Console. A
separate data plane (working name **Relay**, name not final — see
[ADR 0011](../adr/0011-inference-data-plane-name.md)) will own provider
adapters, routing execution, streaming and upstream cost measurement. The
control-plane half is being built now and much of it has landed; the data plane
does not exist, and the public edge that would join them does not exist either.

---

## What is built

| Capability | Where | Reachable by a caller? |
|---|---|---|
| The `inference:*` scope family | `packages/api/src/utils/applicationScopes.ts` | Grantable on an application/credential today |
| `oxy_sk_*` machine credentials — create, rotate, revoke, audit | `packages/api/src/routes/applications.ts`, `packages/api/src/utils/machineCredentialToken.ts` | **Creatable, but authenticates nowhere** |
| The `oxy_sk_*` bearer middleware | `packages/api/src/middleware/machineCredential.ts` | **Mounted on no route, deliberately** |
| Native service tokens (`clientId + clientSecret` → 1h JWT) | `POST /auth/service-token` | Yes — this is the one working machine lane |
| Exact financial ledger: reserve → settle → refund | `packages/api/src/services/inferenceLedger.service.ts` | **No request path calls it yet** |
| Price versions, spending limits, balances, invoices | `packages/api/src/db/schema/` | Schema only; no customer-facing route |
| Inference usage telemetry + daily rollups | `packages/api/src/db/schema/inferenceUsageEvents.ts` | Schema + recorder; no reader endpoint |
| Oxy↔data-plane contracts (Zod) | `packages/contracts/src/inference/` | Published as `@oxyhq/contracts` |
| Model catalogue tables + read API | `packages/api/src/routes/inferenceCatalogue.ts` | Yes — `GET /models`, `/models/:publisher/:model`, `/models/routing-profiles` |
| Catalogue read client in the SDK | `packages/core/src/mixins/OxyServices.inference.ts` | Yes |

**The catalogue itself is EMPTY.** The tables and the read API exist; the
contents do not. `packages/api/scripts/seed-inference-catalogue.ts` seeds five
publisher slugs and **no models**, because the repository does not record which
weights Oxy can serve, under which contract, at what price. `GET /models`
answers `[]`, and that is the correct answer, not a failure. Nothing in these
docs invents a model id to make an example look complete.

---

## What is NOT built

Each line names the workstream of #972 that owns it. Nothing here has a date,
for the reason given under [Sunset dates](#sunset-dates-cannot-be-published-yet).

### The public inference edge — workstream 4

- `POST /v1/responses` — does not exist.
- `GET /v1/models`, `GET /v1/models/:id`, `GET /v1/generations/:id` — do not
  exist. The catalogue read API that DOES exist is mounted at `/models`, not
  under `/v1`; see [catalogue.md](./catalogue.md). Nothing records a generation,
  so there is nothing for a receipt lookup to return.
- `POST /v1/embeddings`, `/v1/images/generations`, `/v1/audio/transcriptions`,
  `/v1/audio/speech`, `/v1/rerank`, `/v1/batches` — do not exist.
- **Streaming, client cancellation, retry semantics, idempotency keys and
  rate-limit/usage response headers are therefore undocumented on purpose.**
  There is no edge to have that behaviour, and writing it now would describe an
  interface nobody can call and nobody has yet had to make decisions about.

`POST /v1/chat/completions` does exist, and it is **not** that edge. It is the
pre-existing proxy that forwards a request body to Alia on one static
`ALIA_API_KEY` (`packages/api/src/routes/alia.ts`). Since #986 it refuses any
caller not acting for a platform-trusted first-party/internal application —
which is every credential an external developer can obtain. It reserves nothing,
meters nothing and attributes nothing, which is exactly why it is closed rather
than opened.

### The data plane — workstream 13

Relay does not exist: no repository, no adapters, no routing execution, no
streaming, no health scoring, no usage receipts from a real provider. Every
`Oxy → data plane` statement in the contracts package is a contract waiting for
a counterparty.

### Routing policy control plane — workstream 6

Per-application default model, provider allow/denylists, region and residency
constraints, zero-retention requirements, price ceilings, and the same-model
failover vs. cross-model fallback switches: the CONCEPTS are defined
([ADR 0008](../adr/0008-catalogue-concept-separation.md)) and the schemas exist
in `packages/contracts/src/inference/routingPolicy.ts`. No storage, no API and
no enforcement.

### BYOK provider connections — workstream 10

Metadata contract only (`packages/contracts/src/inference/providerConnection.ts`).
No secret storage, no validation, no rotation, no routing integration.

### Customer-visible usage and billing surfaces — workstreams 8, 9

The ledger and telemetry tables are populated by no request path and read by no
customer-facing endpoint. Console's models page, playground, usage and billing
screens are not wired to any of it.

### SDKs — workstream 15 (this one)

- `@oxyhq/core` has catalogue reads and credential management. It has **no
  inference request method**, because there is nothing to call.
- An OpenAI-style TypeScript client and a Python SDK are blocked on the HTTP
  contract of workstream 4 stabilising.

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
removing it is conditioned on Relay being live, and Relay does not exist.

---

## Sunset dates cannot be published yet

#972 asks for "explicit deprecation and sunset dates before removing
compatibility paths". **This documentation does not publish any, and inventing
them would be worse than omitting them.** Two reasons, both factual:

1. **There is no compatibility path to sunset.** `chat:completions` and
   `models:read` were removed rather than deprecated, because neither ever
   authorised anything — see [migration.md](./migration.md). A name nothing
   checked has no users to give notice to.
2. **A sunset date is meaningless before a launch date.** The public edge does
   not exist, so no external developer is depending on anything through it. The
   first real deprecation notice is owed when the first public interface ships,
   and it is owed by whoever ships it.

The one thing that *will* need a dated notice is the `POST /v1/chat/completions`
proxy, when workstream 4 replaces it. Its consumer set is knowable (only
platform-trusted first-party applications can reach it at all), so that notice
can be addressed to named applications rather than published to the world.

---

## The rest of this doc set

| Doc | What it covers |
|---|---|
| [credentials.md](./credentials.md) | The three credential lanes: native service tokens, `oxy_sk_*` machine keys, and why `oxy_dk_*` is never a bearer |
| [attribution.md](./attribution.md) | `accountId`, `applicationId`, `credentialId`, delegated `userId`, `requestId` — and why the delegated user never pays |
| [catalogue.md](./catalogue.md) | Model vs. revision vs. provider vs. deployment vs. routing profile, the canonical id forms, and the SDK's read methods |
| [billing.md](./billing.md) | Reserve → settle → refund, exact amounts, price snapshots, and why dashboard usage is eventually consistent while a bill is not |
| [migration.md](./migration.md) | The scope migration, `oxy_dk_*`, `alia_sk_*`, and the retired `alia-*` model names |
| [alia.md](./alia.md) | Alia as a consumer: its registration, its scopes and the ones withheld, the internal cost centres, and the runbook for the operational steps |

Ownership of every table, event and API across Oxy, the data plane and Alia is
in [architecture/inference-responsibility-matrix.md](../architecture/inference-responsibility-matrix.md).
