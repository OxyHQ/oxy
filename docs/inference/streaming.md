# Streaming, cancellation and retries

Three behaviours a customer needs to reason about before they build. This page
describes the source contract; whether a deployed audience can exercise it is
live rollout state and must be verified separately.

| | Contract | Source path | Production proof required |
|---|---|---|---|
| Streaming | yes | validated SSE through the data-plane client | real provider stream through Oxy and Kaana |
| Cancellation | yes | client abort reaches the data-plane request context | upstream cancellation plus one exact settlement |
| Retries and idempotency | yes | enforced by the edge and ledger | deployed retry with no duplicate charge |

Status of the whole platform: [README.md](./README.md).

---

## Streaming

### The edge streams; the TypeScript SDK does not yet expose a stream method

ADR 0010 requires streaming to be **unbuffered end to end** — an edge that
collected a whole completion and then re-emitted it as SSE would have the shape
of streaming and none of its point. The Oxy route and data-plane client implement
the validated SSE path when Kaana execution is configured. An unconfigured path
refuses before opening a stream and keeps no charge.

`@oxyhq/core` currently exposes no `stream()` method and no `stream` request
field. A caller using the HTTP surface directly can request streaming; an SDK
consumer must wait for the typed decoder rather than hand-roll a second event
contract and call it supported.

### The event union exists, and is worth reading now

`packages/contracts/src/inference/streamEvents.ts` defines what a stream carries,
and the shapes are already load-bearing for the invariants on this
platform. Seven events, discriminated on `type`:

| Event | Carries |
|---|---|
| `start` | the revision-pinned model that resolved, and the serving provider |
| `delta` | a chunk of output, on channel `output_text`, `reasoning` or `refusal` |
| `tool_call` | an accumulating tool call, with `complete` marking it finished |
| `usage` | metered units so far — **units only, never money** |
| `route_switch` | a customer-visible notice that an allowed re-route happened |
| `error` | terminal; no `done` follows |
| `done` | terminal; `finishReason`, and `receiptId` once settlement produced one |

Three properties are decided, not pending:

- **Every event carries `requestId` and a monotonic `sequence`.** Not just the
  first — a proxy that re-frames or a client that reconnects would otherwise
  hold events it cannot attribute, and a redelivered event would be
  indistinguishable from new output.
- **Events are versioned individually**, because a stream is a long sequence of
  small messages from a producer that may be redeployed mid-stream. One version
  for the whole union would move every event whenever any one of them changed.
- **`route_switch` cannot express an unauthorized substitution.** A switch to a
  different *model* requires `authorizedByPolicy: true` as a literal, and names
  the UNPINNED model line the customer asked for — so a request that pinned a
  revision has no value that satisfies the field, and the event cannot be
  constructed at all. See [routing.md](./routing.md).

A consumer that meets an unknown `type` fails at the parse rather than falling
into a default branch that treats it as output.

### `usage` events are not a bill

A `usage` event reports units. What you are charged is derived from those units
and the price version pinned at admission, at settlement, by the ledger — a cost
quoted mid-stream by a data plane would be a second, unauthoritative answer to
the same question. [billing.md](./billing.md) is the authority.

---

## Cancellation

### What is wired

The edge builds an `AbortSignal` from the client connection: when the response
closes before it was written, the signal aborts, and that signal is passed to
the data-plane call. Cancellation propagation is a parameter on the interface
rather than a follow-up, precisely so it cannot be forgotten when a data plane
arrives.

The billing half is decided and tested: a cancelled request settles the units
actually produced and refunds the rest of the hold, atomically. **Cancellation is
a normal terminal state, not an error** — `outcome: 'cancelled'`,
`finishReason: 'cancelled'`, HTTP `499`, and a receipt you can read back with
`GET /v1/generations/:id`.

### Production verification

Source tests prove the Oxy abort signal reaches the Kaana client and Kaana passes
its request context to the provider adapter. They do not prove the deployed
network path. A release gate must stream from a real provider, disconnect after
partial output, observe upstream cancellation and verify exactly one settlement
for the measured units. An unconfigured-path `service_unavailable` is not
evidence about cancellation in either direction.

On the OpenAI compatibility surface a cancelled generation reports
`finish_reason: "stop"` in the body, because OpenAI's vocabulary has no
`cancelled` member, and the truth in `X-Oxy-Finish-Reason`. That keeps a stock
client parsing without losing the fact.

`refusal` is handled the same way, and for the same reason. It is a separate
`finishReason` from `content_filter` because they are separate events — the
MODEL declining to answer, versus an upstream system removing an answer — and
the delta channels already distinguish them (`channel: 'refusal'`). OpenAI has
no `refusal` member either, so the compatibility body says `"stop"`, which is
what OpenAI itself returns for a model refusal, and `X-Oxy-Finish-Reason` says
`refusal`.

---

## Retries

### `retryable` is the server's answer, not a status code

Every refusal carries an explicit `retryable`, and the code constrains it: a
code that can never succeed on an identical retry **cannot** be marked
retryable — the contract refuses the combination rather than trusting a producer
to be honest. `retryAfterMs` requires `retryable: true` for the same reason.

Five codes are retryable:

| Code | Why an identical retry can succeed |
|---|---|
| `rate_limited` | the window clears on its own |
| `deployment_unavailable` | a route came back |
| `provider_error` | a transient upstream failure |
| `provider_timeout` | a slow upstream |
| `provider_overloaded` | upstream capacity |

Everything else is not, and three of those are worth naming because the status
alone would suggest otherwise:

- **`service_unavailable` (503) is NOT retryable.** An unconfigured execution
  path is an operator's to fix, and a retrying client would turn one
  misconfiguration into a storm.
- **`quota_exceeded` (429) is NOT retryable, while `rate_limited` (429) is.** A
  rate limit clears within the window the response names; a quota is an
  account-level ceiling only a human raises. Branching on the status would get
  this exactly backwards.
- **`provider_credential_invalid` (502) is NOT retryable, while `provider_error`
  (502) is.** The upstream refused OXY's own credential, and no number of
  retries reaches the operator who has to rotate a key. When it is your own
  provider credential that was refused the code is `byok_credential_invalid`,
  which is also not retryable — but that one names something you can fix.
- **`provider_billing_refused` (502) is NOT retryable, and is not about your
  balance.** An upstream declined to bill OXY — several answer `402` for it — so
  the money at issue is Oxy's account with that provider, not yours. It is
  deliberately not `quota_exceeded`, which would be right about retryability and
  would send you to top up an account that is not the one blocking the request.

`internal_error` is not retryable either — an unclassified failure is not one
anybody has established a retry could resolve.

So: **branch on `code` and `retryable`, never on the HTTP status**, and honour
`retryAfterMs` when it is there.

### Idempotency is a charge guarantee, not a replay cache

Send `Idempotency-Key` on an invoke and Oxy binds it to the reservation, keyed
per credential (`<credentialId>:<your key>`), so two customers choosing the same
string can never collide. A request with no key is still keyed — on its own
request id — so an internal retry of one HTTP request cannot double-charge
either.

**A key already bound to a reservation is REFUSED**, with
`idempotency_conflict` (409), rather than replayed:

> Prompts and responses are not persisted by default, so there is no stored
> response to return. Refusing is what makes "a retry never produces a second
> charge" structural rather than best-effort.

Two consequences to design for:

- A `409 idempotency_conflict` means *the first request was accepted*. Read its
  outcome from `GET /v1/generations/:id` using the `requestId` you kept, rather
  than re-sending.
- A key longer than 128 characters is refused, not truncated. Two keys differing
  only past the cut would silently become one, and the whole point of the header
  is that two different requests are two different charges.

Reserve, settle and refund are each idempotent on a stable id, implemented as
`ON CONFLICT … DO NOTHING RETURNING` rather than catch-the-duplicate — a
duplicate key and a dropped connection are indistinguishable inside a `catch`,
so an exception handler would answer "already settled" to an infrastructure
failure. [billing.md](./billing.md) has the full protocol.

### Do not retry a request that never reached the data plane differently

Every refusal releases its hold before returning, including the no-data-plane
one. There is no "stuck reservation" state a client should try to clean up, and
no compensating call to make.

The backstop for a hold that outlives its request — `expireReservations`, which
releases it as a refund with a reason rather than silently — runs every minute
on the server. It does not replace explicit settlement on each known exit path;
it covers failures the edge process cannot observe.
[billing.md](./billing.md#the-cases-that-decide-the-behaviour-you-will-see)
records it in the same terms.
