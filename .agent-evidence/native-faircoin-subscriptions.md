# Central FairCoin subscription acceptance

Oxy owns subscription offers, fiscal authority validation, source periods and grants.
Alia reads the official SDK and keeps only product credit consumption attribution.
An individual product offer and One bundle may coexist: the product's declared
maximum rule selects one allowance, never their sum.

## Contracts and configuration

`billing.productPlans`, `startProductPlanCheckout` and `renewProductSubscription`
are authenticated/core SDK contracts. The configured Accounts UI exposes checkout
and explicit next-period payment. Alia uses this same authority; native management
links to Accounts. Purchases are unavailable until the trusted runtime is configured.
No synthetic provider may enable production purchases.

`productBillingCatalogue.service.ts` accepts explicit `productPlans` with registered
individual offer/version/product, fixed monthly or annual USD gross price and existing source
bindings. The One offer remains USD 29.99 inclusive, no trial. The corresponding
runtime `offers` entry uses `kind: "existing_product"`, exact `amountMinorUnits`, plan
and provider-price reference. Annual amounts are explicit existing catalogue totals, never monthly × 12.

`peablePersonalRuntimeConfigurationSchema` validates the runtime file named by
`OXY_ONE_PEABLE_RUNTIME_FILE`: pinned Ed25519 invoice/tax public keys, exact owner
and namespace, explicit `purchasesEnabled`, reviewed seller/issuer/remitter IDs,
HTTPS checkout return URL and trusted customer-location evidence references. Secrets
remain private environment configuration. See the existing runtime bootstrap for
ApplicationCredential/public-key variables. The Peable integration guide describes
its watch-only merchant, native cohort and reviewed fiscal adapter configuration.

The commercial draft records Oxy as intended issuer and worldwide commercial
intent. The proposed company name is not independently verified. Tax identifier,
registration jurisdiction, reviewed country/rate/evidence configuration are missing.
`commercialActivation` and legal issuer `approved` remain false. The source does not
invent zero tax, a legal entity identifier, or enabled sale countries.

## Reproducible cross-repository test

Run from this worktree with isolated local PostgreSQL 17 available:

```sh
export TEST_DATABASE_URL=postgres://nate@127.0.0.1:55856/postgres
export PEABLE_NATIVE_FIXTURE_RUNNER=/home/nate/Oxy/Peable/.worktrees/confirmed-faircoin-subscriptions/packages/backend/src/__tests__/fixtures/nativeFaircoinLifecycleServer.ts
export ALIA_OXY_FIXTURE_SNAPSHOT_FILE=/home/nate/Oxy/Alia/.worktrees/confirmed-faircoin-subscriptions/.local-native-snapshots.json
bun run --filter @oxy.so/api test --runInBand --runTestsByPath src/services/__tests__/nativeFaircoinProduct.integration.test.ts
```

Then run from the Alia worktree with the same database and snapshot env variables:

```sh
bun run --filter @alia/api test:pg src/lib/__tests__/product-credit-allocations.pgdb.test.ts
```

The snapshot is an ephemeral test artifact generated from actual centrally verified
grants, not checked-in entitlement evidence. The first test starts real Peable HTTP
routes and its SDK, uses fresh isolated Postgres databases, creates unpaid checkouts,
feeds synthetic full-address/full-amount chain observations through SettlementWatcher,
verifies the signed authority, confirms each immutable invoice once, and explicitly
renews a period. Lost-reply retries reuse checkout; prepaid renewal retains current
access. Cancellation retains already-paid periods; bundle expiry retains renewed
individual access. Alia then admits credit reservations against the maximum source,
refuses extra summed allowance, and preserves prior reservations during renewal.

Repeat the cross-repository command with `PEABLE_NATIVE_ANNUAL_FIXTURE=1` and a
separate snapshot filename to exercise the existing Alia Pro USD 95.90 annual price.
The exact same flow pays a full year, produces twelve monthly quota windows, renews
the year with idempotent replay, and exposes only the active month. Run the Alia PG
command against that snapshot to verify monthly credit allocation without advance
spending. January 31 / February 29 calendar anchors are tested independently.

Results: monthly and annual cross-repository tests passed; Alia PostgreSQL allocation
suite 15 passed against each snapshot. Full-refund evidence revokes all twelve grants
of the annual financial segment; delayed paid replay cannot restore them.
No live economic transaction or external FX/chain acceptance was attempted. The public
Explorer returned HTTP 403 in this environment. Real provider access, fiscal business
configuration and externally observed chain settlement remain deployment prerequisites.
