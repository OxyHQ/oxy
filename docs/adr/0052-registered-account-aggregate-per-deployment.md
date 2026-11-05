# ADR 0052 — Registered accounts are a per-deployment ledger with a bounded snapshot total

- Status: accepted.
- Date: 2026-11-02.
- Issue: OxyHQ/oxy#2076 (for OxyHQ/Mention#1748).
- Builds on: ADR 0049 (first-party workloads, no scopes), ADR 0026 (workload identity).

## Context

A federated product must report how many people registered on one deployment.
Oxy owns identity but accounts are global: a first-party session has no
`application_id`, `app_grants` is external-only after ADR 0049, and nothing
records that an account belongs to one deployment. Counting `users` is wrong for
every product, and Mention's main deployment and each managed instance must never
see one another's numbers.

## Decision

1. The deployment's attested first-party workload registers the accounts it
   provisioned (`application_account_registrations`, keyed by the workload's
   application, never a request field). Oxy admits only eligible accounts (local,
   personal, active, not being closed) and never reveals which ids were skipped.
2. The total is a snapshot row (`application_account_totals`) recomputed by a
   bounded, cluster-single-flight recount at most every five minutes and served
   with `computedAt`, `exact` and `stale`. No public request counts or enumerates.
3. Unknown is an error (503) and a failed refresh keeps the last good value;
   neither becomes `0`.
4. Only `authority: first_party` workloads may call it; external credentials are
   refused, with no scope, consent or API-key lane.

## Rejected

- Counting all `users` or users with a session: not deployment-scoped.
- Deriving membership from sessions or grants: first-party sessions carry no
  application; grants are external-only.
- A trigger-maintained counter: eligibility also changes on archive and closure,
  which no single write path owns, so a counter drifts where a recount cannot.
- Per-request counting or per-user enumeration by the product: unbounded cost.

## Costs

Oxy trusts the deployment's registration (it can check eligibility, not
membership). An existing deployment must backfill once. The recount grows with
one application's ledger; documented measurements are in
[the operating note](../auth/application-account-totals.md).
