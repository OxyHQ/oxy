# The TypeScript SDK, and the OpenAI SDK

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
