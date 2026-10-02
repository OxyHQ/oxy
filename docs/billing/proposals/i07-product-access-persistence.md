# I07 structural product access — local candidate, 2026-10-02

Issue [#1525](https://github.com/OxyHQ/oxy/issues/1525), parent
[#1519](https://github.com/OxyHQ/oxy/issues/1519). This implements the independent
persistence/query/SDK portion of the contract/compositor in #1535. It registers
no commercial catalogue and activates no checkout, provider callback, plan,
financial credit grant, migration of historical balances or deployed consumer.

Implementation base: `7920fef6330de5e0e58051035eefa296791b4474`, including generated
0134. Draft review target is the composed integration branch, currently
`4f11aa410d01b6120aed578f45e175c763317f20`. The intervening I10 readback changes are
not I07. Two ID-column classifications from integration's `422ef4c44` were applied
locally to `deferredForeignKeys.ts` as explicitly coordinated; they already exist
in the target. No 0134 files were regenerated.

## Structure and boundary

Migration 0135 adds six normalized tables: products, versioned offers, offer
benefits, subscription sources, immutable offer segments and immutable grants.
The generated snapshot has 215 tables. Composite foreign keys bind each grant
to the beneficiary, offer/version/origin and benefit/product of its segment.
Database checks require explicit quota units, safe integer counts and an explicit
`maximum`, `sum` or `exclusive` rule. The individual-offer invariant is validated
by the writer and reader, including persisted malformed configuration.

Append-only triggers preserve configuration, subscription parties/provider
identity, historical segments and grant provenance. A grant can only be revoked
once. Its period must fit its immutable segment; renewal changes the source's
current period and appends segments instead of rewriting old history. Source
updates compare a server observation timestamp: older observations are ignored,
equal identical state replays, and equal conflicting state fails. This comparison
does not establish chronological ordering of provider events.

`registerProductAccessConfiguration` and `recordProductAccessPeriod` are internal
functions with explicit typed inputs. They have no HTTP registration or award
route. Missing configuration fails closed. Configuration registration checks
the application's current owner against the frozen product owner. Writes lock
accounts in sorted order and recheck application ownership under a shared row
lock; ownership transfer does not silently rebind products.

Each source requires `providerAccountRef`, `mode: live` and
`environment: production`, with no defaults. These dimensions are persisted,
included in provider identity uniqueness and compared during replay/state update.
The internal normalized input is trusted input, not cryptographic proof or a
provider verification. A future adapter must verify the provider account, live
mode and environment before calling the writer. No such adapter is mounted.

Idempotency is anchored to the immutable `source.id` and `segment.id`; derived
grant IDs use the segment and benefit index. The adapter must preserve these IDs
when replaying the same normalized award decision. A different segment ID can
represent another segment for the same offer/period, and can therefore produce
additional grants, including additive quota under an explicitly configured
`sum` rule. This candidate does not deduplicate arbitrary provider invoices or
events, nor add a period uniqueness rule that could suppress legitimate upgrades.
Stable event-to-segment mapping is a required gate before provider activation.

Cancellation names a source and a product that the source actually supplies.
Other sources survive; a bundle source naturally supplies all its own products.
This is an internal state update, not a provider cancellation API. Revocation
names an individual grant/product and only reduces access.

## Authorized read and SDK

`GET /v1/products/:productId/access/:subjectAccountId` uses the shared auth
middleware and current uncached session/managed-account authority. The requested
subject must equal the effective session subject. The original operator of B
does not gain an implicit right to read A or C from that session. The route also
requires the existing `user:read` scope, live `account:read` permission, a usable
production application credential (shared `isCredentialUsable` predicate), and
the product's application matching the session audience. Development credentials,
expired active credentials and deprecated credentials without a grace expiry
fail; a valid rotation grace window remains usable.

Responses contain capabilities, quotas, conflicts and provenance IDs only; no
payer/provider/price/balance. They are `no-store`. Request validation returns 400;
missing or inconsistent product configuration returns 503. The new route and
strict Zod response envelope are registered in OpenAPI, regenerated to 354 paths /
409 operations and included in its payload completeness gate.

`oxy.billing.productAccess(query)` is an additive SDK method using the explicit
subject/product, an uncached request and strict response parsing. Existing billing
read semantics remain in place. This source has not been published. Shared
sessions without an application audience are denied: Console adoption needs an
existing authorized app-bound session or an explicitly approved audience mechanism;
the endpoint does not create a service-key exemption.

## Closure, mapping and remaining gates

The existing financial-hold query includes product sources in both payer and
beneficiary roles using the unchanged `LIVE_PRODUCT_PLAN_STATUSES` (active and
trialing). Closure rechecks under the same account row lock used by writers.
Either an award commits first and closure refuses, or closure commits first and
the award fails without writes. Terminal history is retained by `RESTRICT`; the
closure fence blocks reactivation and new awards.

This preserves the existing live-status predicate. `past_due`, `unpaid`, `paused`
and other nonterminal commercial statuses are not newly classified as closure
holds. Whether such states retain billable obligations is a pending activation
decision shared with I06; this work does not claim to resolve it.

The pure dry-run mapping requires explicit provider/account/mode/environment,
subscription/price and payer/beneficiary matches plus unique product and offer
definitions. Unmapped, ambiguous, duplicate definitions, incomplete configuration
and test environments remain distinguishable outcomes. It does not write rows,
award rights or infer a product from names or balances.

- [x] Versioned explicit configuration, normalized persistence and immutable provenance
- [x] Authorized persistent query, additive SDK source and generated OpenAPI
- [x] Local two-product, bundle/individual, distinct payer, human/bot and revocation fixtures
- [x] Local closure/retention and both forced PostgreSQL row-lock races
- [x] Read-only mapping rejects ambiguous and duplicate definitions without awards
- [ ] Approved commercial catalogue, Oxy One and overlap/credit policies
- [ ] Provider adapter verifies account/live environment and preserves event-to-segment identity
- [ ] Per-financial-grant credit/spend/refund ledger and I06 P1/P3 integration
- [ ] Historical mappings, real no-charge backfill and legacy-read parity/cutover
- [ ] Console/consumer adoption, coordinated publication and deployed verification

## Reproduction and evidence

Records and SHA-256 hashes are in
[`../evidence/i07-persistence-2026-10-02/records.json`](../evidence/i07-persistence-2026-10-02/records.json).
The environment was Bun 1.4.2, Node 24.21.0 and the owned disposable PostgreSQL 17
fixture on loopback port 5549. API Jest creates and drops a separate temporary test
database; no application writes target the maintenance database.

From `packages/api`, with `TEST_DATABASE_URL` pointing to that fixture:

```sh
bun run test --runInBand src/services/__tests__/productAccessPersistence.test.ts
bun run test --runInBand src/services/__tests__/productAccessClosure.test.ts
bun run test --runInBand src/services/__tests__/productAccessPersistence.test.ts src/services/__tests__/productAccessClosure.test.ts src/routes/__tests__/productAccess.test.ts src/services/__tests__/productAccess.test.ts src/services/__tests__/accountFinancialHolds.service.test.ts src/db/schema/__tests__/foreignKeys.test.ts src/db/schema/__tests__/schemaInvariants.test.ts
bun run test --runInBand src/routes/__tests__/productAccess.test.ts src/db/schema/__tests__/protectedColumns.test.ts
bun run test --runInBand src/routes/__tests__/productAccess.test.ts src/__tests__/openapiRouteWalker.test.ts src/__tests__/openapiZodConverter.test.ts
bunx tsc --noEmit
bun run build
bun run openapi:generate
```

Persistence 15/15; closure 4/4; seven-suite regression group 64/64; final authority
suite expanded to 8 cases plus 18 protected-column checks, 26/26. OpenAPI route /
converter group passed 40/40 before those two additive authority fixtures. These
counts overlap and must not be summed. The route fixtures stub only bearer
transport and rate limiting; sessions, credentials, managed RBAC and persisted
rights are real PostgreSQL rows. They do not prove browser SSO or deployed JWT
integration. SDK billing passed 7/7 from `packages/core` with
`bun run test --runInBand src/api/__tests__/billing.test.ts`.

Root snapshot sync, migration phase/journal order, OpenAPI freshness, tracked
no-flat-account-list/no-Mongo scans, scoped API ESLint and core Biome lint all
passed. Dependency builds and API compilation passed; the retained build excerpt
is explicitly only its last 30 lines, with the original log hash in the record.
Initial test fixtures needed a required credential name and a distinct segment
to reach the intended foreign-key violation; the base also needed the coordinated
I10 classifications above. Final tests use those corrections, with no skipped
assertions or new commercial defaults. None of these results establish production
adoption, provider idempotency beyond stable normalized identities, or a completed
I07 acceptance.
