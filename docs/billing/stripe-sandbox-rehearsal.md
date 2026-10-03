# Oxy subscription sandbox rehearsal (I06 / I07)

This is a reviewable runner, not a report that Stripe tests have passed. No
provider object has been created during preparation. Execute only after source
review, and prepare a new plan against the final composed source head first.

The only account is `acct_1TnXkUQWiCE02OnU`, selected using the existing local
Mercaria **test** key. The child reads only that named key into memory, rejects
`sk_live`, and verifies `GET /account` before any mutation. It does not load the
other Mercaria environment variables. No token or key enters a command line,
plan, manifest, proof, or ordinary output.

```bash
python3 scripts/billing/stripe-oxy-sandbox.py --prepare
# After review of the plan/source; the path is returned by prepare:
python3 scripts/billing/stripe-oxy-sandbox.py --execute /absolute/path/to/plan.json
```

The reviewed plan fixes account, namespace `test:test`, source hashes and head,
USD, four subscriptions, and a maximum of 50,000 synthetic paid minor units.
It expires after 24 hours. There is no account, URL, key, database or budget
override. Expired plans, unknown fields and altered source inputs fail before
the child starts. Network waits have bounded deadlines. The script uses the
installed Stripe 20.4.1 SDK and default official API endpoint.

The runner starts a fresh PostgreSQL 17 process on literal `127.0.0.1:5594`.
It validates executable, owner, PID, data directory, creation time and the port
owner before `CREATE DATABASE`. Only that new empty random database receives
the persisted `oxy.billing_namespace=test:test` database declaration. The child
checks ownership again and compares the server system identifier, database and
namespace. Inherited libpq, database, provider and AWS variables are scrubbed.
The normal migration command runs after a build of the pinned workspace inputs.
PostgreSQL is stopped in `finally`; there is no production SQL connection.

The test clock, customer, payment method (`tok_visa`), products, prices,
subscriptions, coupon and refunds belong to this nonce. These fixture prices
are test-only: the two API credit plans retain the existing 2,999/9,999 USD
minor-unit amounts and 10,000/50,000-credit counts. The 199/99 product prices
are explicitly synthetic test fixtures, not approved commercial offers or a
new Oxy One launch. Product configuration uses two products, individual and
bundle offers, `maximum` for the typed quota and an explicit beneficiary
different from the payer.

The real route and SQL code are exercised for:

- Paid initial combined access/credit award, with one evidence/segment and
  one credit grant after repeated delivery.
- Tracked FIFO spend with the same stable operation ID replayed.
- A real provider mid-period upgrade and P1 credit proration. The assertion
  uses an independent integer calculation from the retrieved period and line.
- Partial followed by 100% refund of the base charge. Replayed and reordered
  cumulative snapshots cannot claw back consumed credits or another grant.
- A subsequent paid period and an old invoice replay after renewal. The test
  clock creates the next real invoice; that owned invoice is explicitly
  finalized/paid so the account's webhook delay settings do not control the
  test. This does not certify an automatic production scheduler.
- Bundle plus individual product sources, named cancellation through real
  bearer authentication, a real subscription update and an older creation
  event replay. The other source, beneficiary quota and credits are preserved.
- A 100%-discounted invoice without a declared promotion: zero credit grants.
  The production promotion registry remains empty. Existing positive policy
  fixtures are separate evidence; this script does not activate a promotion.

**Delivery provenance matters.** Events are selected and re-read over Stripe's
authenticated Events API, restricted to this run's test object IDs. The local
receiver uses Stripe's real signature verifier, but its request signature is
generated with a fresh local fixture secret. This is evidence of authenticated
provider data through the real receiver and SQL, **not evidence of a delivery
signed and transmitted by Stripe to a public endpoint**. No webhook endpoint,
Portal setting or provider account configuration is changed.

Each create intent and stable idempotency key is persisted before the request.
Each returned ID is persisted before shape checks. Cleanup begins before the
first creation, confirms the nonce/mode on every existing object, and attempts
every object even if a preceding cleanup fails. Subscriptions are canceled,
payment methods detached, the customer/coupon/clock deleted, and prices/products
archived, with remote response/readback checks. Refunded/paid invoice history is
not deletable and remains explicitly identified test history. A request that
fails before returning an ID remains an unresolved creation intent; it cannot
be reported as cleaned or accepted. The launcher receives SIGINT/SIGTERM, forwards
it once to the child's separate process group and waits for cleanup before
stopping its owned PostgreSQL. Repeated signals do not skip cleanup. A fixed
900-second cleanup deadline bounds an unresponsive child; a forced termination
is recorded as requiring manifest review, never as complete provider cleanup.
PostgreSQL is also required to live outside the launcher process group.
A hard kill or network loss can still require manual reconciliation
using the private intent/nonce manifest; no claim of crash-proof remote cleanup
is made.

Private artifacts live under
`/home/nate/Oxy/.agent-evidence/integration-stripe-1519-20261003/<nonce>` with
directory mode 0700 and manifest/log mode 0600. Public acceptance evidence must
be derived from the counts, source/record hashes, provider readbacks and cleanup
outcomes, not by committing the database directory or raw event/account data.
Acceptance against the final Oxy candidate and actual Stripe execution remains
pending until the reviewed plan is executed and its records are checked.

### First provider attempt and loader correction

The first attempt at source `f0bd1409c` stopped before creating any
subscription or invoice: the Bun source runner imported `billing.js`, which does
not exist beside `billing.ts`. It created 11 owned fixture objects (clock,
customer, payment method, four products and four prices). All 11 cleanup
operations and their readbacks succeeded, and PostgreSQL PID 3538383 stopped.
There were zero completed billing assertions and zero observed paid minor units.
This attempt does not establish real Stripe billing acceptance.

The runner now exports one source loader for `billing.ts`; both the rehearsal
and its offline bootstrap use that loader. The launcher executes the bootstrap
with no database URL or provider credentials before starting the network-capable
child. The runtime import remains after fixture price configuration because the
route reads that configuration at module initialization. A retry requires a
new frozen plan, nonce, owned database and reviewed source; it never resumes the
first attempt or reuses its remote objects.

### Bun environment and crypto isolation

All direct Bun invocations disable dotenv autoload with `--no-env-file`.
The scrubbed environment fixes `BUN_OPTIONS=--no-env-file` so the actual
workspace builder and further Bun package-script descendants retain the same
boundary. An isolated fixture with harmless dotenv sentinels verifies bootstrap,
migration/child command forms, the actual shared builder and nested Bun scripts;
it does not modify ignored dotenv files in this checkout.

Bootstrap now reports measured presence/absence of credential and database
*environment variables* after the actual loader import. Its older `keyRead:false`
and `remoteRequests:0` literals were declarations, not instrumented counters.
The source loader is exercised without invoking the runner main function; this
check does not independently count network side effects.

The Node/Bun receiver uses the official asynchronous Stripe verification API
with an explicit SubtleCryptoProvider, preserving default timestamp tolerance.
Generated request signatures still belong to the local fixture, not Stripe's
public delivery infrastructure. Earlier loader/crypto failures remain recorded;
no test failure is described as a completed sandbox billing cycle.
