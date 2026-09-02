# ADR 0016 — Oxy persists no inference payload, and the four properties #972 asks of a debug capture are PRECONDITIONS on building one rather than follow-up work

- Status: accepted (the refusal is the decision; a capture mechanism is deferred behind four named preconditions)
- Date: 2026-08-17
- Issue: #972 (workstream 12, data handling)

## Context

Issue #972 section 12 opens with two checkboxes that are already satisfied —
"Default to no prompt/response persistence" and "Store only the
technical/economic metadata necessary for operation and billing" — and then asks
for a third:

> Make debug payload retention explicit opt-in, time-limited, encrypted and
> audited.

Read as a work item, that is a request to BUILD a payload-capture pipeline with
four properties. Read against the state of the code, it is a request to build the
one thing the two satisfied checkboxes exist to prevent, and then to protect it
with four controls of which one is currently impossible.

**What the code actually holds.** The two tables an inference request writes carry
no payload column of any kind:

| Table | Holds |
|---|---|
| `inference_usage_events` | account, application, credential, `requestId`, optional `generationId`, environment, endpoint, status code, outcome, requested and resolved model reference, serving provider, deployment id, route switches, unit totals, latencies — and no money column at all |
| `usage_receipts` | the same ids, the unit totals, the price-version snapshot, the exact amount |

Prompts do not reach the logs either, and that is measured rather than asserted:
`packages/api/src/routes/__tests__/inferenceEdge.test.ts` plants a marker inside a
prompt AND inside a tool description, exercises both a served request and a
refused one — refusals being where a body is most tempting to log — sweeps every
`warn`/`error`/`info`/`debug` call, and carries both a vacuity floor (the logger
was called at all) and a positive control on the search itself (something that IS
logged is found by the same pass).

**Why provider-key custody does not authorize payload capture.** ADR 0019 gives
provider credentials a narrow KMS boundary inside Kaana. That control task can
encrypt provider-key bytes into Kaana PostgreSQL; it is not a general Oxy payload
vault, and Kaana intentionally persists no prompt or completion. Oxy still has no
approved capture store, retention key, redaction pipeline or read boundary.
Reusing the provider-credential key or putting a payload key beside its
ciphertext would collapse the separation this ADR requires.

Composed: building capture now would produce a table of customer prompts and model
outputs, encrypted with a key reachable from the process that holds the
ciphertext, with an opt-in switch and an audit trail around it. That is a strictly
worse position than having no capture at all, and it would be reached by
completing a checkbox.

## Decision

**Oxy persists no prompt, no completion, no chat message body and no tool
argument. There is no mechanism to turn payload retention on, and the four
properties #972 section 12 asks for are PRECONDITIONS on introducing one — all
four, before the first row is written — not properties to add to a capture
mechanism that already exists.**

The four, stated as preconditions:

1. **Explicit opt-in, recorded as a decision with an author and a date.** Not a
   boolean environment variable. The precedent is
   `INFERENCE_CHARGING_AUTHORIZED=<reason>:<YYYY-MM-DD>`
   (`packages/api/src/config/rolloutFlags.ts`), which refuses a bare `true`
   because `true` is the value that arrives by accident.
2. **Time-limited by a mechanism that runs, not by a declared window.**
   `packages/api/src/db/expiry.ts` declares `{ table, column, retentionSeconds }`
   per table and `server.ts` sweeps the whole registry hourly. A registry that
   nothing runs reads exactly like one that runs, so the registration is asserted
   against the entrypoint itself. A capture table joins that registry in the same
   change that creates it.
3. **Encrypted with a dedicated key Oxy does not hold in PostgreSQL.** This is
   the blocking one. ADR 0019's Kaana KMS path is scoped only to provider
   credentials and authorizes no payload storage. A capture design needs its own
   approved store, key policy and read boundary; until all three exist, this
   precondition cannot be met and therefore neither can the decision be
   revisited.
4. **Audited, and PII-redacted at the point of capture.** The audit pattern exists
   (`application_credential_audit_events`,
   `inference_provider_connection_audit_events`, both with database-level
   immutability triggers): arm, disarm and every read of a captured payload are
   audit events. Redaction has to happen where the bytes are still known — which
   is the data plane, not Oxy — for the reason `packages/contracts/src/inference/errors.ts`
   states about credentials: a pattern reading the OUTPUT cannot be the control,
   and issue #1027 is what that distinction cost when a producer redacted the span
   a pattern matched and left the key intact.

**The refusal is enforced, not documented.**
`scripts/check-no-payload-persistence.mjs` is a census over the drizzle schema
barrel — the same module `drizzle.config.ts` generates migrations from, so a table
it does not see gets no migration — and it fails on a payload-shaped column name
or on any `jsonb`/`json`/`bytea` column that does not declare what it holds. It
runs as the `Schema Payload Policy` job, which `check-ci-complete.mjs` requires to
be a dependency of the one status check `main` requires.

## Alternatives rejected

**Build it now with a key in PostgreSQL, or in the task environment, "for now".**
This is the option that always looks reasonable and is the actual failure — the
same shape ADR 0013 rejected for BYOK credentials. "For now" outlives the person
who wrote it, and a table of prompts is a larger and more attractive target than a
column of provider keys.

**Build the pipeline unencrypted and add encryption later.** The row written
before the encryption lands is written in the clear and is not retroactively
protected by the change that adds it. The order is not an implementation detail.

**Write the four properties into a design document and leave the checkbox
unticked.** Closer to right, and what the repository had before this ADR — but a
document is not a control. The next person with a debugging problem at 2am adds a
`jsonb` column, and nothing objects.

**Make the guard a code review convention.** A convention that has to be
remembered by whoever reviews a schema change is not a gate. The specific failure
this avoids is incremental: a `metadata jsonb` column added "for one field", then
a second field, then the request body, none of it a decision anybody made.

## Consequences, including the ones that cost something

- **Debugging a customer's failing inference request means reproducing it, not
  reading it back.** That is a real operational cost and it is the price of the
  invariant. What Oxy does have is the `requestId` on every response, the usage
  event, the receipt, and a refusal code — enough to say what happened, not enough
  to say what was asked.
- **#972's "deletion/export behaviour that preserves legally required financial
  records while deleting optional payload data" has no payload half to implement,**
  and becomes real work the day capture does. The financial half is done:
  `DELETE /users/me` refuses while a live subscription or a held reservation
  exists, archives rather than deletes when a `RESTRICT` foreign key from a
  financial table blocks a hard delete, and derives that blocking set from
  `pg_constraint` rather than a hand-maintained list.
- **"Add PII/redaction controls for opted-in traces" stays unchecked and is
  correctly blocked.** There are no traces — no trace or span infrastructure of any
  kind exists in this repository — so there is nothing to redact PII from. The
  adjacent control that DOES exist is the credential refusal on free error text,
  which is a last resort rather than the control.
- **The guard has a named residue.** A `text` column with an innocuous name could
  hold a prompt, and no static census sees that. There are over a thousand `text`
  columns here, so requiring a declaration for each would be a list nobody
  maintains. What is guaranteed is that payload persistence cannot arrive by
  accident or by increment: it takes a name that says what it is, or a new
  open-shaped column, and both are refused until somebody edits the guard and says
  why.
- **Every open-shaped column in the schema now carries a written purpose** — 32 of
  them, in `DECLARED_FREE_SHAPED_COLUMNS`. That is a maintenance cost on adding a
  `jsonb` column, paid deliberately: it is the one shape that can hold an entire
  request without anyone choosing to make it possible.
- **This ADR is revisitable, and the condition is explicit:** a dedicated payload
  capture design must satisfy all four preconditions with its own externally
  controlled key and audited lifecycle. Kaana's provider-credential KMS path is
  not that design, and an ADR that treated it as one would overrule the boundary
  rather than satisfy it.
