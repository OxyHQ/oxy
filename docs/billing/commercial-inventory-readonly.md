# I06/I07 commercial inventory: read-only execution plan

This inventory compares the existing Oxy, Clarity and Mercaria catalogues/subscriptions before any backfill. It does not award rights, reconstruct historical credit balances, move payments to Peable, or infer an Oxy One composition. Preparation uses authenticated AWS metadata only; execution waits for root's review of the concrete plan.

## Current pinned services

Region `us-west-2`, account `237343248947`, cluster `oxy-cluster`:

| Profile | Service | Task definition | Image digest | DB reference | Execution role |
| --- | --- | --- | --- | --- | --- |
| Oxy | oxy-api | oxy-oxy-api:691 | 29502ab56460ed8261b5dd747d93fd36e345f28e633a17c865c34d4fae7b653a | /oxy/oxy-api/DATABASE_URL | oxy-ecs-execution |
| Clarity | clarity-api | oxy-clarity-api:44 | 3e9d5cc075c78344a3cc8998b8cb7a3e86f63114681471354064de92d8b24a5a | /oxy/clarity/DATABASE_URL | oxy-clarity-execution |
| Mercaria | mercaria | oxy-mercaria:59 | f5a2aed5580b3b3561bdff88a9da7fed5335816ff442052f75b140d177847412 | /oxy/mercaria/DATABASE_URL | oxy-ecs-execution |

Preparation and execution revalidate the stable PRIMARY deployment, running task count/revision and actual runtime image digest. The network is copied exactly from the service: subnets `subnet-09be52663c9affaea`/`subnet-0f338d0c3f0497225`, security group `sg-0f0ca416eacab578c`, public IP disabled. No network/IAM change is requested.

Each ephemeral task has one inventory container, the pinned live image and the existing execution role. It has no task role, sidecars, environment entries, ports, health check, mounted volumes or server command. Only its exact existing DATABASE_URL SSM reference is bound. The default entrypoint is bypassed with `/usr/local/bin/node --input-type=module -e <fixed reader and invocation>`. Node exists in all three runtime Dockerfiles; Mercaria's runtime does not install Bun. `createRequire` resolves postgres from `/app/packages/api/package.json` or `/app/packages/backend/package.json`, and the result records the actual Node/postgres version and resolved entrypoint hash. No application/server/migrator module is imported.

The launcher checks returned registration and authenticated definition readback against the intended executable bytes and authority. Only empty AWS defaults are normalized. Execution checks both launcher and reader SHA256, the exact prepared definition hash and a one-hour preparation window. A changed live deployment, source or plan rejects before dispatch.

## Query projection

The fixed map in `scripts/billing/read-commercial-inventory.mjs` is the entire SQL surface. It first uses `to_regclass` and column census. Missing tables or columns are discrepancies with count `null`, never reported as zero. Counts and rows come from one `REPEATABLE READ READ ONLY` transaction, verified by PostgreSQL; statement/lock/idle timeouts are fixed. A table above 1,000 relevant rows reports its exact count and `row_limit`, without presenting truncated rows as complete. Total projection is capped at 1 MiB.

- Oxy: Stripe subscription mirrors, legacy subscriptions, paid/customer-linked API-credit balances, financial receipt references, and any deployed product catalogue/source/segment/grant and credit-grant tables. Account handles, emails, display names, descriptions, tokens and raw event JSON are excluded.
- Clarity: local product subscription/customer IDs, paid periods and only product/currency/price/credit allowance keys from plan snapshots. Raw JSON is never emitted. Local subscription is not reinterpreted as Alia's credit balance.
- Mercaria: versioned merchant plans/prices/entitlements, billing customers and merchant subscriptions, plus only owner membership IDs for stores that have a subscription. Store/customer names, addresses and emails are excluded. Connect accounts are not billing customers.

Financial/account IDs are needed for an exact private comparison. The raw projection stays in a local `0700` directory with `0600` files; public evidence will contain counts and redacted discrepancies, not these rows. The result is split into bounded nonce/sequence/hash packets in the dedicated task log stream. The collector rejects conflicting/duplicate packets and verifies full bytes; only incomplete log delivery is retried. No arbitrary SQL, connection-string or secret-value override is accepted by the launcher.

Metadata shows no Stripe binding in Oxy/Clarity, and a Stripe secret reference in Mercaria. This does not prove those databases empty or authenticate a processor account/mode. SQL-only inventory needs no Stripe key. Any later GET-only verification must establish the actual provider account/mode independently; a local test key is not evidence of the live namespace.

## Commands and cleanup

Preparation (read-only AWS metadata, private plan):

```sh
python3 scripts/billing/commercial-inventory-ecs.py oxy --plan /private/new-oxy-plan.json
```

Only after the concrete plan review, execute the same profile/plan into a new private directory:

```sh
python3 scripts/billing/commercial-inventory-ecs.py oxy --plan /private/new-oxy-plan.json --execute --output /private/new-oxy-result
```

Repeat profiles `clarity`/`mercaria` independently. The dispatcher requires STOPPED, exit zero, exact task revision and image digest before accepting output. It re-reads the registered executable before launch. A failed or timed-out task is stopped; the ephemeral task definition is deregistered, and STOPPED/INACTIVE readbacks are recorded even after output validation failure. It does not update any service, alter secrets or publish an image.

Local verification: `python3 scripts/rehearsal/test-commercial-inventory-1519.py` creates its own validated PostgreSQL 17 process, then executes seven SQL/receiver controls (read-only, privacy projection, missing/schema mismatch, row bound and exact Node receiver). `python3 scripts/billing/test-commercial-inventory-ecs.py` tests definition defaults, ten authority/executable deltas, reader/launcher pins and packet identity/digest/duplication controls without AWS access. These fixtures are not live inventory acceptance.

## Comparison and backfill boundary

A complete private read must identify existing sources, actual plan/price versions, provider identities and unique payer/beneficiary mapping. Unknown provider namespace, missing product mapping, incompatible duplicates or incomplete projections remain named discrepancies and retain the existing legacy adapter. No mapping is inferred from a plan name or current price. Configured unambiguous candidates must compare old and new rights with provenance before any idempotent access-only backfill; monthly historical balances are preserved, never recomputed. Actual row counts/results and that comparison remain pending until this read-only execution and review complete.

### Existing image compatibility and logging pins

The Oxy reader supports one explicit pre-ledger `billing_transactions` profile:
`oxy_pre_subscription_credit_ledger`, selected only when `stripe_invoice_id` is the
sole absent required column. It reads every other whitelisted field/count and
reports `schemaProfile` plus `unavailableColumns`. Rows omit the unavailable
invoice identifier; they do not invent a null provider invoice, a mapping or an
empty table. Any other missing field still returns `schema_mismatch` with a null
count. The modern schema keeps its complete original projection.

The task's CloudWatch stream prefix is inherited from the authenticated live
container, included in prepared/execute pins, copied into the minimal receiver
and used for collection. No IAM policy is changed. The original Clarity attempt
used `billing-inventory`, which its existing execution role rejected before the
container/SQL started; its task and temporary definition were cleaned up. A new
plan uses the live `clarity-api` prefix. This operational retry is distinct from
an empty database result.
