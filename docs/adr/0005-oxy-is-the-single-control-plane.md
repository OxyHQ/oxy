# ADR 0005 — Oxy is the single control plane for inference; the data plane owns no customer

- Status: accepted
- Date: 2026-08-15
- Issue: #972

## Context

Oxy already holds every customer-facing primitive an inference platform needs,
and holds each of them exactly once:

- **One account graph.** `users` is the account table; `kind` is
  `personal | organization | project | bot | channel`
  (`packages/api/src/db/schema/users.ts:144`, derived from
  `packages/contracts/src/accountGraph.ts:35`) and `parent_account_id`
  (`packages/api/src/db/schema/users.ts:353`) makes it a tree. Membership is
  `account_members` (`packages/api/src/db/schema/accountMembers.ts:68`) with one
  role set plus explicit grants and revokes.
- **One application identity.** `applications.owner_account_id`
  (`packages/api/src/db/schema/applications.ts:172`) is the owner, and access to
  an application is *derived* from the caller's effective account role over that
  account — `packages/api/src/routes/applications.ts:72-79` states it, and there
  is no `application_members` table in `packages/api/src/db/schema/`.
- **One credential lifecycle.** `application_credentials`
  (`packages/api/src/db/schema/applicationCredentials.ts:55`): `public_key` is
  the OAuth `client_id`, `secret_hash` is SHA-256 of a secret shown exactly once
  (`:71-73`), rotation sets the predecessor `deprecated` with a 7-day
  `expires_at` grace (`:87-88`), and `rotated_from_credential_id` (`:102`) is the
  audit hop.
- **One financial surface.** `user_credits`
  (`packages/api/src/db/schema/userCredits.ts:58`), `billing_transactions`
  (`packages/api/src/db/schema/billingTransactions.ts:154`, money as
  `amount_minor_units bigint` at `:179`), and the Stripe checkout/portal/webhook
  routes in `packages/api/src/routes/billing.ts:107-362`.
- **One customer console.** `packages/console/src/routes/_layout/` — apps,
  models, playground, usage, billing, settings, documentation.

One thing in the repo already contradicts that picture, and it is the thing this
epic exists to replace: `app.use('/v1', userRateLimiter, aliaRoutes)`
(`packages/api/src/server.ts:647`) forwards `POST /v1/chat/completions` to
`https://api.alia.onl/v1` under a single static `ALIA_API_KEY`
(`packages/api/src/routes/alia.ts:7-8`, `:65-81`). Oxy is currently a proxy in
front of somebody else's control plane for the exact surface it should own.

A second control plane is not a hypothetical risk here. It is what happens by
default when a data-plane team needs to answer "who is calling and can they
afford it?" and no answer is available except the one they build.

## Decision

**Oxy is the single control plane. Every customer-facing identity, permission
and financial fact is an Oxy row, and no other system may hold an editable copy
of one.**

The epic's non-negotiable invariants, each with what it forbids in this repo:

1. **One account/organization/project hierarchy: Oxy Accounts.** Forbids any new
   table keyed by an organization, workspace, team or tenant that is not
   `users.id`. `workspaces` was already collapsed into the account graph; it does
   not come back under another name.
2. **One application identity: the Oxy `Application` id.** Forbids a data-plane
   `app_id`, `tenant_id` or `project_key` with its own issuance. Relay receives
   `applications.id` and stores it as an opaque string.
3. **One customer credential lifecycle: `ApplicationCredential`.** Forbids a
   second key table. The OpenAI-compatible machine key of workstream 2.3 is a new
   `type` on `application_credentials`, never a new table.

   As of workstream 2.3 this is a statement about the schema and not only an
   intention: **both other key tables are gone.** `developer_api_keys` was dropped
   by `packages/api/drizzle/0047_retire_developer_api_keys.sql` and
   `account_credentials` by `0048_retire_account_credentials.sql`, each after a
   production row count confirmed it empty (0 rows, beside controls — a bare zero
   from a query is not evidence that the thing is absent).

   `account_credentials` is worth naming explicitly, because it was **not** on any
   checklist and was found only by auditing against this invariant rather than
   against the task list. It was a `service` credential for `bot`-kind accounts
   with a complete public mint/rotate/revoke surface, a `secret_hash` and scope
   validation — and nothing authenticated against it: its only resolver had zero
   callers. A key table that grants nothing is still a second key table, and a
   customer performing a revocation on one is being told something untrue. The
   lesson generalises past this ADR: **the thing this invariant forbids is a second
   key TABLE, not a second working credential**, so "it authenticates nothing"
   argues for removal and never for an exemption.

   There is deliberately no exemption list here. If a future account-owned or
   device-owned principal genuinely needs its own credential store, that is an
   amendment to this ADR with its reason stated, not a table that quietly appears
   beside `application_credentials`.
4. **One billing account, balance and ledger: Oxy Billing.** Forbids a data-plane
   balance, quota counter or credit column that a customer could ever be shown.
   Relay may count tokens; it may not decide whether the customer can afford
   them.
5. **One customer-facing developer console: `console.oxy.so`.** Forbids a Relay
   dashboard, a Relay login and a Relay API-key page. Operator-facing internal
   tooling for provider health is not a customer console and is not covered by
   this invariant.
6. **Relay cannot create or mutate Oxy accounts, members, applications or
   credentials in its own database.** Forbids write-back of any kind. Relay's
   only writes about a customer are its own request/usage records keyed by Oxy
   ids.
7. **Generic inference endpoints are served through the Oxy public API edge, not
   through Alia as an infrastructure proxy.** Forbids the current
   `packages/api/src/routes/alia.ts` shape surviving the migration: a shared
   static upstream key with no per-customer attribution.
8. **Availability inside Alia does not imply permission to resell publicly.**
   Forbids deriving the public catalogue from "what a provider adapter can
   technically reach" (ADR 0008, and the `availabilityScope` /
   `commercialPermission` fields of workstream 11).
9. **A concrete model request is never silently served by a different model.**
   Forbids treating same-model deployment failover and cross-model fallback as
   one feature. They are separate policy switches (ADR 0008).
10. **Customer charges never use floating point as the financial source of
    truth.** Forbids `double precision` on any money column. The existing
    `api_key_usage_events.credits_used double precision`
    (`packages/api/src/db/schema/apiKeyUsageEvents.ts:95`) is telemetry and is
    named as such by ADR 0009; it must not become the ledger.
11. **Stripe is a payment/invoicing processor, not the usage ledger.** Forbids
    reading a balance from Stripe meters, and forbids reconstructing usage from
    Stripe objects.
12. **Provider and BYOK secrets are never plaintext application data.** Forbids a
    `provider_api_key` column beside `applications`, and forbids returning one
    through Console, the API, logs or errors.
13. **Prompts and responses are not persisted by default.** Forbids adding a
    request-body or completion column to any telemetry or billing table.

**Where a fact lives is not negotiable per feature.** ADR 0006 states the
boundary and the responsibility matrix; every table, event and API surface in
this epic has exactly one owner recorded in
`docs/architecture/inference-responsibility-matrix.md`, and an item in neither
that matrix nor its not-applicable list is a defect in the matrix, not a licence
to place the fact wherever is convenient.

## Alternatives rejected

**Let Relay own its own accounts and reconcile.** Reconciliation between two
account graphs is not a background job; it is a permanent source of "the console
says one thing and the invoice says another", and the failure is silent because
both sides are internally consistent. The cost is paid by whoever answers a
billing dispute, forever.

**Keep Alia as the inference control plane and have Oxy call it.** That is the
present shape (`packages/api/src/server.ts:647`). It puts customer identity,
model availability and cost inside a product, so every other consumer of
inference becomes a second-class client of that product, and Oxy cannot bill for
what it cannot attribute.

## Consequences

- The `/v1` mount changes meaning. It stops being an Alia proxy and becomes the
  Oxy public inference edge (ADR 0010), which is a customer-visible behaviour
  change, not a refactor.
- `developer_api_keys`, `api_key_usage_events.api_key_id` and
  `account_credentials` are **removed** (`0047`, `0048`), each after a production
  row count confirmed it empty. The gate was always the row count rather than a
  grep, because "no code references it" and "no rows exist" are different claims
  and only the second one licenses a `DROP`. `api_key_usage_events` itself
  survives: it is general API telemetry with two live readers, and only its stale
  key reference went.
- Any Relay-side design document that names a customer, an organization, a key
  or a balance is a boundary violation and is reviewed as one, regardless of how
  the field is spelled.
- The console remains the only place a customer-visible inference control is
  edited, which means Console work is on the critical path for every workstream
  that adds a control (routing policy, budgets, BYOK), not a follow-up to it.
