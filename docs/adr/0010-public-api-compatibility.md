# ADR 0010 — `api.oxy.so/v1` is the Oxy public inference edge, with `POST /v1/responses` preferred and an OpenAI-compatible surface beside it

- Status: accepted
- Date: 2026-08-15
- Amended: 2026-08-16 (#1018) — the envelope section described a policy
  SNAPSHOT, a `reservation` and a `deadline` that `inferenceRequestSchema` has
  never carried. The envelope description below is now the shape in
  `packages/contracts/src/inference/request.ts`, and the enforcement split it
  implies is stated rather than left to be inferred from two ADRs at once.
- Amended: 2026-09-03 — the transitional Oxy-to-Alia proxy and its voice mounts
  were removed. Alia product clients address Alia directly; Inbox point
  inference uses the metered Oxy-to-Kaana edge.
- Superseded in part: [ADR 0017](0017-authorized-routes-in-the-envelope.md)
  (2026-08-17) — the envelope now also carries `authorizedRoutes`, the ordered
  list of routes the customer's policy authorized. The 2026-08-16 amendment
  assigns the data plane "failover within the destinations the policy authorized"
  and the envelope named none of them; ADR 0017 names them, and states the edge
  step and envelope lines it replaces.
- Amended by contract v2: Oxy completes route ranking before signing
  `authorizedRoutes`; terminal and partial usage evidence both require the exact
  Kaana `deploymentId`. The shape-specific versioning consequences are recorded
  below.
- Issue: #972

## Context

At the time of this decision, `/v1` on `api.oxy.so` was the Alia proxy. `app.use('/v1',
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
Streaming at that time was a straight `pipe` of the upstream SSE body
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
5. resolve the routing policy, pin its version, and SELECT the route
                                               refuse `policy_violation` if no candidate qualifies
6. reserve spend                                (ADR 0009) — reject here, before the data plane
7. forward the internal envelope to Kaana
8. stream through without buffering; propagate client cancellation upstream
9. settle and refund against the returned receipt
```

Nothing is forwarded before step 6 completes. Request bodies, prompts and
provider credentials never enter ordinary access logs.

### The internal envelope

Oxy forwards one canonical shape to Kaana, independent of which public endpoint
the customer used. Both public endpoints normalize into it, which is what keeps
the compatibility surface from becoming a second data path.

```text
InferenceEnvelope v2  (packages/contracts/src/inference/request.ts)
  schemaVersion     integer literal, per-shape (see version.ts)
  attribution       { principal { billing, applicationId, credentialId, environment,
                      inferenceScopes }, userId?, requestId, generationId? }   (ADR 0007)
  target            { kind: 'model', modelReference } |
                    { kind: 'routing_profile_id', routingProfileId };
                    the edge emits only an exact model reference or the opaque
                    routing-profile primary key. A deprecated public profile slug
                    is resolved uniquely before this envelope is built and never
                    crosses the Oxy→Kaana boundary
  modality, input, stream, maxOutputTokens, sampling, tools, toolChoice?, responseFormat?
  client            { apiFormat, endpoint, clientRequestId?, receivedAt, labels? }
  idempotencyKey?   the customer's key, when the operation is safe to deduplicate
  routingPolicy     { routingPolicyId, policyVersion } — a REFERENCE, see below
```

`requestId` rides inside `attribution` rather than beside it, because every
record that carries attribution carries the id too and splitting them would let
one arrive without the other.

**The envelope carries a routing-policy REFERENCE, not a snapshot, and route
selection is already complete when it is built.** The control plane resolves the
effective policy, filters the candidate routes against every control it can
express as a predicate over one candidate — provider allow/denylist, region
allow/denylist, zero-data-retention, prohibit-training, licence list, commercial
use rights, Oxy-hosted-only, BYOK preference, dedicated capacity — and refuses
with `policy_violation` when no candidate qualifies, before anything is reserved
or forwarded. The reference exists so the receipt can be explained against the
exact revision of the customer's own configuration that produced it; it is
provenance, and nothing downstream is expected to act on it.

Oxy also completes price qualification and the preference order before
forwarding. The catalogue may prefilter the flat fee because Kaana emits
`requests: 1`; the edge then quotes the complete request maximum from each
candidate's pinned price version. At each explicit routing-profile priority it
excludes cap and currency failures, then orders the survivors by the reviewed
`optimiseFor` score descending and exact `deploymentId` by ECMAScript UTF-16 code
units as the sole tie-break. If output is implicit, that first survivor fixes
the output ceiling before lower priorities are resolved for capacity. No price
survivor means `policy_violation` before reserve or execution. The data plane
executes and fails over only within the signed order. It cannot re-rank by
provider/model name, health score, locale or inventory order, and it can never
admit a route the control plane excluded. That is what makes "the control plane
authorizes and orders; the data plane executes" a division rather than a
duplication.

The classification is held in code rather than in prose: every control of
`routingPolicySchema` is either enforced by
`inferenceCatalogue.service.ts`'s `violatedConstraints` or named, with its
reason, in `UNFILTERED_ROUTING_CONTROLS` beside it, and a control in neither
list fails `tsc`.

**No `reservation` and no `deadline` travel.** The reservation is the control
plane's own record and the data plane has no use for its id: what bounds a
request's cost upstream is `maxOutputTokens`, which the envelope carries. What
bounds its duration is the transport — the edge propagates client cancellation
into `KaanaClient.execute` — and the hold's own TTL, after which the expiry
sweeper releases it. An explicit `deadline` would be a defensible addition, and
under the versioning rule below it is additive within v1; it is left out until a
producer sets it and a consumer honours it, because a field the envelope
declares and nobody writes is exactly the gap this ADR was corrected for.

**Versioning of the envelope is explicit and integer.** `schemaVersion` is
required, never inferred from the presence of a field, and it versions THIS
shape rather than the contract set as a whole — pinning a request to the set's
version would make an unrelated additive change to, say, the catalogue reject
every in-flight inference request (`packages/contracts/src/inference/version.ts`).
Kaana refuses an envelope
version it does not implement rather than interpreting it optimistically — an
unrecognized version is a hard error, because a partially-understood envelope is
how a routing constraint gets silently dropped. Adding an optional field is a
minor change within a version; changing the meaning, type or requiredness of an
existing field is a new version. Both sides run the compatibility tests of
workstream 0's contract package, which prove Oxy and Kaana agree on the version
in use — a test that must be able to fail, so it asserts version identity rather
than merely that both sides parse.

The same rule applies to every externally consumed event and response shape
(normalized stream events, usage receipts, refunds, catalogue descriptors, price
versions), not only to this envelope.

Contract v2 applies the requiredness rule rather than weakening identity:
`normalizedUsageReportSchema` v2 and streamed `usage` event v2 both require the
exact `deploymentId`; `modelCatalogueEntrySchema` v2 makes availability scope
and commercial permission optional when visible deployments do not all agree,
while the projection publishes its already-optional singular pricing only on the
same unanimous basis. A v1 usage shape cannot be treated as v2 by guessing its
route, and an unsupported version fails closed.

Failing closed applies to the whole measurement record, not only to the frame
that failed. If a known `stream_event` or `usage_report` frame is malformed or
fails its per-shape schema, every terminal and partial measurement accumulated
for that request is invalidated. A v1 or malformed terminal usage report is not
“no terminal report”: the edge may not reuse a preceding valid partial event for
settlement.

**Which shapes reject an unknown field follows from that rule, and the split is
deliberate.** The shapes exchanged with the data plane — this envelope, the
usage records, the stream events, the error body, the catalogue descriptors, the
price version — are NOT `.strict()` at their top level, because `.strict()` and
"adding an optional field is a minor change within a version" cannot both hold:
a producer one minor version ahead would have its whole message refused rather
than its new field ignored. For a usage report that means a request already
served upstream can never be settled and Oxy absorbs its cost — a worse failure
than the one strictness would catch, and one that arrives on the day a
counterpart ships an addition this ADR calls compatible.

Their leaves are strict, and that is where the protection sits, because a
stripped field is the more dangerous outcome exactly where it would be a leak or
a second source of truth: `clientRequestMetadataSchema` (where somebody would
eventually attach an IP), `moneySchema` (a convenience float beside the exact
decimal), `providerErrorPassthroughSchema` (an upstream request or header beside
the message), `usageQuantitySchema`, `unitPriceSchema`. Shapes Oxy does not
exchange with the data plane are strict at the top as well —
`providerConnectionSchema`, where an unknown field is how a BYOK credential
escapes, and the billing and entitlement records.

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
- **The platform group is not uniformly retryable.** An upstream that refuses the
  PLATFORM's own credential is `provider_credential_invalid`, and it is
  non-retryable: no identical retry can succeed until an operator rotates a key,
  and classifying it as `provider_error` sends every client into a retry loop
  against a request that cannot pass. It is the counterpart of
  `byok_credential_invalid`, which names the same failure on the customer's own
  credential — two codes because only one of them names an action the customer
  can take. `provider_billing_refused` sits beside it for an upstream that
  declines to BILL Oxy (several answer `402`): also non-retryable, also an
  operator's, and deliberately not `quota_exceeded`, which would be right about
  retryability and would point the customer at their own balance.
- **Free error text is refused when it still looks like it carries a credential,
  and that refusal is a last resort rather than the control.** A pattern over the
  output can only see what a producer left in it; the reliable control is
  redacting the secret VALUE where it is still known, which is available only to
  whoever made the upstream call. The pattern must therefore match on value SHAPE
  and not only on the marker — issue #1027 measured what happens otherwise: a
  producer redacting the span the marker matched turned a refused string into an
  accepted one carrying the same key.
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

- Retiring the Alia proxy was a customer-visible change to a live path. `/v1`
  gained real credential authentication where it had accepted a user session,
  so first-party callers of the proxy — including the Console playground, which
  posts to `${config.oxyUrl}/v1/chat/completions`
  (`packages/console/src/routes/_layout/playground.tsx:148`) — migrate to a
  credential/environment selection rather than an ambient session.
- The transitional `/v1/voice/token` and `/v1/voice/transcribe` mounts were
  removed from Oxy. Alia voice remains a product endpoint addressed directly by
  Alia SDK clients, not part of the inference edge.
- The Console authentication, quickstart, chat-completions and SDK documentation
  pages all currently teach a request that cannot work. Correcting them is part
  of this workstream's output, not a documentation follow-up.
- Streaming must stay unbuffered end to end, and client disconnect must propagate
  to Kaana and to the upstream provider. A cancelled stream is a settlement case
  (ADR 0009), so the cancellation path is a billing path and is tested as one.
- Idempotency keys are supported on non-streaming and batch-safe operations;
  request-size, context-size and output-token limits are explicit at the edge
  rather than inherited from whatever the upstream provider happens to enforce.
