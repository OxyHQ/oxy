# The model catalogue

The concepts (model, revision, provider, deployment, power level) and the three
ways to call are explained in the [developer guide](./README.md). This page
covers the catalogue itself: the identifiers, how to read it, what an entry
contains, and how it is filled.

A catalogue that collapses any two of these starts lying to customers about
provenance, licence, residency or reproducibility. This page is the
developer-facing reading of
[ADR 0008](../adr/0008-catalogue-concept-separation.md), which is the decision
record.

**Two writers, one per audience.** The `platform_internal` catalogue that
official Oxy products (Alia, Inbox, …) read is written automatically by the
Kaana sync — see [Automatic sync from Kaana](#automatic-sync-from-kaana) and
[ADR 0027](../adr/0027-automatic-internal-catalogue-from-kaana.md). Nothing public
is written by it: a `public_payg` route still needs a reviewed resale
permission. `bootstrap-kaana-catalogue.ts` is no longer the production catalogue
writer; it remains the reviewed source for Inbox's `kaana-v1` profile and Alia's
speech route and profile. Query the live audience before claiming that a
catalogue is empty or available.

No example model id on this page is a callability claim. The values below
illustrate grammar; discover actual entries from the live audience-scoped read.

---

## The six concepts

| Concept | What it is | Example |
|---|---|---|
| **Publisher** | who released the weights, and owns naming and licensing | `openai`, `meta`, `alia` |
| **Model** | a long-lived product identity; the stable thing you write in your code | `openai/gpt-5` |
| **Model revision** | an immutable point in that model's history | `openai/gpt-5@2026-05-01` |
| **Inference provider** | who *runs* the weights | a third party, Oxy's own hosting, or your own account under BYOK |
| **Deployment** | one concrete servable route: revision × provider × region × data policy × commercial permission | opaque to customers |
| **Routing profile** (user-facing: **power level**) | a named strategy for CHOOSING among routes | `instant`, `high` (power levels are rolling out, see the [guide](./README.md#2-power-level--run-something-good-enough-at-this-level)) |

A publisher is not a provider: Meta publishes Llama and serves nothing. A model
is a line, not an artifact — its behaviour changes as revisions ship. A revision
is immutable: once published, its id never refers to different weights, and a
behaviour change gets a new revision rather than mutating one.

## Canonical identifiers

```text
<publisher>/<model>                 a model, resolved to some revision by policy
<publisher>/<model>@<revision>      exactly those weights
```

A request naming `<publisher>/<model>` asks for that model. A request naming
`<publisher>/<model>@<revision>` asks for exactly those weights and is either
served or refused — **never substituted.**

`alia/*` is reserved for models Alia actually owns or derived. Never provider
aliases, never prompt configurations, never product tiers. A namespace that maps
to "whatever we decided to call it" is worse than a third-party name, because it
also makes a provenance claim.

## A routing profile is not a model

A profile slug **cannot contain a slash** (the database CHECK and the wire
schema both refuse one), so it can never be mistaken for a model id. Profiles
are listed separately (`GET /v1/models/routing-profiles`) and have their own
identifier space. What a profile promises, and how it differs from naming a
model, is in the [developer guide](./README.md#three-ways-to-say-which-model-runs).
Same-model failover and cross-model fallback are defined once, in
[routing.md](./routing.md#fallback-two-features-two-switches).

---

## Reading the catalogue

The catalogue is mounted **twice, from the same router**: at `/models`, and at
`/v1/models` beside the inference edge. Same code, same audience rules, so it
cannot answer one thing at one path and another at the other. Use the `/v1` form
with an inference credential; either works.

| Endpoint | Returns |
|---|---|
| `GET /v1/models`, `GET /models` | `{ data: ModelCatalogueEntry[], count }` |
| `GET /v1/models/:publisher/:model` | `{ data: ModelCatalogueEntry }` |
| `GET /v1/models/routing-profiles` | `{ data: RoutingProfile[], count }` |
| `GET /models/stats` | the same entries in the legacy envelope Console still parses |

The id is **two path segments**, not one: a canonical model id contains a slash,
so a single `:id` segment would never match it.

From the SDK (`@oxy.so/core/inference`):

```typescript
import type { ModelCatalogueEntry, RoutingProfile } from '@oxy.so/contracts';
import { createInferenceClient } from '@oxy.so/core/inference';

const inference = createInferenceClient(oxy);   // or new OxyInferenceClient({ credential: 'oxy_sk_…' })

const models: ModelCatalogueEntry[] = await inference.listModels();
const one: ModelCatalogueEntry = await inference.getModel('acme/some-model');
const profiles: RoutingProfile[] = await inference.listRoutingProfiles();
```

`acme/some-model` is written there to show the id GRAMMAR, not because Oxy serves
it, and `getModel('acme/some-model')` therefore throws 404. `models` is `[]`
whenever the caller's live audience has no published entries; that answer alone
does not distinguish an empty catalogue from a deliberately withheld audience.
The client is [sdk.md](./sdk.md).

Types come from `@oxy.so/contracts` directly — `@oxy.so/services` does not
re-export them, and neither does `@oxy.so/core`.

### A listed model is a servable model

`GET /v1/models`, `GET /models`, `/models/stats` and the detail read list a model
only while at least one of its routes could be admitted by the edge **now**:

1. Kaana's current serving snapshot publishes its exact `deploymentId`. Kaana
   withholds a deployment it cannot serve (exhausted credential, sustained
   failure); Oxy reads the whole snapshot with the signed empty deployment query
   (`POST /internal/v1/deployments/query` `{}`), cached for 15 s and served stale
   for at most 2 min when a read fails. Past that the catalogue lists nothing
   rather than guessing (`kaanaDeploymentPublication.service.ts`);
2. its price version is active, effective and names that exact model revision
   and provider;
3. its reviewed scorecard names the same exact id and price version; and
4. its funding evidence is eligible — an `exhausted`, `rate_limited`, `unknown`,
   zero-balance or expired free/promotional allocation is not (see
   [routing.md](./routing.md#ranking-after-qualification)).

The edge applies condition 1 too: an unpublished deployment is dropped from the
candidate set before the authorized routes are signed (like capacity), instead
of being signed and then failing the exact attestation for the whole request.
When nothing published remains the edge answers `no_route_available` with
reason `no_published_deployment`; when the snapshot cannot be read at all it
answers `service_unavailable` (`routing_evidence:kaana-publication-unavailable`).

A policy `defaultTarget` and the documentation read still check the broader
*catalogued* set (every approved route), because "this model exists for you" is
a different question from "a request would be admitted now".

Three behaviours to code against:

- **`[]` is a normal answer.** Render "no models available"; do not treat it as
  a retryable error or infer production rollout state from it.
- **`getModel` takes a model id, not a model reference.** A pinned
  `<publisher>/<model>@<revision>` is rejected client-side rather than sent,
  because the catalogue is keyed on models and a pinned reference would 404
  indistinguishably from "no such model". An INVOKE, by contrast, accepts both
  forms — a pin there asks for exactly those weights.
- **A model you may not see answers 404 identically to one that does not
  exist.** Deliberately: distinguishing them would make the endpoint an
  existence oracle for what Oxy runs internally.

### Reads are audience-scoped

No principal, a plain user bearer, an unresolved credential and an ordinary
third-party application all resolve to the **public** audience. A live service
token or `oxy_sk_…` credential resolves its exact application row:
staff-classified `first_party`, `internal` and `system` applications also see
`platform_internal`; a revoked credential or suspended application does not.
The SDK sends no audience of its own — whatever bearer it holds resolves the
audience — and a read that cannot establish a live application principal
resolves public, which is the default-deny direction.

No SCOPE is checked on a catalogue read. `inference:models:read` exists in the
vocabulary and is consulted by nothing; see
[credentials.md](./credentials.md#which-scopes-to-ask-for).

### Rolling storage rename: three releases, in order

`internal_alia` is not a contract alias: schema v2/v3 rejects it and every API
response emits `platform_internal`. It survives temporarily only as a PostgreSQL
storage value so the previous API image remains rollback-safe while the new
image rolls out. The transition must not be collapsed into one deployment:

1. **Expand (this release).** A PRE migration widens the database CHECK to both
   storage values without rewriting rows. New code reads both, normalizes the
   legacy bytes to `platform_internal` before policy evaluation or output, and
   writes only `platform_internal`. Old pods therefore continue to see their
   existing rows during the rolling update. There is no general deployment
   authoring surface; the reviewed bootstrap was the only production writer in
   that release (the Kaana sync, ADR 0027, came later and is bridge-capable), and `APPLY=1` fails closed until its old-task-zero gate below
   succeeds.
2. **Backfill and contract (required follow-up).** Only after this release is
   fully deployed and its catalogue/edge readback passes, a separate POST
   migration rewrites `internal_alia` to `platform_internal` and restores a
   new-only CHECK. Keep the read bridge in that release, so rollback to this
   release remains safe.
3. **Remove the bridge (required follow-up).** After the post-migration readback
   reports zero legacy rows, a third release deletes the storage constant,
   dual-read predicate and normalization branch.

The two readbacks that authorize steps 2 and 3 are exact value counts, not names
or inferred routes:

```sql
SELECT availability_scope, count(*)
FROM inference_deployments
WHERE availability_scope IN ('internal_alia', 'platform_internal')
GROUP BY availability_scope
ORDER BY availability_scope;
```

Before step 2, prove the deployed image serves every expected exact deployment
ID from both stored values. Before step 3, require the query above to return no
`internal_alia` row. Skipping either follow-up leaves compatibility code active;
running either early makes rollback lose the internal catalogue.

#### Bootstrap gate during the expand release

Do not create a `platform_internal` row while a previous-image pod can receive
traffic: that pod only queries `internal_alia` and would silently miss the new
row. The only supported APPLY path during the bridge is the
`Bootstrap Kaana catalogue` workflow on `main`. Supply the reviewed exact live
`oxy-oxy-api:<revision>` ARN, the exact dedicated
`oxy-kaana-catalogue-bootstrap:<revision>` ARN, their shared immutable
`oxy-api@sha256:...` image, and the exact reviewer user ID. The two task
definitions are deliberately **different**: the one-shot has narrower S3 and
database authority and must not inherit the live API's credential environment.

The workflow, `.github/scripts/attest-kaana-catalogue-rollout.sh` and the
dedicated task's own live ECS reader enforce all of the following rather than
trusting an operator-pasted ARN:

- `oxy-api` is ACTIVE at the reviewed task definition, has positive desired
  count, running equals desired, pending is zero and the PRIMARY rollout is
  uniquely COMPLETED;
- every concrete RUNNING task uses that definition and every old deployment has
  zero running and pending tasks;
- two complete observations separated in time agree before `RunTask`; the
  one-shot independently repeats that proof before PostgreSQL access and again
  inside the transaction immediately before commit;
- the live and dedicated definitions both name the exact reviewed immutable
  image digest;
- the workflow shares the `deploy-oxy-api` concurrency lock with production
  deploy and rollback, then repeats the complete attestation after the one-shot;
- its OIDC role can only inspect the two required services/tasks, run the exact
  `oxy-kaana-catalogue-bootstrap:*` family on `oxy-cluster`, and pass the
  dedicated bootstrap plus fleet execution roles to ECS;
- the dedicated task reuses the live `kaana-publisher` network configuration,
  including its egress-only security group and `assignPublicIp`, rather than the
  API service's broader network identity;
- APPLY receives a timestamped attestation that expires after ten minutes. The
  process derives its own dedicated definition, cluster and image from the ECS
  v4 metadata endpoint, but never accepts that self-description as rollout
  proof: its task role must also read the live service and exact RUNNING task
  set using only `ecs:DescribeServices`, `ecs:ListTasks` and
  `ecs:DescribeTasks`;
- if the final live proof observes an old task, task-set change, incomplete
  PRIMARY rollout or image mismatch, it throws before transaction return and
  PostgreSQL rolls back every catalogue write.

Production APPLY is therefore blocked until oxy-infra PR #125 is merged,
applied, and live IAM readback proves those three ECS read actions on the
dedicated `oxy-kaana-catalogue-bootstrap` task role. No
`ecs:DescribeTaskDefinition` grant is required. Repository source or a merged
Terraform change alone is not evidence that the running task has the authority.

Dry runs remain available outside ECS because they write nothing. Direct/manual
APPLY is unsupported: copied environment values cannot replace the serialized
AWS checks, production approval and post-run readback in the workflow.

This makes the mixed-version boundary explicit: until the old task count is
zero there are no new-scope writes, and rollback during the rolling deployment
continues to read the untouched legacy rows. The shared workflow lock prevents
the supported deploy/rollback path from racing APPLY; an out-of-band mutation
that races the one-shot is also caught by its final live proof and aborts the
transaction. Once APPLY has created a new-scope row, rollback must target this
bridge-capable release (or a newer one), never the pre-bridge image. A later
out-of-band ECS mutation remains an incident and the workflow's post-run
attestation fails visibly. The bootstrap also rejects coexistence of legacy and
current rows for one logical deployment instead of selecting whichever row
PostgreSQL happens to return first.

---

## What a catalogue entry tells you

`ModelCatalogueEntry` (`packages/contracts/src/inference/catalogue.ts`) is a
customer-safe **projection**: it repeats the customer-facing fields rather than
embedding the operational descriptors, so no internal deployment id, route id or
wholesale cost can reach you by being nested one level deeper than anyone looked.

- **Capabilities** — input/output modalities, tools, parallel tool calls,
  structured output, JSON mode, reasoning, the `reasoningEfforts` a request may
  name (`low`/`medium`/`high`; empty means no effort control), streaming, prompt
  caching, max context and max output tokens — and, from contract set 3.2.0,
  the request dialects routes can execute (`apiFormats`) and the realtime
  sessions it holds (`realtime`), present only when declared. An undeclared
  model is served under the rules that predate the declaration and is never
  authorized for spoken output or a realtime session; see
  [realtime.md](./realtime.md).
- **`releasedAt`** — when the upstream provider reports it published the model;
  absent when no provider reported one. Never an Oxy or Kaana observation time.
- **License** — SPDX id where one exists, whether commercial use is permitted,
  and whether attribution is required.
- **Provenance** — `first_party_original`, `first_party_derived`, `open_weight`
  or `third_party_hosted`, plus the base model where there is one.
- **Data policy** — the conservative guarantee across every visible deployment:
  any retention or training applies, the longest retention applies, zero-data-
  retention availability requires every route, subprocessors are the union, and
  a policy URL appears only when all routes agree. Structured rather than prose,
  because your routing policy is enforced against route-level fields — see "A
  route that your policy forbids is a refusal" below.
- **Regions** and the customer-safe **serving providers**, aggregated as unions.
- **Pricing** — one price snapshot only when every visible route names the same
  resolvable price version; otherwise absent.
- **Availability scope** and **commercial permission** — each present only when
  every visible route agrees; see below.
- **Deprecation** — status plus the replacement to migrate to. An `active` model
  has no sunset date; the deprecation must be announced first.
- **Evaluations, safety metadata and model-card URL** — these hang off a
  revision, because they describe specific weights.

## "It answers" is not "you may resell it"

A technically callable route is not automatically publicly available. Two
explicit fields decide, and they are checked rather than inferred:

- **`availabilityScope`** — `platform_internal`, `public_payg`, `enterprise`,
  `byok_only`, `oxy_hosted`.
- **`commercialPermission`** — `standard_application_use`,
  `public_resale_approved`, `wholesale_contract`, `customer_byok`,
  `open_weight_hosting`.

A `public_payg` route requires an approved resale permission
(`public_resale_approved`, `wholesale_contract` or `open_weight_hosting`); the
contract refuses the combination otherwise. This is why the public catalogue is
empty rather than merely unpopulated: default-deny is the starting state, and a
route becomes public when somebody reviews the right to resell it, not when it
starts answering.

`platform_internal` is distinct from `oxy_hosted`: the first says that an
official Oxy product may consume a reviewed route without public resale rights;
the second says Oxy operates the model deployment itself. A third-party-hosted
provider can therefore be `platform_internal`, and an Oxy-hosted open-weight
model can be publicly offered when its separate commercial permission allows it.

The catalogue never chooses a "primary" deployment to fill these singular
fields. In particular, it never sorts by availability scope, funding class, provider slug,
display name or database order and then presents that row's commercial terms as
the model's terms. Disagreement is represented conservatively by aggregation or
by omitting the singular field. The execution route is selected later under the
priority-funding-score-exact-ID contract in [routing.md](./routing.md#ranking-after-qualification).

## A route that your policy forbids is a refusal

Your routing policy is applied to a model's candidate routes before one is
chosen. When no route satisfies it, the request is refused with
`policy_violation` (403), never downgraded. A model that does not exist, or that
your credential may not see, answers `model_not_found` instead. Every control,
the price ceilings and the ordering of survivors are in
[routing.md](./routing.md#what-is-enforced-today). That page is the only
statement of them.

## What Oxy never exposes

Upstream provider secrets, internal route ids, deployment health scores and
wholesale costs. What it does expose, when you selected a concrete route and
policy allows attribution, is the model and publisher you actually got and the
provider that served it.

---

## Automatic sync from Kaana

Decided by the owner on 2026-09-25 and recorded in
[ADR 0027](../adr/0027-automatic-internal-catalogue-from-kaana.md): official Oxy
products list and call **every** model Kaana discovers, with nothing
hand-curated in between. `packages/api/src/services/kaanaCatalogueSync.service.ts`
does it.

### What runs, and when

- Every API task registers a 30-minute schedule (first run a minute after boot);
  a PostgreSQL advisory lock lets exactly one run at a time and the others
  return `status: skipped, reason: locked`. A task without the complete Kaana
  signing binding registers nothing.
- `POST /inference/admin/catalogue/sync` (staff with `inference:catalogue:publish`)
  runs it now and returns the summary. `allowMassRetirement: true` confirms a
  report that would retire more than half of the synced routes.
- One run is one transaction: a failure writes nothing.

### Where the facts come from

1. `GET /internal/v1/models` (signed): per model line `model`,
   `modelReference`, `displayName?`, `createdAt?`, `contextTokens?`,
   `maxOutputTokens?`, `inputModalities?`, `outputModalities?`,
   `supportsTools?`, `reasoningEfforts?`, `acceptedParameters?`, `providers?`
   and `listPrices?` — one
   `{ deploymentId, provider, currency, input, output }` per deployment whose
   provider publishes a price, in USD per million tokens.
2. `POST /internal/v1/deployments/query` (signed, batches of 64): the exact
   provider, revision-pinned reference and region set of every priced
   deployment. This is the same evidence the edge's preflight later compares,
   so the stored route is byte-for-byte what will be signed. A descriptor's
   optional `acceptedParameters` (per deployment) is read when Kaana sends it;
   the preflight never compares it.
3. The provider's `inference_providers` row: the route's data policy
   (retention, training, zero-data-retention, policy URL). A provider without a
   row is not synced — adding one is the only manual step left.

### What it writes

| Row | Value |
|---|---|
| `inference_publishers` | created from the model id's publisher slug when absent |
| `inference_models` | `catalogue_source = 'kaana_sync'`; limits, modalities, tools and `reasoning_efforts` from Kaana; `provider_released_at` from `createdAt`; licence and provenance as below |
| `inference_model_revisions` | Kaana's revision label, made current; `released_at` = first observation |
| `inference_deployments` | `platform_internal`, `standard_application_use`, `approved`, `auto_approval_policy_id = 'kaana-sync'`, the attested regions, the provider's data policy, `accepted_parameters` (below) |
| `price_versions` | USD, from the list price: input, cached input (at the input rate), output, reasoning (at the output rate) per million tokens, `requests` at zero. A changed list price SUPERSEDES the active version |
| `inference_deployment_routing_scores` | `price` score = minus the cost of 1M input + 1M output tokens in cents; latency, throughput and balanced unscored (`not-measured:kaana-sync`); `standard_payg`, `available` |

Synced licence and legal fields record the policy, not a review:
`LicenseRef-Oxy-Serving-Provider-Terms`, `commercialUseAllowed: false` (not
asserted, so `requireCommercialUseRights` excludes these routes),
`requiresAttribution: true`, `releaseKind: third_party_hosted`, legal evidence
`auto-approval-policy:kaana-sync` with no reviewer. ADR 0027 has the table.

### Accepted request parameters

`inference_deployments.accepted_parameters` is the set of request controls
(`maxOutputTokens`, `reasoning.effort`, `responseFormat`, `sampling.*`,
`toolChoice`, `tools`; Kaana's closed vocabulary, OxyHQ/Kaana#124) that one
route's upstream accepts. NULL is unknown and filters nothing; `[]` is a
statement. The sync takes the deployment's own descriptor set when Kaana
sends one; otherwise the catalogue entry's set, which is an intersection over
the line's reporting deployments, is stored only when every deployment of the
line is on one provider. A multi-provider intersection proves what every
reporter accepts, not what any one refuses, so those routes stay unknown.

The edge never signs a route whose known set lacks a control the request
carries (Kaana's Translate would refuse it with `invalid_request` before any
other authorized route is tried). Every completion carries `maxOutputTokens`,
because the edge always bounds output to size the hold; a `text` response
format and an empty stop list carry nothing. When no route remains the edge
answers `400 invalid_request` with `param` naming the control
(`reason: unsupported_parameter`), before any hold or Kaana call.

### What it refuses to do

- **Invent a required value.** A line missing `contextTokens`,
  `maxOutputTokens` or modalities, or with no priced and attested route, is
  skipped and counted in the summary (`models.skipped`,
  `deployments.skipped`, first 200 names in `skippedModels`).
- **Describe non-text output.** Migration 0050 requires a reviewed provenance
  marking for media; image/audio/video/embedding lines are skipped
  (`non_text_output_unreviewed`). Alia's speech route stays reviewed.
- **Touch a reviewed row.** Rows with `catalogue_source = 'reviewed'` or
  `auto_approval_policy_id IS NULL` keep every reviewed fact; only
  `reasoning_efforts` is kept current on a reviewed model.
- **Publish `alia/*`**, which is reserved for first-party releases.
- **Retire on a broken report.** An empty report is refused outright; one that
  would retire more than half of the synced routes is withheld and logged
  (`inference.catalogue_sync.retirement_withheld`) unless confirmed.

### Retirement and the emergency brake

A synced deployment Kaana no longer reports is set `status = retired`,
`permission_state = retired` on the next run, which removes it from every
catalogue read and route resolution. The same row is revived if Kaana reports it
again.

`inference_catalogue_blocklist` is empty by default.
`POST /inference/admin/catalogue/blocklist` `{ modelId, reason }` retires the
line's synced routes in the same commit and the sync skips it from then on;
`DELETE /inference/admin/catalogue/blocklist/:publisher/:model` lifts it, and the
line returns at the next run. `GET` lists it. Setting `enabled = false` on the
`kaana-sync` row of `inference_catalogue_auto_approval_policies` stops the sync
entirely; existing routes keep serving until retired.

### Routing a synced model

A synced route carries only a `price` score, so it is selectable under
`optimiseFor: 'price'`. An official application with no routing policy of its
own is served under `platform-internal-default@1`, which ranks on `price` and
authorizes same-model deployment failover only ([routing.md](./routing.md)). A policy optimising for
latency, throughput or balanced finds no score on a synced route and refuses
with `no_route_available` (`routing_evidence:missing-score`) until measured
scores exist.

The readiness census (`verify-inference-routing-readiness.ts`, the daily expiry
monitor) holds a synced price-only route to its price evidence alone: no expiry.
It refuses one sharing a model revision with a measured route, because that
candidate would make the whole set refuse any non-price objective.

### Private structured decisions output

Model output vocabulary includes `decisions`; request and input modalities retain
the existing five values. A signed observation with exactly `outputModalities:
['decisions']` is imported only through exact, locally reviewed, unexpired private
3.6/v3 or 3.7/v4 deployment authority and its matching attestation. Oxy derives
`apiFormats: ['decisions']` from that negotiated decisions-only contract, rather
than claiming the provider or catalogue returned an `apiFormats` field.

The importer preserves `disabled`, `pending_review` and the separate legal gate.
It grants no public offer or execution authority. Ordinary and mixed media
outputs remain excluded. A genuine subsequent text-only observation removes
only the previously derived decisions-only capability; other declared formats
and reviewed model facts remain untouched. Migration 0145 permits structured
decisions without invented filtering or watermark metadata in both provenance
trigger directions; image/audio/video/embedding still require marking.
