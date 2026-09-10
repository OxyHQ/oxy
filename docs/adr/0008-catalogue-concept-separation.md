# ADR 0008 — Publisher, model, revision, provider, deployment and routing profile are six things, not one

- Status: accepted
- Date: 2026-08-15
- Issue: #972

## Context

The catalogue Oxy serves today is a hardcoded array of four objects in
`packages/api/src/routes/models-stats.ts:7-52`, mounted at `/models`
(`packages/api/src/server.ts:650`):

```text
alia-lite         'Fast and efficient for simple tasks'      tier free  creditMultiplier 0.5
alia-v1           'Balanced performance and quality'         tier free  creditMultiplier 1
alia-v1-pro       'Advanced reasoning capabilities'          tier pro   creditMultiplier 3
alia-v1-pro-max   'Maximum performance'                      tier pro   creditMultiplier 5
```

Its per-model statistics are literals: `avgLatencyMs: 0`, `uptime: 100`,
`successRate: 100`, `totalRequests: 0`, `isHealthy: true`
(`packages/api/src/routes/models-stats.ts:60-67`). The same four ids are copied
into the Console models documentation
(`packages/console/src/routes/_layout/documentation/models.tsx:13-43`), quoted as
request examples in the quickstart and chat-completions docs
(`packages/console/src/routes/_layout/documentation/quickstart.tsx:127`,
`documentation/chat-completions.tsx:109`), used as the Console playground's
default (`packages/console/src/routes/_layout/playground.tsx:103`), and used as
the default value of `AI_LABELING_MODEL`
(`packages/api/src/config/email.config.ts:100`).

None of these names identifies a model. There is no Alia-trained model called
`alia-v1`; the strings are product tiers that a proxy forwards to
`https://api.alia.onl/v1` (`packages/api/src/routes/alia.ts:7`), where something
else decides what actually runs. A customer cannot learn who published the
weights, which revision served their request, what licence applies, which region
it ran in, or whether their data was retained — because the identifier carries
none of that and never could.

The conflation is not only cosmetic. `creditMultiplier` prices a *tier*, so the
same price applies however the tier is served; `isHealthy` is a property of a
deployment attached to a name that has none; and a "tier" silently permits
serving a different model tomorrow, which is the behaviour invariant 9 of the
epic forbids.

## Decision

**Six distinct concepts, each with its own identity, lifecycle and owner.**

```text
Publisher            who released the weights                    anthropic, openai, meta, mistral, alia
Model                a named model line from a publisher         anthropic/claude-sonnet
ModelRevision        an immutable released version of a model    anthropic/claude-sonnet@2026-05-01
InferenceProvider    an organization that serves inference       anthropic-first-party, bedrock, together, oxy-hosted
Deployment           a concrete servable endpoint + region       provider × revision × region × capacity class
RoutingProfile       a customer-selectable policy object         auto, fast, quality, and customer-defined profiles
```

- A **Publisher** owns model naming and licensing. It is not a provider: Meta
  publishes Llama and serves nothing.
- A **Model** is a line, not an artifact. It is the stable thing a customer
  writes in their code.
- A **ModelRevision** is immutable. Once published, its id never refers to
  different weights. Behaviour changes get a new revision id; they never mutate
  one.
- An **InferenceProvider** is who runs it. The same revision served by two
  providers is two deployments, one model, one revision.
- A **Deployment** carries the operational facts — region, capacity, health,
  retention policy, zero-data-retention availability, upstream cost. Kaana owns
  its health and availability (ADR 0006); Oxy owns the customer-safe projection.
- A **RoutingProfile** is a *policy*, an object that selects among deployments
  under constraints. It is not a model and can never be a model.

### Canonical identifiers

```text
<publisher>/<model>                  the resolvable, stable customer-facing id
<publisher>/<model>@<revision>       an immutable pin
```

A request naming `<publisher>/<model>` is a request for that model, resolved to
some revision by policy. A request naming `<publisher>/<model>@<revision>` is a
request for exactly those weights and is either served or refused — never
substituted.

**`alia/*` is reserved for real Alia-owned or Alia-derived model releases.** Not
provider aliases, not prompt configurations, not product tiers, not a routing
profile wearing a model's name. A namespace that maps to "whatever Alia decided
to call it" is the failure this ADR exists to prevent, and it is worse than a
third-party name because it also makes a provenance claim.

### Routing profiles are not models

`auto`, `fast` and `quality` are **routing profiles or product presets**, served
from a separate collection with a separate identifier space, and rendered in a
separate section of Console. They may be selected wherever a model may be
selected, and the response always reports the concrete model revision and
serving deployment that actually ran — that report is what makes a profile
honest.

### Same-model failover is not cross-model fallback

Two different features, two different switches, and conflating them is what
invariant 9 forbids:

- **Same-model deployment failover** — a different `Deployment` of the *same*
  `ModelRevision`. Permitted by default; the customer got what they asked for.
- **Cross-model fallback** — a different `Model` or `ModelRevision`. Never
  silent, never default. It requires an explicit routing-policy opt-in and emits
  a customer-visible route-switch event.

A request that named a concrete revision is never subject to cross-model
fallback, whatever the policy says.

### This retires the fake Alia identities

`alia-lite`, `alia-v1`, `alia-v1-pro` and `alia-v1-pro-max` are **retired as
model identities**. They are not renamed, aliased or kept as compatibility model
ids, because a compatibility alias for a name that never identified a model
would preserve the exact ambiguity being removed. Each current use is replaced by
whichever of the six concepts it actually meant:

- `packages/api/src/routes/models-stats.ts` — the static array and its literal
  statistics are replaced by the real catalogue; the route is retired with it.
- `packages/console/src/routes/_layout/documentation/models.tsx` and the
  quickstart/chat-completions examples — replaced by real model ids, or by a
  clearly labelled routing profile where a preset is what is meant.
- `packages/console/src/routes/_layout/playground.tsx:103` — the default becomes
  a real catalogue entry resolved from the active account's configuration, not a
  hardcoded string.
- `packages/api/src/config/email.config.ts:100` (`AI_LABELING_MODEL`) — removed.
  Automatic labelling now uses Inbox's exact application id and exact configured
  routing-profile id through the authenticated Oxy-to-Kaana point-inference lane.

Workstream 15's migration guides own the customer-facing notice and the sunset
dates.

## Alternatives rejected

**Keep tier names as the public interface and hide the real model.** It is the
smallest change and it makes every property a serious customer needs —
provenance, licence, retention, region, reproducibility — permanently
unanswerable. It also makes "we quietly changed what your tier runs" invisible,
which invariant 9 forbids.

**Model and revision as one concept, with the version inside the name.** Works
until a publisher ships a same-name update, which they routinely do. Then either
the id lies or every customer must edit their code.

**Deployment as an attribute of a model.** The same revision on two providers in
three regions is not one thing with attributes; health, price, retention policy
and residency all differ per deployment, and flattening them means the catalogue
cannot answer a residency question.

## Consequences

- The Console models page, the playground and the documentation cannot ship real
  data until the catalogue exists; they are blocked on workstream 5, not on Kaana.
- Pricing attaches to a `(ModelRevision, unit, price version)` triple, not to a
  tier multiplier. `creditMultiplier` has no home in the new model and does not
  survive as a field.
- Because revisions are immutable, deprecation is a status plus a replacement
  pointer on the revision, never an in-place redefinition.
- The catalogue must express "exists but you may not use it": availability scope
  and commercial permission (workstream 11) are catalogue fields, so an
  internal-only route is representable without being publicly selectable.
- Every response that served a concrete route reports the model revision and the
  serving deployment in customer-safe form. Never the internal route id, never
  the upstream cost.
