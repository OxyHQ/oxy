# I07 product access candidate — 2026-10-02

Status: partial implementation for review, not an approved catalogue or deployed
product access authority. Parent #1519; child #1525. No commercial offer is
registered, no migration/backfill writes run and no existing plan reader changes.

The additive contracts define product ownership/application binding, immutable
versioned offers, a commercial subscription with separate beneficiary and payer,
immutable offer/period segments and access grants. A plan change appends a segment;
it never changes the provenance of an old grant. A bundle remains one subscription
and issues grants for its benefits, rather than fake individual subscriptions.
Individual offers may cover one product; bundles may cover several. There is no
special identity-kind restriction, financial balance or price in an access answer.

`composeSubjectProductAccess` accepts trusted source/segment/grant snapshots and
filters by beneficiary, product, live subscription state, grant period and revocation.
It retains independent sources and never caches the result. Scheduled cancellation
keeps the paid period; a canceled source stops its grants and leaves other sources.
Capabilities combine by their grant provenance. Each quota explicitly chooses
maximum, sum or exclusive; incompatible rules/units and unsafe totals are conflicts
and grant no quota. No quota combination is selected on behalf of a product.
This function does not grant resource permission or authorize caller identity.

Before exposing a read API, resolve live session/delegation authority and bind the
requesting application to the registered product. An external application cannot
self-assert that registration. Build grant snapshots from durable server records,
not request bodies. Access readers receive no payer/provider/customer/balance data.

## Acceptance and remaining work

| Requirement | Current evidence | Remaining |
| --- | --- | --- |
| Two products, bundle + individual, source-only cancellation | 11 local composition tests, plus versioned contracts | Durable data/route + end-to-end authorization |
| Different beneficiary and payer, identity-kind parity | Separate account IDs, no kind gate; fixture distinct payer | I01 full lifecycle and product integration |
| Changing offers retains history | Immutable segments; old and new grants test | Schema/migration writer + idempotent financial-to-grant mapping |
| Revocation/membership, cache | No cache; revoked grant/source tests | I03 live authority + real cross-process route tests |
| Catalogue/combination policy | Explicit rule per quota, empty runtime catalogue | Nate's actual product and Oxy One composition decisions |
| Historical mapping and discrepancy report | No inference from names or monthly balance | Read-only inventory IDs across Oxy/Clarity/Mercaria and approved mapping |
| Grant credit balances/refund P3 | Not implemented | Exact per-grant ledger and approved spend order; never split mixed old balance by assumption |
| SDK/Console adopted | No new endpoint/client/UI yet | Publish approved upstream SDK then update consumers, evidence per I11 |

## Decisions to approve, without assumed values

1. Register each product ID with its actual owning account and application. Confirm
   what Oxy One includes. API credits remain excluded unless explicitly approved.
2. Freeze offer versions and choose combination per quota: maximum, sum or exclusive.
   Determine duplicate purchase prevention without silently canceling or refunding.
3. Map legacy subscriptions only by verified provider price/subscription IDs and
   confirmed product semantics. Unresolved rows are discrepancies that block removal
   of old readers. Do not map Pro/Business to a new product from the name alone.
4. Define consumption order for new per-grant credit balances and how the unchanged
   mixed historical balance participates. FIFO for new grants is a proposal, not
   policy. Existing bought credits and grants cannot be retroactively separated.
5. Approve I06 P1–P3 separately. A partial contract/compositor does not complete I07
   or unblock financial clawbacks.

Validation: API package `bun run test -- src/services/__tests__/productAccess.test.ts`
using a freshly provisioned loopback Postgres17 at port5549: 11/11, zero skipped.
Contracts `tsc --noEmit` and Biome lint `--error-on-warnings` pass; API changed-file
ESLint passes. Compilation is checked separately from behavior.
