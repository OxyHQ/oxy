# Rolling the inference platform out, and rolling it back

Workstream 16 of [OxyHQ/oxy#972](https://github.com/OxyHQ/oxy/issues/972).

**Nothing in this document describes something that has happened.** The
mechanisms below exist and are tested; every stage they can express is still
ahead of us, and the flags that would express one are unset in every deployment.
Read [README.md](./README.md) for what is built, and
[billing.md](./billing.md) for the ledger this rollout is careful about.

---

## The four flags

They live in one module — `packages/api/src/config/rolloutFlags.ts` — and they
are readable in one call: `GET /inference/admin/rollout` (staff only) returns
every flag, its resolved state, and the reason for that state.

| Variable | Values | Unset means | What it gates |
|---|---|---|---|
| `INFERENCE_EDGE_AUDIENCE` | `closed` · `internal` · `first_party` · `allowlist:<appId>,…` · `public` | **closed — nobody** | Who may reach `POST /v1/responses`, `POST /v1/chat/completions`, `GET /v1/generations/:id` |
| `INFERENCE_MACHINE_CREDENTIAL_AUTH` | `enabled` · `disabled` | **disabled** | Whether an `oxy_sk_…` machine credential authenticates at all |
| `INFERENCE_CHARGING_AUTHORIZED` | `<reason>:<YYYY-MM-DD>` | **shadow metering — nobody is charged** | Whether the edge reserves, settles and moves money |
| `INFERENCE_CATALOGUE_AUDIENCE` | `internal` · `public` | **internal** | Whether a public viewer is served the published catalogue |

None of them is a secret — each names a deployment STATE — so all four belong in
the ECS task definition's plain environment and never in SSM.

### Every default is the state that does nothing

An unset variable never opens a public surface, never authenticates a customer's
API key, never publishes a catalogue and never charges anybody. That is the
whole mechanism: a flag you can arm by forgetting a variable is worse than no
flag, because it reads as a control while defaulting to the dangerous side.

`packages/api/src/config/__tests__/rolloutFlags.test.ts` asserts each default
with the environment explicitly cleared, and pairs it with a case that OPENS the
same flag — so "everything is off" is never what a test reading nothing would
also report. Flipping any default in the module turns that file red.

### An unreadable value resolves to the safe state, loudly

`INFERENCE_EDGE_AUDIENCE=stage-3` closes the edge and logs
`rollout.flag.unreadable` once, naming the variable and the shape expected. It
never opens anything, and the readout reports `unreadable` rather than echoing an
operator's text back over HTTP.

Relay's `RELAY_ASSUME_FAILOVER_AUTHORIZED` — this ecosystem's precedent for a
dangerous switch — makes a malformed value a hard boot failure instead. That is
proportionate for a data plane whose whole job is the thing being gated; it is
not proportionate for `oxy-api`, which also serves authentication, email, storage
and federation, and must not be taken down by a typo in an inference flag.

### Why charging refuses a bare `true`

`INFERENCE_CHARGING_AUTHORIZED` takes `<reason>:<YYYY-MM-DD>` and refuses
`true`, `1`, `yes`, `on` and `enabled` outright, because `true` is the value that
arrives by accident: it is what a copied task definition carries, what a `.env`
picks up, and what somebody types to see whether a flag does anything.
`commercial-launch:2026-08-16` is not typed by accident, and it records the two
things an auditor asks about a charge — who accepted it, and when.

It does not expire, and Relay's does not either. Expiry would be wrong in both
directions here: at public scale an expired authorization either serves the world
for free or refuses every request, and both are expensive. What the date buys
instead is an age reported beside the flag in the readout, which is the question
a self-disarming timer was only ever a proxy for.

### A public launch is gated on charging

`INFERENCE_EDGE_AUDIENCE=public` with no charging authorization resolves
**closed**, with the reason `public_requires_charging`. The epic's own gate is
"prepaid public launch only after fraud, ledger and commercial-permission gates
pass", and serving the whole internet without charging is the expensive half of
that sentence. The failure this produces — a launch that visibly does not start —
costs one environment variable. The one it prevents is unbounded free inference
at internet scale.

A closed beta is deliberately NOT gated on it: a bounded, named audience may run
unpriced, and that is what the shadow period is for.

---

## Shadow metering

While `INFERENCE_CHARGING_AUTHORIZED` is unset, the edge does everything it
would do except take the money:

- it authenticates, attributes, authorizes, resolves the routing policy and the
  route, and forwards exactly as it would;
- it **prices the completed request** with `quoteUnits` against the route's own
  price version — the same function and the same price rows `settle` computes a
  bill from;
- it records the amount on one structured log line,
  `inference.edge.shadow_metered`, carrying `wouldHaveBilledAmount`, the
  currency, the units, the price version, the routing policy version and the full
  attribution tuple, correlated on `requestId`;
- it writes **no reservation, receipt, refund, ledger entry or balance
  movement**.

So a shadow period leaves nothing to reconcile away when charging is armed. The
figure is checked against the thing it predicts:
`packages/api/src/routes/__tests__/inferenceEdgeRollout.test.ts` runs the same
request twice — once shadow, once charged — and asserts the logged
`wouldHaveBilledAmount` equals the receipt's `billedAmount` and the balance
delta.

The units themselves are already recorded by the telemetry stream, which carries
units and never money by schema; the log line is the money half.

### What shadow metering does NOT enforce

Every balance refusal lives inside `reserve`, and `reserve` is the call being
skipped. Stated plainly rather than discovered in production:

- an account with **no billing profile** is served;
- an account with **no money** is served;
- a **spending limit** stops nothing;
- `GET /v1/generations/:id` has **no receipt** to return for the request;
- a repeated `Idempotency-Key` binds to no reservation and is **not refused**.

All five reappear the moment charging is armed. The last one matters for the
switch itself: a client retrying across the moment of arming can be charged for
a request it retried, because the first attempt left no reservation to collide
with.

---

## The stages, and what each one means in configuration

These are operational states. The code does not decide when to enter one; it
decides that each is expressible, enforceable, and answerable from one endpoint.

| Stage | `INFERENCE_EDGE_AUDIENCE` | `INFERENCE_MACHINE_CREDENTIAL_AUTH` | `INFERENCE_CHARGING_AUTHORIZED` | `INFERENCE_CATALOGUE_AUDIENCE` |
|---|---|---|---|---|
| Today, every deployment | unset | unset | unset | unset |
| Internal Alia canary | `internal` | unset | unset | unset |
| Oxy first-party canary | `first_party` | `enabled` | unset | unset |
| Closed external beta | `allowlist:<appId>,…` | `enabled` | unset | `public` |
| Prepaid public launch | `public` | `enabled` | `<reason>:<date>` | `public` |

The audiences are cumulative: a stage never locks out the previous stage's
callers, because an advance that did would be an outage for the people already
depending on it. The tiers come from the staff-controlled `Application.type` and
`Application.isInternal` columns, through one predicate
(`packages/api/src/utils/applicationTier.ts`) shared with the catalogue's
audience — a self-service application cannot promote its own tier.

**A stage is not reached by setting a variable.** Every stage above is also
gated on things this repository cannot switch: a data plane to forward to, a
catalogue with contents, anomaly and fraud controls, and the reconciliation the
shadow period exists to produce. [README.md](./README.md#what-is-not-built) is
the list.

---

## Dual-read and dual-write: there is nothing to build

The epic asks for "dual-read/dual-write only where necessary and for a bounded
migration window". **Nothing here needs it, and the honest answer is to say so
rather than to build a mechanism nobody will use.**

Dual-read/dual-write is how you cut over a live system from an old store to a
new one without a gap. Every table this platform reads and writes — the
catalogue, the routing policies, the price versions, the reservations, the
receipts, the refunds, the ledger entries, the balances, the usage events and
their rollups — is NEW, was created by this epic, and holds no production rows.
There is no previous inference ledger to read from, no previous catalogue to keep
in step, and no previous credential store to write through to.

The one thing that could be mistaken for a migration is the Alia proxy, and it is
not one: `POST /alia/chat/completions` and `POST /v1/chat/completions` are two
different systems reachable at two different paths, not one system being moved.
The proxy keeps working unchanged; the edge does not read or write anything the
proxy touches; retiring the proxy is a deprecation with a notice
([deprecation.md](./deprecation.md#the-alia-proxy-now-at-alia)), not a cutover.

The two places where a genuine dual-something exists are already built and are
not migrations either: `usage_receipts` carries a **price snapshot** copied off
the price version, so a receipt's arithmetic is checkable after the version
changes; and telemetry and the ledger record the same request twice on purpose —
units eventually-consistently for dashboards, money exactly for bills — which
[billing.md](./billing.md) explains and which must never be collapsed into one
number.

---

## The rollback plan

### The one thing a rollback cannot do

**Settled financial history cannot be deleted.** `usage_receipts`,
`usage_refunds` and `billing_ledger_entries` are append-only, enforced by
database triggers (`0034_inference_ledger_immutability`), and
`inferenceLedger.service.ts` issues no UPDATE against any of them. That is
deliberate and it is not something a rollback gets to suspend: a ledger you can
edit under pressure is not a ledger.

So a rollback of this platform is **not** "undo the charges". It is:

1. **Stop the flow of new financial events**, immediately and completely.
2. **Reverse the ones already recorded**, as compensating records that are
   themselves part of the history.

### Step 1 — stop the flow

One variable, and the effect is total and immediate on the next request:

```
INFERENCE_CHARGING_AUTHORIZED=          # unset it
```

The edge returns to shadow metering: it still serves, still meters, still prices
and still logs, and it writes no reservation, receipt, refund or balance
movement. **No in-flight request is left half-charged**, because the flag is read
ONCE per request rather than per step — a request that reserved will settle
against its own hold under the value it started with, and a request that starts
after the change takes neither.

To stop serving as well, close the audience:

```
INFERENCE_EDGE_AUDIENCE=closed
```

Every authenticated caller then receives `permission_denied` with a `requestId`.
Nothing is reserved, nothing is forwarded, and nothing is charged. This is a
customer-visible outage and is the heavier of the two levers; reach for the
charging flag first unless the problem is the serving itself.

Neither lever requires a deploy, a migration or a code change — both are
environment values on the ECS task definition, and both take effect on task
restart. Neither can be half-applied: there is no per-account, per-application or
per-request override of either, on purpose.

### Step 2 — reverse what was recorded

Each of the three financial write paths has exactly one compensating operation,
and each is idempotent on a caller-supplied key, so a reversal run twice reverses
once:

| What was recorded | How it is reversed | Result |
|---|---|---|
| A **hold** (`usage_reservations` in `held`) | `expireReservations()` releases it at its deadline; every path out of the edge already settles its own | A `usage_refunds` row with a reason, and the money back in the customer's buckets |
| A **charge** (`usage_receipts`) | `reverseReceipt({ idempotencyKey, receiptId, reason })`, whole or partial | A `usage_refunds` row and a `settlement_reversal` ledger entry moving the amount from `platform_revenue` back to the buckets it was drawn from — the receipt stays, and stays true |
| A charge that was **too small** | A supplementary receipt naming `correctsReceiptId` | Two receipts that sum to the right amount, neither of which was edited |

A reversal restores the customer's balance exactly, bucket by bucket, read back
from the settlement's own journal entry rather than guessed — and it unwinds in
REVERSE consumption order, so a partial reversal reduces what an invoiced account
owes before it credits back prepaid money, and credits back promotional money
last. Unwinding in consumption order would inflate the one bucket that can expire
and can never be paid out.

**No financial event is lost and none is duplicated**, and that property does not
rest on the rollback being done carefully:

- nothing is lost, because nothing is deleted — the receipt, the refund and the
  `settlement` and `settlement_reversal` entries all remain, and the sequence
  reads as what happened;
- nothing is duplicated, because every write is `ON CONFLICT … DO NOTHING
  RETURNING` on a caller-supplied idempotency key, never catch-the-duplicate. A
  repeated reversal returns the original outcome and writes nothing new. (A
  `catch` cannot tell a duplicate key from a dropped connection, which is why
  that shape is not used anywhere in the ledger.)

### What a rollback does NOT need to touch

- **The catalogue.** Closing `INFERENCE_CATALOGUE_AUDIENCE` withholds the listing
  from public viewers; it changes nothing about what has been served or charged,
  and a route's commercial permission is a separate, staff-audited decision that
  a rollout flag cannot alter.
- **Credentials.** Machine credentials keep their own lifecycle — revoke,
  rotate, expire — and `INFERENCE_MACHINE_CREDENTIAL_AUTH=disabled` shuts the
  whole lane without touching a single row.
- **The database.** There is no migration to reverse. The flags are read at
  request time from the environment; rolling back changes no schema and drops no
  table.
- **The Alia proxy.** It was never in this path.

### What to check after a rollback

1. `GET /inference/admin/rollout` — the resolved state of all four flags, with
   the reason for each. `charging.shadowMetering: true` is the assertion that the
   flow has stopped.
2. `inference.edge.shadow_metered` log lines appearing again, which is what
   distinguishes "charging stopped" from "the edge stopped".
3. No new rows in `usage_receipts` after the change, scoped by `settled_at`.
4. For each reversal, the receipt, its refund and the `settlement_reversal`
   ledger entry — and the account's balance back to what the ledger says it
   should be.
