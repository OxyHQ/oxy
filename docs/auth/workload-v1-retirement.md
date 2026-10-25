# Workload protocol v1 retirement — draft cutover

Status: source preparation only. This branch must not merge, release or deploy
until the root rollout coordinator records every gate below. The running fleet
still uses the finite compatibility bridge; this document does not claim its
retirement. No binding, credential, secret or database row is changed by this work.

ADR 0049 assigns scope-free authority to verified own workloads. Final retirement
makes all SDK workload token methods emit protocol 2, including maintenance calls
to `serviceToken()` and `serviceTokenFor()`. Explicit customer credentials still
use their external lane. A historical `wl_` token carrying external authority is
refused, not reclassified; current live workload proofs require the provisioned
environment, original application/owner and unrevoked binding.

The draft removes the runtime 27-binding whitelist and compatibility projections
from resource introspection, linked accounts, personal owner metadata, service
revocation events and managed-account session switching. The historical tuple
fixture remains only in rejection tests. Customer keys, external service JWTs
(including the supported `oxy-api` audience), OAuth/MCP grants and live scope
intersections retain their contracts. Product resource and account authorization
still applies to all own calls. Historical workload scope columns remain inert
for an additive rollout; a physical column drop requires a separate reviewed
post-deployment migration and must not remove external application/key scopes.

## Required evidence before activation

- Every current API, worker, publisher, integration process and MCP server has
  a verified running digest which produces protocol 2 and accepts its recipient's
  exact audience. A source merge or npm release alone is insufficient.
- Scheduled tasks, EventBridge targets, manual administrative workflows, rollback
  launch definitions and dormant one-shot jobs cannot launch an old producer.
  Kaana's credential-admin launcher must retain its separately verified image;
  do not create missing credential-control services during this cleanup.
- Move and Schedio are activated only after the Mention receiver; Clarity's
  reader/backfill and Mercaria receiver precede its producer. Legacy queued jobs
  keep their recorded original account/operation and are never promoted by brand.
- The Oxy-hosted Inbox client, catalog registrar and normalized-event outbox must
  first stop using `INBOX_APPLICATION_KEY`/`INBOX_APPLICATION_SECRET` and manual
  Alia token/fetch retry. They require a separate producer deployment with the
  shared workload provider and exact Alia recipient before this draft activates.
- No owned consumer or operator script still depends on scoped workload issuance,
  raw forwarded owner headers or a v1 introspection serializer. External scoped
  clients are not counted as violations of the own-workload migration.
- Fresh live canaries cover own v2, recipient mismatch, requester/account mismatch,
  binding revocation, external customer scope ceilings and external OAuth/MCP
  revocation. After old producers stop, drain existing tokens for their full
  maximum lifetime before removing the accepting readers.
- Root records the complete fleet and launcher inventory plus final authorization
  to retire the bridge. Until then, keep this PR draft and production unchanged.

## Operator scripts

Safety provisioning and Jev readback use explicit workload environments and live
identity, not workload or application scopes. Safety domain capabilities retain
their existing review policy; external credential ceilings remain unchanged.
`seedOxyApplicationScopes` still guards external credential expansion and no longer
computes own workload authority from those ceilings.

The completed 27-binding environment backfill command refuses before opening a
connection. Explicit binding administration remains available. The I05 pilot no
longer prepares/applies scoped workload configuration, mints a registrar key,
registers via that key or restores obsolete scopes on rollback. Its compiled
executor and ECS launcher admit only `retire`: revocation of the exact historical
registrar credentials identified by the validated original receipt, nonce,
application, owner, environment and scope. Cleanup keeps the existing audit rows,
rejects ownership drift and remains idempotent after receipt expiry. Historical
scope fields survive only in this receipt validator and test fixtures; they do
not read or grant runtime workload authority.

## Validation

At the draft checkpoint, focused verification passed:

- Core: 29 tests in four suites (all token helpers use v2, cache/audience boundaries,
  stale live projection refusal, explicit external credentials).
- API: 286 tests in 19 suites against an isolated local PostgreSQL 17 database,
  including scope-bounded external services, raw keys, OAuth, managed sessions,
  requester proofs, revocation, historical token refusal and operator cleanup.
- The API and its eight build dependencies compile; script typechecking, generated
  OpenAPI, AGENTS validation and strict Core Biome checks pass. Existing unrelated
  API lint warnings remain unchanged in the touched legacy files.
- Twelve offline ECS launcher tests pass. The actual emitted Node executor rejects
  both obsolete provisioning and rollback before configuring a database.

These checks establish source behavior, not fleet readiness.
No production cleanup, binding revocation or database backfill has run here.
