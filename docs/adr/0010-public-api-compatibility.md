# ADR 0010 — `api.oxy.so/v1` is the Oxy public inference edge, with `POST /v1/responses` preferred and an OpenAI-compatible surface beside it

- Status: accepted
- Date: 2026-08-15
- Issue: #972

## Context

`/v1` on `api.oxy.so` is currently the Alia proxy. `app.use('/v1',
userRateLimiter, aliaRoutes)` (`packages/api/src/server.ts:647`) mounts three
routes (`packages/api/src/routes/alia.ts`):

```text
POST /v1/chat/completions   authMiddleware,  forwarded to https://api.alia.onl/v1/chat/completions
POST /v1/voice/token        authMiddleware,  forwarded to /voice/token
POST /v1/voice/transcribe   authMiddleware,  forwarded to /voice/transcribe
```

All three forward with one static `ALIA_API_KEY`
(`packages/api/src/routes/alia.ts:8`, `:46-50`, `:75-81`), so upstream sees one
caller regardless of which customer made the request. There is no `GET
/v1/models` — the catalogue is at `/models/stats`
(`packages/api/src/server.ts:650`).

The documented contract and the implemented one disagree. The Console
authentication page tells developers to send
`Authorization: Bearer oxy_dk_your_api_key_here` against
`https://api.oxy.so/v1/chat/completions`
(`packages/console/src/routes/_layout/documentation/authentication.tsx:81`,
`:86-90`), but the route is guarded by `authMiddleware`, which accepts a Bearer
*token* (`packages/api/src/middleware/auth.ts:122-127`) and has no API-key lane
at all — a grep for `oxy_dk`, `apiKey` or `api_key` in that file returns nothing.
`oxy_dk_*` is an `ApplicationCredential.public_key`, the OAuth `client_id`
(`packages/api/src/db/schema/applicationCredentials.ts:65-71`), which is a public
identifier and not secret material. The documented request cannot succeed, and
the shape it teaches — send the client id as the secret — is the one shape that
must never start working.

Two further constraints are already settled in this repo and bound this design.
Streaming today is a straight `pipe` of the upstream SSE body
(`packages/api/src/routes/alia.ts:83-88`), which is the correct instinct and must
survive. And the API's `{ data }` / `{ error, message }` envelope has exactly one
existing exception — the OAuth token and userinfo endpoints, which speak RFC 6749
and OIDC flat shapes through `packages/api/src/utils/oauthResponse.ts`. That
precedent is what an OpenAI-compatible surface follows.

## Decision

**The customer-facing base stays `https://api.oxy.so/v1`, and it becomes the Oxy
inference edge rather than a proxy to a product.**

### Public surface

Initial:

```text
POST /v1/responses            preferred modern endpoint
POST /v1/chat/completions     OpenAI-compatible
GET  /v1/models
GET  /v1/models/:id
GET  /v1/generations/:id      usage/cost receipt lookup, where permitted
```

Behind capability/readiness gates, later: `/v1/embeddings`,
`/v1/images/generations`, `/v1/audio/transcriptions`, `/v1/audio/speech`,
`/v1/rerank`, `/v1/batches`.

**`POST /v1/responses` is the preferred endpoint and the one Oxy's own SDKs and
docs lead with.** It is where new capabilities land first, and it is free to
express things the OpenAI shape cannot: explicit routing-profile selection, an
exact model revision pin, a policy version echo, and a receipt reference.

**`POST /v1/chat/completions` is a compatibility surface with a stated
contract**, not an alias. It exists so an unmodified OpenAI SDK works, which
means it speaks the flat OpenAI request/response and error shapes — the same
exception the OAuth endpoints already take from the `{ data }` envelope — and it
does not gain Oxy-specific request fields. Where a capability has no OpenAI
representation, the compatibility endpoint does not invent one; that capability
lives on `/v1/responses`. Oxy-specific *response* metadata is carried in headers
so the body stays parseable by a stock client.

### Authentication at the edge

Two credential shapes, both Oxy-issued, both resolving through ADR 0007:

- an **Oxy service token**, minted from `clientId + clientSecret` at
  `POST /auth/service-token`, for first-party and trusted internal services;
- an **`ApplicationCredential` machine key** (workstream 2.3) — one bearer string
  standard SDKs accept, stored as a lookup prefix plus a cryptographic hash of
  the full token, returned exactly once, verified in constant time.

**A bare `oxy_dk_*` never authenticates.** It is a public identifier; the Console
documentation that presents it as a bearer secret is wrong today and is corrected
as part of workstream 2.1, with a test asserting that a bare public identifier is
rejected where a secret is required.

### Edge behaviour, in order

```text
1. allocate requestId                          (before authentication — a rejected request is traceable)
2. authenticate the credential
3. resolve attribution                          credential → application → owner account   (ADR 0007)
4. authorize scopes                             credential scopes ∩ application scopes
5. resolve routing policy and pin its version
6. reserve spend                                (ADR 0009) — reject here, before the data plane
7. forward the internal envelope to Relay
8. stream through without buffering; propagate client cancellation upstream
9. settle and refund against the returned receipt
```

Nothing is forwarded before step 6 completes. Request bodies, prompts and
provider credentials never enter ordinary access logs.

### The internal envelope

Oxy forwards one canonical shape to Relay, independent of which public endpoint
the customer used. Both public endpoints normalize into it, which is what keeps
the compatibility surface from becoming a second data path.

```text
InferenceEnvelope v1
  envelopeVersion   integer, monotonically increasing
  attribution       { accountId, applicationId, credentialId, userId? }   (ADR 0007)
  requestId         string, allocated at edge admission
  request           normalized inference request — modality, messages/input, tools,
                    generation parameters, streaming flag, requested model or routing profile
  routing           { policyVersion, policySnapshot }  — the exact policy this request was admitted under
  reservation       { reservationId, ceiling, priceVersion }               (ADR 0009)
  deadline          absolute instant after which execution must stop
```

**Versioning of the envelope is explicit and integer.** `envelopeVersion` is
required, never inferred from the presence of a field. Relay refuses an envelope
version it does not implement rather than interpreting it optimistically — an
unrecognized version is a hard error, because a partially-understood envelope is
how a routing constraint gets silently dropped. Adding an optional field is a
minor change within a version; changing the meaning, type or requiredness of an
existing field is a new version. Both sides run the compatibility tests of
workstream 0's contract package, which prove Oxy and Relay agree on the version
in use — a test that must be able to fail, so it asserts version identity rather
than merely that both sides parse.

The same rule applies to every externally consumed event and response shape
(normalized stream events, usage receipts, refunds, catalogue descriptors, price
versions), not only to this envelope.

### Errors and retryability

One structured error shape internally, mapped to each public surface's idiom at
the boundary:

```text
{ requestId, code, message, retryable: boolean, retryAfterMs?, upstreamCategory? }
```

- **`retryable` is asserted by the producer, never inferred by the consumer from
  the HTTP status.** A 429 from a provider whose quota is exhausted for the day
  and a 429 from a momentary burst limit are the same status and different
  answers.
- **A retryable error must be safe to retry with the same idempotency key**, and
  a retried request must not produce a second charge (ADR 0009). If a failure
  cannot be classified, it is not retryable.
- `requestId` appears on every error, including edge rejections that never
  reached the data plane, and in a response header on success.
- Upstream provider errors are translated into Oxy's own codes. Provider error
  text is not passed through verbatim where it could carry upstream account or
  credential detail.
- Rate-limit and usage headers are normalized to one vocabulary across both
  public endpoints, so a client does not need to know which provider served it.

## Alternatives rejected

**Make the OpenAI shape the only surface.** It is the shortest path to "standard
SDKs work" and it caps the platform at what one vendor's schema can express —
routing profiles, revision pins, policy echoes and receipts all have to be
smuggled through non-standard fields, which stock clients then strip.

**Make `/v1/responses` a thin translation layer over `/v1/chat/completions`.**
The preferred endpoint would inherit the compatibility surface's limits, and the
translation would run twice for the endpoint that matters most.

**Serve the public API from a new base path and leave `/v1` as the Alia proxy.**
It avoids a breaking change and permanently concedes the good path to a product
proxy, while leaving the misleading Console documentation pointing at it.

**Let each public endpoint build its own upstream request.** Two code paths to
the data plane means two places where a routing constraint or a reservation can
be forgotten, and only one of them would be well covered.

## Consequences

- Retiring the Alia proxy is a customer-visible change to a live path. `/v1`
  gains real credential authentication where it currently accepts a user session,
  so first-party callers of the proxy — including the Console playground, which
  posts to `${config.oxyUrl}/v1/chat/completions`
  (`packages/console/src/routes/_layout/playground.tsx:148`) — migrate to a
  credential/environment selection rather than an ambient session.
- `/v1/voice/token` and `/v1/voice/transcribe` are Alia product endpoints that
  happen to live under `/v1` today. They are not part of the inference edge, and
  where they end up is decided with workstream 14 rather than assumed here.
- The Console authentication, quickstart, chat-completions and SDK documentation
  pages all currently teach a request that cannot work. Correcting them is part
  of this workstream's output, not a documentation follow-up.
- Streaming must stay unbuffered end to end, and client disconnect must propagate
  to Relay and to the upstream provider. A cancelled stream is a settlement case
  (ADR 0009), so the cancellation path is a billing path and is tested as one.
- Idempotency keys are supported on non-streaming and batch-safe operations;
  request-size, context-size and output-token limits are explicit at the edge
  rather than inherited from whatever the upstream provider happens to enforce.
