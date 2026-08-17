# The TypeScript SDK, and the OpenAI SDK in TypeScript and Python

Two ways to authenticate, one set of endpoints. Both reach
`https://api.oxy.so/v1`, and **every invoke refuses today** — see
[What you will actually observe](#what-you-will-actually-observe) before you
plan around anything on this page.

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

That is the whole surface, because that is the whole edge. There is no
`stream()`, no `embeddings()`, no `images()` — see
[streaming.md](./streaming.md) and the workstream-4 list in
[README.md](./README.md).

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
```

Nothing on this page names a model Oxy serves, because
[the catalogue is empty](./catalogue.md). `listModels()` answers `[]`, and that
is a normal answer to render rather than an error to retry.

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

Four things differ from OpenAI's own service, and all four are deliberate:

- **`model` is a canonical Oxy id, `<publisher>/<model>`.** A vendor model name
  is not one and does not resolve — accepting a bare name would mean Oxy
  guessing which publisher you meant.
- **Unknown request fields are rejected, not ignored.** The schema is strict, so
  a parameter Oxy does not implement gets you a `400` naming it rather than
  silently having no effect on a request you were billed for.
- **`stream: true` is refused** with `invalid_request`.
- **Oxy-specific response metadata rides in headers**, so the body stays exactly
  what a stock client parses.

### Headers

On every response, success or refusal:

| Header | Carries |
|---|---|
| `X-Oxy-Request-Id` | the correlation id, present even on a `401` |
| `X-Oxy-Inference-Contract-Version` | the contract version this edge speaks |

On a successful invoke, additionally:

| Header | Carries |
|---|---|
| `X-Oxy-Model` | the revision-pinned model that actually ran |
| `X-Oxy-Provider` | the serving provider |
| `X-Oxy-Usage-Input-Tokens`, `X-Oxy-Usage-Output-Tokens` | metered units |
| `X-Oxy-Routing-Policy`, `X-Oxy-Routing-Policy-Version` | the policy version the request was admitted under |
| `X-Oxy-Finish-Reason` | `/v1/chat/completions` only — the true reason, including `cancelled`, which OpenAI's `finish_reason` cannot express |

On a refusal of `/v1/chat/completions`, additionally `X-Oxy-Error-Code` and
`X-Oxy-Error-Retryable`, because the OpenAI error body has nowhere to put them.
`Retry-After` is set whenever the error carried a `retryAfterMs`.

Rate-limit budgets are reported through the standard `RateLimit-*` headers.

---

## What you will actually observe

Send a request today, with a valid `oxy_sk_…` credential holding
`inference:invoke`, and the edge will:

1. authenticate the credential,
2. resolve `accountId` / `applicationId` / `credentialId`,
3. check the scope,
4. resolve and pin your routing policy version,
5. resolve the model — **which fails, because the catalogue is empty**.

Give it a model that exists and it would continue: reserve the maximum this
request could cost, find no data plane to forward to, release the hold, and
answer:

```json
{
  "schemaVersion": 1,
  "code": "service_unavailable",
  "message": "No inference data plane is configured for this deployment.",
  "retryable": false,
  "requestId": "…"
}
```

`retryable: false` is the important part. An unconfigured deployment is fixed by
an operator, not waited out, and marking it retryable would turn one
misconfiguration into a retry storm from every SDK at once.

**Nothing is charged.** The hold is released before the refusal returns, and the
test that asserts the refusal asserts the balance is whole afterwards — a
refusal that silently kept the money is the failure that looks like it worked.

---

## Python: the stock `openai` client, unmodified

There is no Oxy Python package and there does not need to be one, because the
edge was built to be reachable from the client a Python developer already has.
`POST /v1/chat/completions` is OpenAI-compatible by explicit design
(`packages/api/src/routes/inferenceEdge.ts`: "The body is exactly what a stock
OpenAI client parses, in both directions. Everything Oxy-specific … rides in
headers, which is the rule that keeps it compatible rather than merely similar").

**Nobody has run any of this.** No data plane is configured, so every invoke
refuses before it reaches a provider — see the constraints below. What follows is
a documented claim derived from the route code and the published contract, not a
verified transcript. Treat the first real call as the verification.

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
`stream=True` is refused, and Oxy-specific metadata rides in headers.

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

### What refuses today, and why

- **`stream=True` is refused** with `invalid_request`. Nothing streams at the
  edge yet (`docs/inference/streaming.md`). A stock `openai` client defaults to
  non-streaming, so ordinary calls are unaffected.
- **Every invoke returns `service_unavailable` (HTTP 503).** No data plane is
  configured, so the request is refused after authentication and admission and
  before any provider is contacted. Nothing is charged: the hold is released
  before the refusal returns.
- **`model` must name a catalogue entry**, and the catalogue is empty by design
  until a real model is published, so there is no id that resolves today either.

None of the three is a Python-specific limitation; they are the state of the edge.

### The machine-readable contract

`packages/api/openapi.json` now describes `/v1/responses`,
`/v1/chat/completions`, `/v1/generations/{id}` and the catalogue reads, including
the `machineCredentialAuth` scheme the `oxy_sk_…` key satisfies. That is the
artifact any generated client — Python or otherwise — would be generated from,
and `scripts/check-openapi-fresh.mjs` is what keeps it describing the routes that
exist.

## There is no Python SDK, and this is not the moment to start one

#972 lists a Python SDK "after the HTTP contract stabilizes". It has not
stabilised, on the two measures that matter:

- **No endpoint serves a request.** Every invoke resolves to
  `service_unavailable`, so a Python client could be written but never exercised
  against a real completion — and an SDK whose happy path has never run once is
  a set of assumptions, not a client.
- **The parts most likely to move are the parts a second SDK would have to
  re-implement.** Streaming has no wire format at the edge yet, cancellation has
  no end-to-end path, and the catalogue that decides what `model` may say is
  empty. Each of those is a Python rewrite the day it lands.

The TypeScript client above exists anyway because it is the reference the HTTP
contract is checked against, and because `packages/api`'s
`sdkRequestCompatibility.test.ts` fails the build if the two drift. A second
language doubles that surface without doubling the coverage.

What HAS changed is the cost of the alternative. `packages/api/openapi.json` now
describes the `/v1` edge, so a *generated* Python client is cheap in a way a
hand-written one is not: it costs a generator invocation rather than a second
implementation of streaming, cancellation and the catalogue, and it cannot drift
from the contract by hand. It is still not worth publishing while every invoke
refuses — a generated client whose happy path has never run is the same set of
assumptions in a different language — but the decision is now "generate it when
the edge serves a request", not "write one".
