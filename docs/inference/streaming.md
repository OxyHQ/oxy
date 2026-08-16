# Streaming, cancellation and retries

Three behaviours a customer needs to reason about before they build. **One of
the three is fully defined and enforced today; the other two are defined and not
yet reachable**, and this page keeps them apart rather than describing all three
in the present tense.

| | Contract | Enforced at the edge | Observable end to end |
|---|---|---|---|
| Streaming | yes | refuses `stream: true` | **no** — nothing streams |
| Cancellation | yes | wired, and pre-empted (see below) | **no** — there is nothing to cancel |
| Retries and idempotency | yes | yes | **yes** |

Status of the whole platform: [README.md](./README.md).

---

## Streaming

### No endpoint streams. `stream: true` is refused.

```json
{
  "schemaVersion": 1,
  "code": "invalid_request",
  "message": "Streaming responses are not served by this edge yet. Send stream: false.",
  "retryable": false,
  "param": "stream",
  "requestId": "…"
}
```

The refusal is at the top of the edge's execution path, before a routing policy
is resolved and long before spend is reserved, so a streaming request costs
nothing and reaches nothing.

That is the only honest answer available. ADR 0010 requires streaming to be
**unbuffered end to end** — an edge that collected a whole completion and then
re-emitted it as SSE would have the shape of streaming and none of its point.
Unbuffered streaming needs something upstream producing tokens, and there is no
data plane. `@oxyhq/core`'s client therefore has no `stream()` method and no
`stream` field on a request: a method that could only ever fail is a worse
artefact than an absent one.

### The event union exists, and is worth reading now

`packages/contracts/src/inference/streamEvents.ts` defines what a stream WILL
carry, and the shapes are already load-bearing for the invariants on this
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

### What you cannot observe, and the one thing that would mislead you

**Disconnecting today does not produce `cancelled`.** With no data plane
configured, the forward throws `DataPlaneNotConfiguredError` immediately, and
that classification is checked *before* the aborted signal — so a request you
abandoned still answers `service_unavailable`. Both are refusals that release the
hold, so nothing is charged either way, but do not read a `service_unavailable`
as evidence that cancellation is unimplemented, and do not build a test that
expects `cancelled` from an abandoned request.

On the OpenAI compatibility surface a cancelled generation reports
`finish_reason: "stop"` in the body, because OpenAI's vocabulary has no
`cancelled` member, and the truth in `X-Oxy-Finish-Reason`. That keeps a stock
client parsing without losing the fact.

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

Everything else is not, and two of those are worth naming because the status
alone would suggest otherwise:

- **`service_unavailable` (503) is NOT retryable.** It is what you get today: an
  unconfigured data plane is an operator's to fix, and a retrying client would
  turn one misconfiguration into a storm.
- **`quota_exceeded` (429) is NOT retryable, while `rate_limited` (429) is.** A
  rate limit clears within the window the response names; a quota is an
  account-level ceiling only a human raises. Branching on the status would get
  this exactly backwards.

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
releases it as a refund with a reason rather than silently — exists and is
tested, and **nothing schedules it yet**. That is an operational gap rather than
a customer-facing one today, because every path out of the edge settles its own
hold; it becomes load-bearing the moment a request can fail somewhere the edge
does not see. [billing.md](./billing.md#the-cases-that-decide-the-behaviour-you-will-see)
records it in the same terms.
