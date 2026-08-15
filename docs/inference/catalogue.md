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

**Neither is implemented.** Routing execution belongs to the data plane, which
does not exist; the policy control plane is workstream 6. What exists is the
distinction, in the contracts and in this document, so the first implementation
cannot quietly collapse it.

---

## Reading the catalogue

The catalogue is mounted at `/models`, **not** `/v1/models` — `/v1/models` is
listed under workstream 4 and does not exist.

| Endpoint | Returns |
|---|---|
| `GET /models` | `{ data: ModelCatalogueEntry[], count }` |
| `GET /models/:publisher/:model` | `{ data: ModelCatalogueEntry }` |
| `GET /models/routing-profiles` | `{ data: RoutingProfile[], count }` |
| `GET /models/stats` | the same entries in the legacy envelope Console still parses |

From the SDK (`@oxyhq/core`):

```typescript
import type { ModelCatalogueEntry, RoutingProfile } from '@oxyhq/contracts';

const models: ModelCatalogueEntry[] = await oxy.listInferenceModels();
const one: ModelCatalogueEntry = await oxy.getInferenceModel('openai/gpt-5');
const profiles: RoutingProfile[] = await oxy.listInferenceRoutingProfiles();
```

Types come from `@oxyhq/contracts` directly — `@oxyhq/services` does not
re-export them, and neither does `@oxyhq/core`.

Three behaviours to code against:

- **`[]` is a normal answer**, and is the only answer today. Render "no models
  available"; do not treat it as an error.
- **`getInferenceModel` takes a model id, not a model reference.** A pinned
  `<publisher>/<model>@<revision>` is rejected client-side rather than sent,
  because the catalogue is keyed on models and a pinned reference would 404
  indistinguishably from "no such model".
- **A model you may not see answers 404 identically to one that does not
  exist.** Deliberately: distinguishing them would make the endpoint an
  existence oracle for what Oxy runs internally.

### Reads are audience-scoped

No principal, a plain user bearer, and an ordinary application's service token
all resolve to the **public** audience. Only an internal/system application sees
internal-only routes. The SDK sends no audience of its own — whatever bearer the
session holds is the audience — and a read that cannot establish a principal
resolves public, which is the default-deny direction.

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
- **Data policy** — whether payloads are retained and for how long, whether the
  route trains on customer data, whether zero data retention is available, and
  the named subprocessors. Structured rather than prose, because a routing policy
  is meant to enforce against these fields.
- **Regions** and the customer-safe **serving providers**.
- **Pricing** — a price snapshot, absent for routes you cannot buy per-unit
  (BYOK-only, internal).
- **Availability scope** and **commercial permission** — see below.
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

## What Oxy never exposes

Upstream provider secrets, internal route ids, deployment health scores and
wholesale costs. What it does expose, when you selected a concrete route and
policy allows attribution, is the model and publisher you actually got and the
provider that served it.
