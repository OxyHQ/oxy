# Data retention and regional policy

What Oxy keeps about an inference request, for how long, and where. Two halves,
and they answer to different rules: **what OXY holds** is a property of this
platform, and **what a ROUTE does with your payload** is a property of the
deployment that served it.

Status of the whole platform: [README.md](./README.md).

---

## Prompts and responses are not persisted

Default off, and there is no switch — **no path in this repository writes a
prompt, a response, a tool argument or a model output to storage.** The two
tables an inference request produces carry ids, counts, model references and
money, and no payload column exists on either to hold anything else:

| Table | Holds |
|---|---|
| `inference_usage_events` | account, application, credential, `requestId`, optional `generationId`, environment, endpoint, status, outcome, requested and resolved model, serving provider, unit totals — **and no money column at all** |
| `usage_receipts` | the same ids, the unit totals, the price snapshot, the exact amount |

Nor do prompts reach the logs. Every log line on the edge's execution path names
ids, codes and counts; the request body, the messages, the tool arguments and
the output are passed to the logger on no path, and the test that asserts it
plants a marker inside a prompt and searches every logged field for it, with a
positive control proving the logger was called at all.

**Opt-in debug payload retention does not exist.** #972 section 12 asks for one
that is explicit, time-limited, encrypted and audited; none of those four is
built, so there is no way — for you or for Oxy — to turn payload retention on.

### Error text is filtered, in both directions

An upstream provider's error message routinely echoes the request that caused
it, which makes it the most likely place for a credential to escape. Free error
text is bounded and **refused outright if it contains credential-shaped
material** — a bearer token, an `authorization:` or `api_key=` fragment, an
`sk-…` or `sk_live_…` string. Applied to Oxy's own messages as well as an
upstream's: a leak is no less a leak for having been written by a provider. A
refused message is REPLACED, so the error still reaches you with its code,
`requestId` and retryability intact.

The upstream passthrough is a strict object of four fields — provider, status,
the upstream's own code, its message — with no room for headers or a request
body. Widening it is a contract change with a version bump.

---

## How long Oxy keeps what it does keep

| What | Window | Actually swept? |
|---|---|---|
| `inference_usage_events` (per-request telemetry) | 90 days | **No — see below** |
| `inference_usage_daily_rollups` (aggregates) | not swept, by design | n/a |
| `usage_receipts`, `usage_refunds`, `usage_reservations`, `billing_ledger_entries`, `billing_ledger_postings` | **never swept** | n/a |
| Application credential audit events | 730 days | no |
| Provider connection audit events | 730 days | no |

**The 90-day window is declared and not yet operating.** The sweep mechanism
exists, `inference_usage_events` is registered with the right column and
retention, and the registry is covered by tests — but nothing schedules a run,
so no row has been deleted by it. Correctness does not depend on it: the readers
bound their own windows, so the sweep is housekeeping. Treat 90 days as the
retention this platform has committed to and not as a description of what is on
disk.

**The financial tables must never appear in that registry**, and a test fails if
one is added. A receipt swept on a telemetry schedule is a destroyed financial
record, and it would be silent. Daily rollups are deliberately not swept either,
so usage history outlives the per-request rows it was built from.

### Two kinds of number, two retentions, one reason

Telemetry is eventually consistent, written outside any ledger transaction, and
can lag or — on a recorder failure — miss a request entirely. A receipt cannot.
The telemetry stream carries **no money column at all**, which is the strongest
available form of "telemetry must not become the financial ledger": a
customer-visible billed figure has nowhere to come from except a receipt.
[billing.md](./billing.md#why-your-dashboard-and-your-bill-are-different-numbers)
is the authority.

### No user IP is stored, anywhere, in any form

A platform-wide invariant, not an inference decision: **no user IP address is
persisted — raw, hashed, or geo-derived, country included** — in the database,
the logs, metrics metadata or a DTO. Rate limiting is the one place an IP may be
touched, transiently, as an HMAC'd Redis key with the limiter's own TTL. The
inference edge's own limiters are not keyed on an IP at all: they key on the
credential and the application, because an anonymous key would bucket every
unauthenticated attempt together and a per-source-IP key would collapse a whole
customer's traffic behind one NAT.

Audit trails, anomaly detection and sybil resistance were deliberately given up
for this. It is not an oversight to be repaired.

---

## What a ROUTE does with your payload

Oxy not retaining a prompt says nothing about the provider that ran it. Each
catalogue entry therefore carries a structured `dataPolicy` — structured rather
than prose, because it is meant to be matched against, not read:

| Field | Means |
|---|---|
| `retainsPayloads` | whether this route keeps prompts and responses at all |
| `retentionDays` | for how long. Zero when nothing is retained |
| `trainsOnCustomerData` | whether your payloads train models |
| `zeroDataRetentionAvailable` | whether a zero-retention mode can be requested on this route |
| `subprocessors` | the named third parties a payload may pass through |
| `policyUrl` | the provider's own published policy |

Two combinations are refused by the contract rather than trusted to be
consistent: a route that retains nothing cannot declare a retention window, and
a route that retains nothing cannot train on customer data. A route claiming
either is reporting one of its own fields wrongly, and a customer constraint
would then be enforced against a value that is not true.

**The catalogue is empty**, so there is no route whose data policy you can read
today. When there is, `oxy.inference().getModel(id)` returns it.

---

## Regions

### Where the control plane runs

Oxy's own control plane — the API, the ledger, the catalogue, the audit trails —
runs on AWS in **us-west-2 (Oregon)**: ECS Fargate behind one load balancer, RDS
PostgreSQL, ElastiCache. That is where every row named on this page lives. It is
a single region and there is no per-customer residency option for the control
plane.

### Where a request would run

A deployment declares its `regions`, and a catalogue entry reports them to you.
That is the serving side, and it is the data plane's — Oxy publishes the fact,
the data plane owns the placement.

### The residency and retention controls are enforced

A routing policy's `allowedRegions`, `deniedRegions`, `requireZeroDataRetention`
and `prohibitTrainingOnCustomerData` are validated at write time, versioned,
recorded on the receipt, **and applied to the candidate routes before one is
chosen**. A request that no route satisfies is refused with `policy_violation`
(403), naming the controls that excluded every candidate — never downgraded to a
route the policy forbade.

Two readings decided in the implementation, both the stricter one:

- **`allowedRegions` is a subset test, not an overlap.** A deployment declares
  every region it MAY serve from, and which it picks is the data plane's — so a
  route that may run outside your allowed set does not qualify.
- **`requireZeroDataRetention` needs the route to actually not retain.**
  `zeroDataRetentionAvailable` is a capability; a route that has it and still
  retains by default is excluded.

The constraints read the DEPLOYMENT's own data policy rather than the provider
organisation's default, so a zero-retention endpoint from a provider that
otherwise retains is usable.

This landed in [#1012](https://github.com/OxyHQ/oxy/pull/1012), closing
[#1011](https://github.com/OxyHQ/oxy/issues/1011), which recorded the earlier
state: the constraints were stored, versioned and read by nothing, so every
visible signal said they were in force. Measured on `main` at `da404475`,
2026-08-16.

**You cannot observe it yet.** The catalogue is empty, so no candidate is ever
filtered in practice — every model you name answers `model_not_found` first. Once
there is a catalogue, verify by reading the chosen route's own `dataPolicy` and
`regions` back rather than trusting the policy alone.

The two price ceilings are the exception and are NOT enforced — see
[routing.md](./routing.md#stored-versioned-pinned-onto-the-receipt--and-not-enforced).

---

## Deletion and export

- **Financial records are exportable and not deletable.**
  `GET /inference/reporting/accounts/:accountId/charges/export` produces the
  settled charges for enterprise reconciliation. A correction to a settled
  record is an appended compensating entry, never an update and never a delete —
  a mutated financial record cannot be distinguished from a correct one after
  the fact.
- **There is no inference-specific deletion or export path for payload data**,
  because there is no payload data to delete or export. #972's "deletion/export
  behaviour that preserves legally required financial records while deleting
  optional payload data" becomes real work the day opt-in debug retention does.
- **`GET /users/me/export`** is the identity and profile export and is unrelated
  to inference. It is documented with the identity layer, not here.
