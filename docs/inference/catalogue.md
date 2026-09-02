# Model, deployment, routing profile — six things, not one

A catalogue that collapses any two of these starts lying to customers about
provenance, licence, residency or reproducibility. This page is the
developer-facing reading of
[ADR 0008](../adr/0008-catalogue-concept-separation.md), which is the decision
record.

**The catalogue is empty today.** The tables and the read API exist; what they
hold does not. `packages/api/scripts/seed-inference-catalogue.ts` seeds five
publisher slugs and **no models**, because the repository does not record which
weights Oxy can actually serve, under which contract, at what price. Every read
returns nothing.

There are therefore no example model ids on this page that you can call. The
ones below illustrate the grammar and are not claims that Oxy serves them.

---

## The six concepts

| Concept | What it is | Example |
|---|---|---|
| **Publisher** | who released the weights, and owns naming and licensing | `openai`, `meta`, `alia` |
| **Model** | a long-lived product identity; the stable thing you write in your code | `openai/gpt-5` |
| **Model revision** | an immutable point in that model's history | `openai/gpt-5@2026-05-01` |
| **Inference provider** | who *runs* the weights | a third party, Oxy's own hosting, or your own account under BYOK |
| **Deployment** | one concrete servable route: revision × provider × region × data policy × commercial permission | opaque to customers |
| **Routing profile** | a named strategy for CHOOSING among routes | `auto`, `fast`, `quality` |

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

A profile slug **cannot contain a slash**, so it can never be written in the
shape of a model id. That is what keeps "did I ask for a concrete model, or ask
Oxy to choose one?" decidable from the request alone.

Profiles are served from a separate collection with a separate identifier space
and are rendered separately. They may be selected wherever a model may be, and
the response always reports the concrete revision and serving deployment that
actually ran — that report is what makes a profile honest.

## Same-model failover is not cross-model fallback

Two features, two switches, and conflating them is what the platform's
"never silently substituted" invariant forbids.

- **Same-model deployment failover** — a different deployment of the *same*
  revision. Permitted by default; you got what you asked for.
- **Cross-model fallback** — a different model or revision. Never silent, never
  default, requires an explicit routing-policy opt-in, and emits a
  customer-visible route-switch event.

A request that named a concrete revision is never subject to cross-model
fallback, whatever the policy says.

**Neither is executed.** A switch between routes happens mid-request, and that
is routing EXECUTION, which belongs to the data plane — and there is no data
plane. What does exist is the authorisation: a cross-model substitution is
refused unless the destination is named in the policy version's own
authorisation rows, so the first implementation cannot quietly collapse the
distinction. [routing.md](./routing.md#fallback-two-features-two-switches) is the
detail.

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

From the SDK (`@oxyhq/core`):

```typescript
import type { ModelCatalogueEntry, RoutingProfile } from '@oxyhq/contracts';

const inference = oxy.inference();   // or new OxyInferenceClient({ credential: 'oxy_sk_…' })

const models: ModelCatalogueEntry[] = await inference.listModels();
const one: ModelCatalogueEntry = await inference.getModel('acme/some-model');
const profiles: RoutingProfile[] = await inference.listRoutingProfiles();
```

Run that today and `models` is `[]` and `getModel('acme/some-model')` throws a
404 — `acme/some-model` is written there to show the id GRAMMAR, not because Oxy
serves it. Nothing is wrong with your credential. The client is
[sdk.md](./sdk.md).

Types come from `@oxyhq/contracts` directly — `@oxyhq/services` does not
re-export them, and neither does `@oxyhq/core`.

Three behaviours to code against:

- **`[]` is a normal answer**, and is the only answer today. Render "no models
  available"; do not treat it as an error.
- **`getModel` takes a model id, not a model reference.** A pinned
  `<publisher>/<model>@<revision>` is rejected client-side rather than sent,
  because the catalogue is keyed on models and a pinned reference would 404
  indistinguishably from "no such model". An INVOKE, by contrast, accepts both
  forms — a pin there asks for exactly those weights.
- **A model you may not see answers 404 identically to one that does not
  exist.** Deliberately: distinguishing them would make the endpoint an
  existence oracle for what Oxy runs internally.

### Reads are audience-scoped

No principal, a plain user bearer, an `oxy_sk_…` machine credential and an
ordinary application's service token all resolve to the **public** audience. Only
an internal/system application's service token sees internal-only routes. The SDK
sends no audience of its own — whatever bearer it holds is the audience — and a
read that cannot establish a principal resolves public, which is the default-deny
direction.

No SCOPE is checked on a catalogue read. `inference:models:read` exists in the
vocabulary and is consulted by nothing; see
[credentials.md](./credentials.md#which-scopes-to-ask-for).

---

## What a catalogue entry tells you

`ModelCatalogueEntry` (`packages/contracts/src/inference/catalogue.ts`) is a
customer-safe **projection**: it repeats the customer-facing fields rather than
embedding the operational descriptors, so no internal deployment id, route id or
wholesale cost can reach you by being nested one level deeper than anyone looked.

- **Capabilities** — input/output modalities, tools, parallel tool calls,
  structured output, JSON mode, reasoning, streaming, prompt caching, max context
  and max output tokens.
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

- **`availabilityScope`** — `internal_alia`, `public_payg`, `enterprise`,
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

The catalogue never chooses a "primary" deployment to fill these singular
fields. In particular, it never sorts by availability scope, provider slug,
display name or database order and then presents that row's commercial terms as
the model's terms. Disagreement is represented conservatively by aggregation or
by omitting the singular field. The execution route is selected later under the
priority-score-exact-ID contract in [routing.md](./routing.md#ranking-after-qualification).

## A route that your policy forbids is a refusal

Your routing policy is resolved on every request and its version is recorded on
the envelope and on the settled receipt. It is also **applied to the candidate
routes before one is chosen** — which is the difference between a compliance
setting and a compliance claim (issue #1011).

Filtered against the route: `requireZeroDataRetention`,
`prohibitTrainingOnCustomerData`, `requireCommercialUseRights`,
`allowedLicenseIds`, `providerAllowlist`, `providerDenylist`, `allowedRegions`,
`deniedRegions`, `oxyHostedOnly`, `byokPreference` and `dedicatedCapacity`.
Three of them read the DEPLOYMENT's own data policy rather than the provider
organisation's default, because a zero-retention endpoint from a provider that
otherwise retains is a real and important case.

Two readings are worth stating outright, because the alternatives look
reasonable:

- **`allowedRegions` is a subset test, not an overlap.** A deployment declares
  every region it may serve from, and which one it picks is the data plane's
  decision — so a route that may run outside your allowed set cannot honour a
  residency requirement and does not qualify. Empty means no regional
  attestation, so the route fails closed under either an allow-list or a
  deny-list and is eligible only when neither is configured.
- **`requireZeroDataRetention` needs the route to actually not retain**, not
  merely to be capable of zero retention. `zeroDataRetentionAvailable` is a
  capability; a route carrying it while still retaining payloads by default is
  excluded.

When NO candidate satisfies your policy, the request is **refused** with
`policy_violation` (HTTP 403, never retryable) and the message names the controls
that excluded every route. It is never downgraded to a route the policy forbade,
and never served as though the policy were absent. A model that does not exist,
or that your credential may not see, still answers `model_not_found` — the two
are kept distinct because only one of them is yours to fix.

`maxPricePerUnit` and `maxPricePerRequest` are enforced against the price version
the route is actually charged at: a rate above your ceiling, a price in a
currency your ceiling is not quoted in, and a route with no published price at
all are all excluded. A unit the route's price does not charge for is not.
Kaana reports `requests: 1` exactly once per attempted request, so every servable
price version declares that unit explicitly; zero is valid and absence is
incomplete pricing. The catalogue can cheaply prefilter a route whose flat
`requests` fee alone breaks `maxPricePerRequest`, because no possible token count
can make that route affordable.

That prefilter is not the final decision. For each explicit profile priority,
the edge quotes the complete maximum cost of this request against every
candidate's pinned price version, including `requests: 1`, the input ceiling and
the applicable maximum output partitions. It excludes totals above the cap and
currencies that do not match. Within the first priority that retains a route,
score descending and exact deployment ID choose the first survivor. If the
caller omitted an output ceiling, that survivor's maximum fixes the implicit
output ceiling before lower priorities are resolved for capacity. A priority
whose routes all exceed the cap fixes nothing, so the next priority is evaluated
against its own candidates. If no route survives the full price check, the edge
returns `policy_violation` (403) before reservation and before Kaana. Full rules:
[routing.md](./routing.md#the-price-ceilings).

`optimiseFor` is not a qualification predicate: after every applicable control
has filtered the candidates, Oxy ranks them by explicit routing-profile
priority, then the selected score descending, then exact deployment ID by
ECMAScript UTF-16 code units. Kaana executes that signed order and does not
derive another from names or inventory order. Full rule:
[routing.md](./routing.md#ranking-after-qualification).

## What Oxy never exposes

Upstream provider secrets, internal route ids, deployment health scores and
wholesale costs. What it does expose, when you selected a concrete route and
policy allows attribution, is the model and publisher you actually got and the
provider that served it.
