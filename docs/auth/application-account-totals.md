# Registered-account totals for a first-party deployment

Decision: [ADR 0052](../adr/0052-registered-account-aggregate-per-deployment.md).
Consumer: Mention NodeInfo `usage.users.total` (OxyHQ/Mention#1748).

Oxy accounts are global and a first-party session carries no application, so
"users of this deployment" is not derivable from existing rows. The deployment's
own workload registers the accounts it provisioned and reads a bounded total.
The main Mention deployment and each managed instance are separate
`applications` rows with their own workload bindings, so their ledgers and totals
never mix: the application is the verified workload's, never a request value.

## Calls (attested first-party workload only)

| Call | SDK (`@oxy.so/core/server`, `OxyServer`) | HTTP |
|---|---|---|
| Register accounts | `registerApplicationAccounts(accountIds)` (1-500 per call; returns newly registered count) | `POST /application-accounts/self/registrations` |
| Read the total | `applicationAccountTotal()` | `GET /application-accounts/self/total` |

No scope, consent, customer API key or user bearer is accepted: an external
credential gets 403. Neither call lists accounts or confirms whether an id exists.
Contracts: `@oxy.so/contracts` `applicationAccountRegistration*Schema`,
`applicationAccountTotalSchema`.

## What is counted

A registered account that is `type = 'local'`, `kind = 'personal'`,
`account_status = 'active'` and has no `account_closure_fences` row. Federated,
agent/automated, organization/bot/project, archived and closing accounts are
excluded, at registration and again at every recount. A deleted account cascades
out of the ledger at once. An account with no activity counts: registration is
the only criterion. One account registered by two applications counts once in each.

The ledger is the deployment's own claim of who it provisioned; Oxy checks
eligibility but cannot know membership independently. A deployment that never
registers an account never counts it, so an existing deployment must backfill its
local accounts once (batches of 500, idempotent) and register new ones when it
provisions them. Until the first snapshot exists the total is unavailable (503);
it is never `0`.

## Freshness and the exact flag

The response is a snapshot: `{ schemaVersion: 1, applicationId, total, exact,
computedAt, maxAgeSeconds: 300, stale }`.

- `exact: true`: `total` is an exact recount of the ledger at `computedAt`. Every
  snapshot is exact today. Read the flag anyway; `false` is reserved for an
  estimate and would be documented here first.
- `stale: true`: `computedAt` is older than `maxAgeSeconds`. A refresh is running
  or failed; `total` is the last good value, never a fabricated zero.
- A zero-registration deployment returns an exact `0` once its first snapshot
  exists.

## Cost and failure behavior

A read is one primary-key lookup of `application_account_totals`. Recounts run
at most once per five minutes per application cluster-wide: a transaction
advisory lock lets one API instance count while others skip, the winner
re-checks the snapshot under the lock, and the count runs under a 10 s
`statement_timeout`. A stale read serves the old row and starts one background
refresh (single-flight per process). A failed refresh leaves the row untouched.
With no snapshot, the first reader counts synchronously; if that fails the
caller gets 503.

Measured on a private Postgres 17 (unix socket, 550,000 users, a 500,000-row
ledger for one application and 50,000 for another): recount of the 500k-row
application 135 ms (parallel hash join; 450,000 counted), of the 50k-row one
43 ms (bitmap index scan on the primary key), snapshot read 0.009 ms, a
500-id registration 10 ms. Cost grows linearly with that one application's
ledger and is paid by a background refresh, not by a public request.

Callers (Mention) should cache the answer with their own stale-while-revalidate
and never turn a failed call into `0`.
