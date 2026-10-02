# Oxy inference: developer guide

**Start here.** This page is the one place that explains how an Oxy app asks
for a model. The other pages under `docs/inference/` go deep on one topic each
and link back here for the concepts.

Every feature below is marked:

- **Live**: on `main` in Oxy and Kaana. Whether a given environment runs
  that code is a separate question (see [status.md](./status.md)).
- **Rolling out**: decided and being built. Not on `main` yet, so don't
  depend on it.
- **Proposed**: an idea only. Not available.

---

## The mental model

```text
                 one-shot feature (summarise, translate, classify, smart reply)
  Your app  ─────────────────────────────────────────────────────┐
     │                                                           ▼
     │  conversation / agent / tools / memory          Oxy inference edge  ───────►  Kaana  ───────►  Provider
     └─────────────────────────────────►  Alia  ─────►  api.oxy.so/v1               kaana.ai          (Groq, xAI, OpenRouter, …)
                                                        auth · app policy ·          runs the call ·
                                                        billing · picks and          provider keys ·
                                                        signs the routes             retries · failover ·
                                                                                     measures usage
```

| Layer | Owns | Never does |
|---|---|---|
| **Your app** | the feature, the prompt, which mode to use (or none, to use the app default), and showing errors to the user | hold a provider key, call a provider, retry or switch models on failure |
| **Alia** (conversations and agents only) | conversations, memory, tools, approvals, agent identity. It shows users **power levels**, not model names | hold provider keys, retry or fail over on its own |
| **Oxy edge** | authentication, the app's policy (default target, allowed levels), billing (reserve then settle), turning a power level into candidate models, choosing and ordering the routes, signing the request | call a provider |
| **Kaana** | running the request: provider keys, same-route retries, failover across the signed routes, streaming, cancellation, usage measurement | pick a model or route outside Oxy's signed list, price anything, bill anyone |

Which path a product feature takes is decided per feature in
[request-routing.md](./request-routing.md#choose-the-path-by-product-behavior).

---

## Three ways to say which model runs

A request names **one** target, or names none and gets the app's default.

### 1. Exact model — "run this model"

```text
openai/gpt-oss-120b                          a model: its current revision
openai/gpt-oss-120b@observed-2026-09-01      a revision: exactly these weights
```

- Only that model runs. It is **never replaced by another model** (live).
- Retries and failover stay on the same model. Kaana retries the same route,
  and can move to another provider of the **same** model only when that
  provider is on the signed route list. Other deployments of the same model
  are on that list **by default** (live): an app opts out with
  `fallback.sameModelDeployment: false` or `fallback.disabled: true`. See
  [routing.md](./routing.md#fallback-two-features-two-switches).
- A model id always contains a `/`. A power level never does, so a request
  always shows which kind of target it names.

### 2. Power level — "run something good enough at this level"

A power level (technical name: **routing profile**) is a slug with no `/`. The
platform picks an available model of that level (**live**). Each level has a
fixed `routingProfileId` (`power-<level>`, e.g. `power-instant`), the same in
every environment:

| Power level | Models | Reasoning effort | Use it for |
|---|---|---|---|
| `auto` | the cheapest level that suffices | that level's | the platform decides per request |
| `instant` | very cheap, fast small models | none | short summaries, smart replies, labels |
| `medium` | mid-size models | `low` | everyday assistant work |
| `high` | strong models | `medium` | harder reasoning and longer tasks |
| `xhigh` | the `high` models | `high` | even harder reasoning |
| `pro` | frontier models | `high` | the most capable models, higher cost and latency |
| `ultra` | the heaviest frontier models | `high` (the maximum) | the top tier, highest cost and latency |

Which model belongs to which level is reviewed catalogue data with a cited
public benchmark source, never guessed from a model's name. The table, the
sources and the `auto` rules are in [power-levels.md](./power-levels.md).

What a power level promises:

- Each level sets a reasoning effort, applied only on a model that accepts it,
  so you normally don't send one yourself (live). An effort you do send wins.
- Only **servable** models are candidates: published by Kaana right now, with
  complete price, score and funding evidence (live).
- Candidates are ordered by cost to the platform (free allowance → discounted
  pay-as-you-go → promotional credit → standard paid), then price.
- Two requests at the same level can run on different models, and a failing
  model can be replaced by **another model of the same level** (live). The
  switch is reported as a `route_switch` event and recorded against the
  level.
- The response always names the **concrete model that ran**: `model` in the
  body, `X-Oxy-Model` in the headers (live).
- A realtime voice session is refused a power level. It must name an exact
  model (live).

Name a level with `routingProfile` (slug), `routingProfileId` (exact ID), or
`model` on either chat dialect (`"model": "instant"`). `GET
/v1/models/routing-profiles` lists each level with its current candidates,
`powerLevel` and `reasoningEffort`. The older product-specific profiles
(`kaana-v1`, which Inbox used before `instant`, and `kaana-v1-speech` for Alia
speech) are not power levels.

**Proposed** profiles (not available): cheapest/free, fastest, capability
profiles (vision, code, long context), data or region constraints, and
model-family preference.

### 3. App default — "whatever this app is configured for"

Send no target. The edge uses the app's routing policy `defaultTarget`, which
can be an exact model or a power level (**live**). If the app has no default,
the request is refused with `invalid_request` (400).

Each app can also restrict itself to an **allowed set of power levels** with
the policy's `allowedRoutingProfileIds` (**live**). A request naming a level
outside the set is refused with `policy_violation` (403) before anything is
reserved; `auto` only climbs to allowed levels; and the default must be one of
the allowed levels. Empty means no restriction:

| App | Default | Allowed |
|---|---|---|
| Oxy Inbox (summaries, smart replies) | `instant` | `instant` only |
| Alia | set by Alia | the levels Alia shows its users. Users never see model names |

Policies are set per application or per account, and changes are versioned.
See [routing.md](./routing.md#where-a-policy-lives).

### Which mode should my app use?

| Your situation | Use |
|---|---|
| A background feature where the app decides the quality: summaries, smart replies, classification, translation | **App default** set to a power level. Send no target |
| An assistant where the user picks "fast" vs "smart" | **Power level**, through Alia. Never show model names |
| You don't know which level fits | **`auto`** |
| You need one specific model: a capability only it has, a contract, a customer's choice | **Exact model** `publisher/model` |
| Evals, regression tests, reproducible output | **Exact model** pinned with `@revision` |
| A realtime voice session | **Exact model** (a power level is refused) |

---

## Calling it

Base URL: `https://api.oxy.so/v1`. Which credential you use is in
[sdk.md](./sdk.md#which-credential-you-hold-decides-which-lane-you-are-on). The
model ids here show the format only. To see what your app can use, call
`listModels()` / `GET /v1/models`.

### TypeScript SDK (`@oxy.so/core/inference`)

```typescript
import { OxyInferenceClient, createInferenceClient } from '@oxy.so/core/inference';

// A server with an oxy_sk_… key:
const inference = new OxyInferenceClient({ credential: process.env.OXY_API_KEY });
// Or inside a signed-in Oxy app:
// const inference = createInferenceClient(oxyServices);

// 1. Exact model
await inference.respond({ model: 'openai/gpt-oss-120b', input: 'Translate to French: hello' });

// 2. Power level
await inference.respond({ routingProfile: 'instant', input: 'Summarise this thread: …' });

// 3. App default: name nothing
const answer = await inference.respond({ input: 'Summarise this thread: …' });

answer.model;            // the concrete, revision-pinned model that ran
answer.servingProvider;  // who served it
answer.requestId;        // quote this in bug reports
```

`inference.stream(request)` takes the same targets. See [streaming.md](./streaming.md).

### Raw HTTP

```bash
# Exact model
curl https://api.oxy.so/v1/responses \
  -H "Authorization: Bearer $OXY_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"openai/gpt-oss-120b","input":"Translate to French: hello"}'

# Power level
curl https://api.oxy.so/v1/responses \
  -H "Authorization: Bearer $OXY_API_KEY" -H 'Content-Type: application/json' \
  -d '{"routingProfile":"instant","input":"Summarise this thread: …"}'

# App default
curl https://api.oxy.so/v1/responses \
  -H "Authorization: Bearer $OXY_API_KEY" -H 'Content-Type: application/json' \
  -d '{"input":"Summarise this thread: …"}'
```

The OpenAI-compatible `POST /v1/chat/completions` works with a stock OpenAI
client. Its `model` field takes an exact model **or** a power level
(`"model": "instant"`, live): a value with no `/` is a level, never a guessed
publisher. See [sdk.md](./sdk.md#the-openai-sdk-unmodified).

---

## When a request fails

### The platform already retried. Don't retry yourself.

Before you see an error, Kaana has already done the following (**live**,
[Kaana#131](https://github.com/OxyHQ/Kaana/pull/131)):

1. **Retried the same route** on a transient failure (rate limit, overload,
   timeout, provider 5xx): up to **2 retries**, with at most **15 s** of
   waiting in total, and honouring the provider's `Retry-After`.
2. **Moved to the next signed route** (failover) when the route kept failing.
3. Done all this **only before the first output byte**. Once text has
   reached you, a failure ends the stream and nothing is retried, so you
   never get the start of one answer spliced onto another.

So apps and Alia must **not**:

- wrap calls in retry loops, or turn on an SDK's automatic retries (set
  `max_retries=0` on the OpenAI client),
- catch an error and call a different model instead,
- keep their own lists of providers or models to fail over to.

Adding another retry layer multiplies load while a provider is already
struggling. It also bypasses billing and policy, and it hides the error the
user should see.

### What the error means

Every error has a `code`, a `retryable` flag and a `requestId`. Branch on
`code` and `retryable`, never on the HTTP status (two different codes can
share one status). The full rules are in [streaming.md](./streaming.md#retries).

| Codes | Meaning | What your app does |
|---|---|---|
| `invalid_request`, `context_length_exceeded`, `output_limit_exceeded`, `unsupported_modality`, `request_too_large`, `upstream_content_filtered` | the request itself is the problem | fix the request. Never retry it as it is |
| `authentication_failed`, `permission_denied`, `insufficient_scope`, `model_not_found`, `policy_violation`, `commercial_permission_denied` | credentials, scopes or app policy, or the model isn't visible to this app | fix the configuration. `policy_violation` names the policy control that excluded every route |
| `insufficient_balance`, `spending_limit_exceeded`, `quota_exceeded` | money or quota on **your** account | tell the user or the account owner |
| `rate_limited`, `deployment_unavailable`, `provider_error`, `provider_timeout`, `provider_overloaded` (`retryable: true`) | the platform retried and every authorized route is still failing | show "try again later". A background job may be rescheduled after `retryAfterMs`. Don't loop |
| `no_route_available`, `service_unavailable`, `provider_credential_invalid`, `provider_billing_refused`, `internal_error` | a platform-side problem, not yours | report it with the `requestId` |
| `idempotency_conflict` (409) | an earlier request with that `Idempotency-Key` was accepted | read its result from `GET /v1/generations/:id`. Don't resend |
| `cancelled` (499) | you cancelled the request | normal. Only the units already produced are billed |

---

## How the platform picks a route

You only need this section when debugging. The full rules are in
[routing.md](./routing.md).

1. **Resolve the target**: the exact model, the power level's candidate
   models, or the app default.
2. **Keep only servable routes.** Oxy lists or chooses a model only while at
   least one of its deployments is in Kaana's current serving snapshot and has
   a complete, effective price, a matching scorecard and eligible funding
   (live in Oxy; see [catalogue.md](./catalogue.md#a-listed-model-is-a-servable-model)).
   The catalogue sync also retires deployments Kaana stops reporting (live).
   Kaana withholding deployments whose keys are all exhausted or rejected, or
   that fail persistently, is Kaana's side (**rolling out** there); Oxy drops
   them as soon as Kaana stops publishing them.
3. **Apply the app's policy**: data retention, regions, providers, licences
   and price ceilings. If no route passes, the request is refused. It is never
   downgraded to a route the policy forbids (live).
4. **Order what's left by cost to the platform**: (1) free allowance, then
   (2) discounted pay-as-you-go, then (3) promotional credit, then
   (4) standard paid usage (live in Oxy). After that, by score, then by exact
   deployment ID.
5. **Sign the ordered route list** and send it to Kaana. Kaana tries the routes
   in exactly that order, with the retries described above.

---

## Glossary

| Term | Meaning |
|---|---|
| **Model** | a long-lived model identity, `publisher/model`. What you write in code |
| **Revision** | one fixed version of a model's weights, `publisher/model@revision`. It never changes |
| **Publisher** | who released the weights (`openai`, `meta`, …). Not necessarily who runs them |
| **Provider** | who runs the weights (Groq, xAI, OpenRouter, …, or your own account under BYOK) |
| **Deployment** | one concrete way to run a revision: revision × provider × region × data policy. It has an opaque `deploymentId` |
| **Route** | a deployment as it appears in one request's signed, ordered list (`authorizedRoutes`) |
| **Power level** / **routing profile** | a named way to *choose* a model (`instant`, `high`, …). "Power level" is the user-facing name; "routing profile" is the technical name used in the API (`routingProfile`, `routingProfileId`). A power level is not a model |
| **Routing policy** | an app's or account's settings: default target, allowed levels, data, region and price constraints, and fallback switches. See [routing.md](./routing.md) |
| **Default target** | the model or power level a request gets when it names neither |
| **Retry** | Kaana trying the **same route** again after a transient failure |
| **Failover** | moving to **another route** on the signed list. For an exact model, only another deployment of the same model |
| **Fallback (cross-model)** | moving to a **different model**. Allowed among a routing profile's (power level's) candidates. For an exact-model request, only to models the app's policy names in `fallback.authorizedCrossModel`, and never when the request pinned a `@revision`. Always reported as a `route_switch` |
| **Audience** | which catalogue an app can see: public, or `platform_internal` for official Oxy apps. See [catalogue.md](./catalogue.md#reads-are-audience-scoped) |
| **Funding class** | how a route is paid for: free allowance, discounted pay-as-you-go, promotional credit, or standard paid. Sets the order in step 4 above |
| **BYOK** | "bring your own key": a customer's own provider account. See [byok.md](./byok.md) |

---

## What is live and what is rolling out

| Feature | Status |
|---|---|
| Exact model and pinned revision; never replaced by another model | Live |
| Response names the concrete model that ran | Live |
| `routingProfile` / `routingProfileId` request fields; `GET /v1/models/routing-profiles` | Live |
| Per-app `defaultTarget` (model or routing profile) | Live |
| Kaana same-route retry (2 retries, 15 s budget) and failover until the first output | Live ([Kaana#131](https://github.com/OxyHQ/Kaana/pull/131)) |
| Funding-class ordering: free allowance → discounted pay-as-you-go → promotional credit → standard paid | Live in Oxy. Exact per-deployment key binding is in Kaana source. Its production cutover is tracked in Kaana `docs/schema-0013-cutover-2026-09-24.md` |
| Same-model provider failover for exact-model requests | Live, on by default; a policy opts out with `fallback.sameModelDeployment: false` |
| Power levels `auto`, `instant`, `medium`, `high`, `xhigh`, `pro`, `ultra`, with their reasoning efforts | Live ([power-levels.md](./power-levels.md)) |
| `auto` choosing the cheapest level that is good enough, per request | Live (deterministic v1 rules) |
| Cross-model failover among a routing profile's candidates | Live, power levels included |
| Per-app allowed levels (Inbox → `instant` only; Alia exposes levels, never model names) | Live (`allowedRoutingProfileIds`); each app's policy is configuration to set |
| Naming a power level in `model` (for OpenAI-compatible clients) | Live |
| Only servable models listed or chosen (published by Kaana, complete price/score/funding evidence) | Live in Oxy. Kaana withholding exhausted or persistently failing deployments: rolling out in Kaana |
| cheapest/free, fastest, capability, data/region and family-preference profiles | Proposed |

Whether an environment actually serves a feature is a rollout question. The
flags, gates and dated evidence are in [status.md](./status.md) and
[rollout.md](./rollout.md).

---

## Deep docs

| Doc | Read it when you need |
|---|---|
| [status.md](./status.md) | what is built, where it lives, and which rollout gates remain |
| [request-routing.md](./request-routing.md) | which product features go through Alia and which call Oxy directly, and provider-key custody |
| [sdk.md](./sdk.md) | `OxyInferenceClient`, the OpenAI SDK in TypeScript and Python, response headers |
| [credentials.md](./credentials.md) | service tokens, `oxy_sk_*` machine keys, scopes |
| [catalogue.md](./catalogue.md) | reading the model catalogue, what an entry contains, and the Kaana catalogue sync |
| [routing.md](./routing.md) | routing policies and every control, fallback switches, and the exact route-ordering rule |
| [streaming.md](./streaming.md) | stream events, cancellation, retryability and idempotency |
| [realtime.md](./realtime.md) | audio chat and realtime voice sessions |
| [billing.md](./billing.md) | reserve → settle → refund, prices, spending limits |
| [internal-metering.md](./internal-metering.md) | `commercial` vs `internal_metered` (Alia → Kaana), durable usage and provider cost, the cost-centre usage report |
| [attribution.md](./attribution.md) | who is charged, and delegated users |
| [byok.md](./byok.md) | using your own provider key |
| [data-policy.md](./data-policy.md) | what is retained, and what a route does with your data |
| [alia.md](./alia.md) | Alia as an inference consumer: registration, scopes, product agents |
| [inbox-point-inference.md](./inbox-point-inference.md) | Inbox's one-shot features and their bootstrap |
| [inbox-principal-readback.md](./inbox-principal-readback.md) | Read-only proof of the Inbox principal, its authority and its granted credit |
| [jev-principals-readback.md](./jev-principals-readback.md) | Metadata-only readback of the Mention workload and Kaana principals |
| [migration.md](./migration.md) · [deprecation.md](./deprecation.md) | retired names and keys, and the deprecation policy |
| [rollout.md](./rollout.md) · [observability.md](./observability.md) | rollout flags and stages, metrics and correlation |

Kaana's internals (adapters, key pools, inventory, operating it) are in the
[Kaana repository](https://github.com/OxyHQ/Kaana/tree/main/docs). Every
table, event and API has an owner listed in
[the responsibility matrix](../architecture/inference-responsibility-matrix.md).
The Oxy-wide rules page is `~/Oxy/docs/kaana-inference.md`.

Typed nonstreaming classifications: [Decisions](decisions.md) (implemented, provider access gated).
