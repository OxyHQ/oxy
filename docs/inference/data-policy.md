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

### The absence is enforced, and this is where the gate is

[ADR 0016](../adr/0016-no-inference-payload-persistence.md) turns that state from
a fact about today's code into a decision with a lock on it: **the four properties
are PRECONDITIONS on introducing capture, not work to do afterwards**. Kaana's
KMS role and encrypted PostgreSQL store are deliberately scoped to provider-key
custody; they are not an Oxy payload-retention backend and must not be widened
into one. Capture cannot honestly land until it has its own reviewed,
time-bounded encryption and deletion design.

`scripts/check-no-payload-persistence.mjs` is what makes the refusal survive the
next person who has a reason. It is a census over the drizzle schema barrel — the
same module `drizzle.config.ts` generates migrations from, so a table it cannot
see gets no migration — and it fails a pull request on either of two things:

- a column whose NAME says it holds a payload (`prompt`, `completion`, `payload`,
  `messageBody`, `toolArguments`, `rawResponse`, `modelOutput`, `debugCapture`
  and the rest), among columns whose type could actually hold one. The type filter
  is structural, which is why the real `supports_prompt_caching` and
  `retains_payloads` BOOLEANS need no exception;
- any `jsonb`, `json` or `bytea` column — array forms included — that does not
  declare what it holds. That is the half a name ban cannot do: a payload column
  called `capture` or `d` matches no pattern, and an open shape is the one type
  that can hold an entire request without anyone deciding it should. All 32
  open-shaped or payload-named columns in the schema carry a written purpose, and
  an entry naming a column that no longer exists fails too, so the list cannot
  drift.

It runs as the `Schema Payload Policy` job, which `CI complete` — the one status
check `main` requires — must depend on. Its own fixture test plants a payload
column per banned pattern and requires the census to flag each one, so a clean
result is a real absence rather than a census that read nothing.

**The named residue:** a `text` column with an innocuous name could hold a prompt,
and no static census sees that. What is guaranteed is that payload persistence
cannot arrive by accident or by increment — it takes a name that says what it is,
or a new open-shaped column, and both are refused until someone edits the guard.

### Error text is filtered, in both directions

An upstream provider's error message routinely echoes the request that caused
it, which makes it the most likely place for a credential to escape. Free error
text is bounded and **refused if it still looks like it carries a credential** —
a credential-bearing header or parameter assigned a value long enough to be one
(`authorization:`, `x-api-key:`, `anthropic-api-key:` and the rest of that
family), a bearer token, an issued token shape (`sk-…`, `sk_live_…`, a JWT,
`AKIA…`, `ghp_…`), or a redaction placeholder standing next to a value that
survived it. Applied to Oxy's own messages as well as an upstream's: a leak is
no less a leak for having been written by a provider. A refused message is
REPLACED, so the error still reaches you with its code, `requestId` and
retryability intact.

**That refusal is a last resort, not the control.** A pattern reading the output
cannot be what keeps a credential out of an error; the reliable control is
redacting the secret VALUE where its bytes are still known, which only the
component that made the upstream call can do. Issue #1027 is what that
distinction cost: the previous pattern matched the header NAME, so a producer
redacting the span it matched produced `{x-[redacted] <the key>}` — no longer
matching, therefore accepted, with the key intact. **Never redact by replacing
the span this pattern matches**, and never treat a string's acceptance here as
evidence that it is clean.

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

**The 90-day window is operating.** `inference_usage_events` is registered with
the right column and retention, and `server.ts` sweeps the whole registry hourly
(`EXPIRY_SWEEP_INTERVAL_MS`) — so 90 days describes what is on disk, not only
what has been committed to. It was declared for some time before it was
enforced: a registry that nothing runs reads exactly like one that runs, which
is why the registration is asserted against the entrypoint itself rather than
left to the sweep's own tests.

Correctness does not depend on the schedule. Every reader bounds its own window,
so a missed run costs disk rather than a wrong answer, and a run that hits its
per-table batch ceiling leaves the remainder for the next hour and says so in the
log.

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

The two price ceilings and `optimiseFor` are the exceptions and are NOT
enforced — see [routing.md](./routing.md#not-enforced).

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
  optional payload data" becomes real work for PAYLOADS the day opt-in debug
  retention does.
- **`GET /users/me/export` now carries a `financial` section** — the calling
  account's own `usage_receipts`, `billing_ledger_entries` and
  `usage_reservations`, read-only, scoped to that account and to nothing else.
  Before it did not, and the practical consequence was that a person exercising a
  subject-access request learned nothing about what they had been charged unless
  they also happened to be an account administrator with access to the reporting
  route above. The deletion side of #972 section 12 retained financial records the
  export then never disclosed; this is the other half.

  Amounts are exact decimal STRINGS, never JSON numbers. Empty arrays are the
  normal answer and mean the account has no ledger history, not that anything was
  withheld — the section is required by the contract precisely so "nothing" is a
  statement somebody made rather than a missing key.

  The enterprise route is unchanged and remains a different thing: it is an
  account-billing surface with its own authorization, over an account the caller
  administers. This is the subject's own copy.
- **Non-revoked Kaana custody now BLOCKS account deletion, loudly.**
  `inference_provider_connections.owner_account_id` is `RESTRICT`, and account
  closure writes a durable fence before external cleanup so a retry cannot race
  a new BYOK connection. `DELETE /users/me` answers `409` naming every exact
  connection whose `custody_state` is not `revoked`; the customer revokes and,
  if necessary, reconciles that same operation until Kaana acknowledges it.

  It is refused rather than revoked automatically for the same reason a live
  subscription is refused: revoking a BYOK credential is a declaration to a THIRD
  PARTY, whose own console still shows a key the customer believes is in use.
  Lifecycle `status = revoked` alone is insufficient while custody is still
  `reconcile`. `disabled` is reversible and Kaana still holds the credential, so
  serving status is deliberately not the closure test.
