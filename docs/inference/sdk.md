# The TypeScript SDK, and the OpenAI SDK in TypeScript and Python

Two ways to authenticate, one set of endpoints at `https://api.oxy.so/v1`.
Authentication alone does not establish that the live audience, catalogue and
Kaana execution gates are open; see
[Verify the deployed path](#verify-the-deployed-path) before planning around
anything on this page.

Status of the whole platform: [README.md](./README.md).

---

## Which credential you hold decides which lane you are on

| You have | Lane | How it travels |
|---|---|---|
| `oxy_sk_…` machine key | OpenAI-style | one bearer string, sent verbatim, no exchange |
| An Oxy session (a signed-in app) | Oxy auth | the session's own access token, re-read per request |
| `clientId` + `clientSecret` for a platform-trusted app | Oxy auth | a minted service token, re-read per request |

They are the same API. The only difference is where the bearer comes from, and
whether it rotates.

Creating, rotating and revoking an `oxy_sk_…` credential is
[credentials.md](./credentials.md). It is created in Console or through
`oxy.createAppCredential(...)`, and the token is shown exactly once.

---

## `@oxyhq/core` — `OxyInferenceClient`

```typescript
import { OxyInferenceClient } from '@oxyhq/core';

// The OpenAI-style lane: one string, no session anywhere in the picture.
const inference = new OxyInferenceClient({
  credential: process.env.OXY_API_KEY,   // oxy_sk_…
});
```

```typescript
// The Oxy auth lane, inside an app that already holds a session.
const inference = oxyServices.inference();
```

```typescript
// The Oxy auth lane, in a platform-trusted service.
import { OxyInferenceClient } from '@oxyhq/core';

oxyServices.configureServiceAuth('oxy_dk_…', 'the-secret-shown-once');
const inference = new OxyInferenceClient({
  credential: () => oxyServices.getServiceToken(),   // cached and refreshed for you
});
```

**`credential` is a string or a function, and the difference is not cosmetic.**
A machine key is constant. An Oxy bearer rotates on refresh and on account
switch, so it is a function this client calls on *every* request — a client that
captured one at construction starts answering `401` an hour into the process's
life.

### What it can do

| Method | Endpoint |
|---|---|
| `listModels()` | `GET /v1/models` |
| `getModel(modelId)` | `GET /v1/models/:publisher/:model` |
| `listRoutingProfiles()` | `GET /v1/models/routing-profiles` |
| `respond(request, options?)` | `POST /v1/responses` |
| `getGeneration(id)` | `GET /v1/generations/:id` |

`stream(request, options?)` is implemented in draft
[#1145](https://github.com/OxyHQ/oxy/pull/1145), stacked on the merged Kaana
runtime v2 source. It sends `stream: true`, propagates cancellation and
validates the versioned SSE event union. It is not merged, published or production-verified,
so check the installed `@oxyhq/core` package before using that method. Embeddings
and images remain outside this client. See [streaming.md](./streaming.md).

```typescript
const answer = await inference.respond({
  model: 'acme/some-model',            // a GRAMMAR example; Oxy serves no such model
  input: 'Summarise this in one line.',
  maxOutputTokens: 256,
});

answer.requestId;          // correlates this call across the edge, the ledger and your receipt
answer.model;              // always revision-pinned, even if you named only the model line
answer.servingProvider;
answer.usage;              // metered quantities — never money
answer.routingPolicy;      // the exact policy version this request was admitted under
answer.latencyMs;          // Oxy's handling time — NOT your round trip; see below
```

`latencyMs` is optional and every served response sets it; it is optional because
it is additive, so an older Oxy deployment omits it and a streamed request never
carries one at all.

It measures what Oxy can observe about ITSELF: the clock starts when the edge
receives the request, before authentication, and stops once the hold is settled,
so it spans authentication, admission, routing, the reservation, the call to the
inference data plane and the settlement. Most of that interval is the upstream
generating tokens, and this number does not separate the two.

It is not the round trip you can time around your own call, which additionally
contains DNS, TLS, both network legs and your own parse. Report them side by
side: this one has no network in it, and yours cannot be attributed to the model.
Their difference is not a fourth measurement — neither clock took it.

Nothing on this page names a model Oxy serves because main contains no merged
model bootstrap and these docs do not invent one. `listModels()` may answer
`[]`; that is a normal audience-scoped result to render rather than an error to
retry or proof of current production contents. See [catalogue.md](./catalogue.md).

### Errors

Every refusal is an `OxyInferenceError`:

```typescript
import { OxyInferenceError } from '@oxyhq/core';

try {
  await inference.respond({ model: 'acme/some-model', input: 'hello' });
} catch (error) {
  if (error instanceof OxyInferenceError) {
    error.code;         // the closed contract vocabulary — 'service_unavailable', 'insufficient_balance', …
    error.retryable;    // the SERVER's verdict, never inferred here from the status
    error.retryAfterMs; // only ever present when retryable
    error.requestId;    // quote this when you report a failure
    error.param;        // the field at fault, for invalid_request
    error.status;
  }
}
```

`retryable` is asserted by the server and looked up from a total map over the
closed code set. A code that can never succeed on an identical retry cannot
claim to be retryable — the contract's own refinement refuses the combination.
So `error.retryable` is the answer, and a client that re-derives one from the
HTTP status is doing the thing that rule exists to prevent. Details in
[streaming.md](./streaming.md#retries).

### Attribution and idempotency

```typescript
await inference.respond(request, {
  delegatedUserId: 'the-end-user-id',   // X-Oxy-User-Id — ATTRIBUTION ONLY
  idempotencyKey: 'order-4711-summary', // at most 128 characters
  signal: abortController.signal,
});
```

A delegated user never changes which account is charged — see
[attribution.md](./attribution.md). An `Idempotency-Key` already bound to a
reservation is **refused** with `idempotency_conflict` rather than replayed;
[streaming.md](./streaming.md#idempotency-is-a-charge-guarantee-not-a-replay-cache)
says why.

---

## The OpenAI SDK, unmodified

`POST /v1/chat/completions` speaks the OpenAI request and response shapes, so a
stock client works with a base URL and a key:

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OXY_API_KEY,      // oxy_sk_…
  baseURL: 'https://api.oxy.so/v1',
});
```

Four compatibility rules matter, and all four are deliberate:

- **`model` is a canonical Oxy id, `<publisher>/<model>`.** A vendor model name
  is not one and does not resolve — accepting a bare name would mean Oxy
  guessing which publisher you meant.
- **Unknown request fields are rejected, not ignored.** The schema is strict, so
  a parameter Oxy does not implement gets you a `400` naming it rather than
  silently having no effect on a request you were billed for.
- **`stream: true` uses OpenAI-compatible SSE** when the deployed Kaana path is
  configured and enabled. An unavailable data plane is refused before opening a
  stream. The typed `@oxyhq/core` decoder is implemented in draft #1145 but is
  not yet a published SDK capability.
- **Oxy-specific response metadata rides in headers**, so the body stays exactly
  what a stock client parses.

### Headers

On every response, success or refusal:

| Header | Carries |
|---|---|
| `X-Oxy-Request-Id` | the correlation id, present even on a `401` |
| `X-Oxy-Inference-Contract-Version` | the contract version this edge speaks |

On a successful non-streaming invoke, additionally:

| Header | Carries |
|---|---|
| `X-Oxy-Model` | the revision-pinned model that actually ran |
| `X-Oxy-Provider` | the serving provider |
| `X-Oxy-Usage-Input-Tokens`, `X-Oxy-Usage-Output-Tokens` | metered units |
| `X-Oxy-Routing-Policy`, `X-Oxy-Routing-Policy-Version` | the policy version the request was admitted under |
| `X-Oxy-Latency-Ms` | Oxy's own handling time in whole milliseconds, as `latencyMs` above — the only place `/v1/chat/completions` can state it, since that body is stock OpenAI |
| `X-Oxy-Finish-Reason` | `/v1/chat/completions` only — the true reason, including `cancelled`, which OpenAI's `finish_reason` cannot express |

On a stream, the admission-time model, provider and routing-policy headers are
present before the first frame. Usage, finish state and end-to-end latency are
known only after headers have been committed: usage is carried by SSE, finish by
the terminal event/chunk, and no `X-Oxy-Latency-Ms` header is invented afterward.

On a refusal of `/v1/chat/completions`, additionally `X-Oxy-Error-Code` and
`X-Oxy-Error-Retryable`, because the OpenAI error body has nowhere to put them.
`Retry-After` is set whenever the error carried a `retryAfterMs`.

Rate-limit budgets are reported through the standard `RateLimit-*` headers.

---

## Verify the deployed path

This document defines the client contract, not current availability. A live
check must read the deployed rollout gates and catalogue, then send a real
request through Oxy to `https://kaana.ai`. Depending on that state, a request may
be refused because the audience is closed, the model is absent, routing evidence
is incomplete or Kaana execution is disabled. Do not infer any of those facts
from this page.

Every refusal still settles safely: if a hold was created, the edge releases or
settles it before returning. An unconfigured execution path is non-retryable
because only an operator can change it; marking it retryable would turn one
misconfiguration into a client-wide retry storm.

---

## Python: the stock `openai` client, unmodified

There is no Oxy Python package and there does not need to be one, because the
edge was built to be reachable from the client a Python developer already has.
`POST /v1/chat/completions` is OpenAI-compatible by explicit design
(`packages/api/src/routes/inferenceEdge.ts`: "The body is exactly what a stock
OpenAI client parses, in both directions. Everything Oxy-specific … rides in
headers, which is the rule that keeps it compatible rather than merely similar").

The example is a contract illustration, not a production transcript. Verify the
live catalogue, rollout gates and a real response before treating a deployment
as available.

```python
import os

from openai import OpenAI

client = OpenAI(
    api_key=os.environ["OXY_API_KEY"],       # oxy_sk_<16 hex>_<64 hex>
    base_url="https://api.oxy.so/v1",
    max_retries=0,                           # see "Retries" below
)

completion = client.chat.completions.create(
    model="oxy/some-model",                  # a canonical <publisher>/<model> id
    messages=[{"role": "user", "content": "hello"}],
)
```

The four differences from OpenAI's own service listed under "The OpenAI SDK,
unmodified" apply identically here: `model` is a canonical Oxy
`<publisher>/<model>` id, unknown request fields are rejected rather than ignored,
`stream=True` uses OpenAI-compatible SSE when Kaana is available, and
admission-time Oxy metadata rides in headers while terminal usage stays in the
stream.

### Reading the Oxy headers

`client.chat.completions.create(...)` returns the parsed body, which by design
carries nothing Oxy-specific. The request id, the revision-pinned model that
actually ran, the serving provider, the metered units and the routing policy
version are all headers, so reach for the raw response:

```python
raw = client.chat.completions.with_raw_response.create(
    model="oxy/some-model",
    messages=[{"role": "user", "content": "hello"}],
)

request_id = raw.headers["x-oxy-request-id"]
served_by = raw.headers.get("x-oxy-model"), raw.headers.get("x-oxy-provider")
completion = raw.parse()
```

The full header list is the table under "The OpenAI SDK, unmodified" above — it
is the same edge and the same headers. `X-Oxy-Request-Id` is present on every
response including a `401`, which is what makes a refusal reportable by id
instead of by reproduction.

### Errors

A refusal arrives as the OpenAI error envelope, so the SDK raises its own
exception types and the Oxy code is inside them:

```python
from openai import APIStatusError

try:
    client.chat.completions.create(model="oxy/some-model", messages=[...])
except APIStatusError as error:
    oxy_code = error.body["error"]["code"]              # e.g. "service_unavailable"
    retryable = error.response.headers["x-oxy-error-retryable"] == "true"
    request_id = error.response.headers["x-oxy-request-id"]
```

`error.body["error"]["type"]` is the OpenAI type the code maps to (an Oxy
`service_unavailable` renders as `api_error`), and `error.body["error"]["code"]`
is the Oxy code. The code is the one to branch on; the type exists so a stock
client's own error classes still work.

### Retries

`max_retries=0` above is deliberate. The `openai` client retries on its own
schedule, and Oxy already publishes per-code retryability in
`X-Oxy-Error-Retryable` plus `Retry-After` where a wait is known. Leaving both
layers on means retrying refusals Oxy has said are not retryable — `503
service_unavailable` is `retryable: false` precisely so that an unconfigured data
plane does not teach every client to retry forever
(`packages/api/src/utils/inferenceEdgeErrors.ts`). Retry on
`X-Oxy-Error-Retryable`, and honour `Retry-After`.

### Runtime gates and refusals

- `model` must name a catalogue entry visible to the caller.
- Missing, stale, mismatched or colliding route identity, price or score evidence
  refuses before reservation and before an inference POST. The signed read-only
  deployment attestation can precede the final hold quote, so a child-unit price
  gap discovered there may follow that preflight while still producing no hold
  and no execution.
- A deployment with Kaana execution disabled returns the typed, non-retryable
  unconfigured-path refusal and keeps no charge.
- Streaming and cancellation require the same live end-to-end verification as a
  non-streamed request; source support alone is not production evidence.

These are platform boundaries, not Python-specific limitations.

### The machine-readable contract

`packages/api/openapi.json` now describes `/v1/responses`,
`/v1/chat/completions`, `/v1/generations/{id}` and the catalogue reads, including
the `machineCredentialAuth` scheme the `oxy_sk_…` key satisfies. That is the
artifact any generated client — Python or otherwise — would be generated from,
and `scripts/check-openapi-fresh.mjs` is what keeps it describing the routes that
exist.

## There is no official Python SDK

The TypeScript client is the reference checked against the HTTP contract by
`sdkRequestCompatibility.test.ts`. `packages/api/openapi.json` describes the
`/v1` edge, so a future Python client should be generated from that artifact
after the public contract and live end-to-end behavior are release-gated. Do not
hand-maintain a second implementation of streaming, cancellation or catalogue
semantics.
