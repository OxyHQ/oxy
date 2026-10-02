# I07 inactive provider evidence mapping

Issue [#1525](https://github.com/OxyHQ/oxy/issues/1525), parent
[#1519](https://github.com/OxyHQ/oxy/issues/1519). Source pin and all input/log
hashes are in [proof.json](proof.json). This adds an unmounted internal wrapper;
it does not register a catalogue, activate provider callbacks, award financial
credits, migrate balances, publish packages or deploy.

`recordProductProviderPeriod` accepts an explicitly bound provider account,
`live`/`production`, an existing registered offer and one normalized paid
recurring invoice line with quantity exactly one. Its strict schemas whitelist
the projection. No raw event body is accepted or persisted. This trusted input
is not authentication of the remote provider, verification that an invoice was
paid or proof that a price belongs to the intended commercial catalogue. A future
adapter must establish those facts before activation.

The source ID derives only from provider/account/mode/environment/subscription.
Segment and evidence IDs derive only from provider/account/mode/environment and
invoice/line. Parties, price, offer/version/origin and period are frozen compared
values, never deduplication namespaces. No caller source, segment or namespace
ID is accepted. The period uniqueness constraint contains only financial
identity; the event primary key contains only provider binding and event ID.
Different delivery IDs for one line recover the same stored IDs. Reusing an
event for incompatible evidence fails. Distinct explicitly bound provider
accounts are legitimate distinct namespaces; the fixture tests this positive
case without treating arbitrary caller input as remote verification.

Two new tables retain normalized period and delivery evidence. Composite foreign
keys bind the period to the exact source parties/provider and exact segment
offer/origin/period; delivery links to the same source and provider binding.
UPDATE/DELETE triggers make both records immutable. SQL tests check the actual
check-violation and foreign-key-violation classes, so a restrictive FK alone
cannot masquerade as an immutable DELETE guard.

The wrapper calls the unchanged low-level writer in its own transaction. That
writer takes sorted account locks, application locks, then the source lock;
evidence/event locks come afterward. There is no provider/network call under
SQL locks. Source, segment, grants, period evidence and delivery commit together
or all roll back. Tests cover event collisions after a new source/parties and
invoice have been provisionally written, as well as an injected delivery INSERT
failure and successful retry.

## Evidence and limits

The first diagnostic used the existing low-level writer with a different
segment ID and observed additive quota **10 → 20**. That writer legitimately
supports multiple explicitly supplied segments. This demonstrated the missing
provider-to-stable-ID mapping requirement; it is not a defect of the raw writer
and not a frozen adapter RED → GREEN comparison. The diagnostic ran as WIP on
the recorded foundation and its raw transcript is retained separately.

The final tracked source passes **7 suites / 77 tests**, including **13 wrapper
cases**: same-event and distinct-event concurrent replay; immutable paid-line
attribution; forbidden caller IDs/raw fields/test or staging bindings; explicit
distinct provider-account namespaces; missing configuration; transactional
failure/retry; renewal; named cancellation preserving another source; SQL guards
and forged FK bindings. Existing product access, closure, authorization and FK
tests remain in the group. API and scripts TypeScript pass; scoped Biome lint
passes for four new files.

Renewal has a deliberate seam: the existing named-source update commits first,
then the wrapper records the new paid period in a separate transaction.
**Only award/evidence/delivery are atomic; the complete renewal is two commits.**
The fixture proves a failed award leaves the committed source transition intact,
retry recovers the new period without duplicates, and old invoice replay does
not rewind current source state. Full renewal transition/award atomicity and a
verified provider adapter remain activation gates. The existing source updater,
raw writer, cancellation rules and overlap policy were not changed.

The harness starts a fresh local PostgreSQL 17, verifies PID/UID/executable,
data directory and listening socket before CREATE, scrubs libpq overrides, and
accepts no connection override. The normal migrator applies all **136 journal
entries**, including generated **0136**, then an unchanged repeat has no work.
Jest independently uses its normal throwaway database setup. The owned server is
stopped in `finally`. This is no populated production upgrade proof.

Drizzle generated the 217-table snapshot and journal. Its first SQL order placed
FKs before two newly added parent UNIQUE constraints, failing before tests. Only
those two generated statements were moved ahead of the FKs; their contents were
not edited. Seven generated statements plus the two exact source trigger
statements match the executable SQL statement multiset. The original generated
SQL and comparison record are retained. A second generation emits no change;
SQL, snapshot and journal hashes remain identical. Payload, migration-phase and
journal guards and their fixture suites pass. Four exact payload declarations
describe only the normalized whitelist and its SHA-256 hashes.

Reproduce from the source pin with built workspace dependencies:

```bash
python3 scripts/rehearsal/test-product-provider-evidence-1519.py
bun scripts/check-no-payload-persistence.mjs
bun scripts/check-migration-phases.mjs
bun scripts/check-migration-journal-order.mjs
```

The separate draft targets the integration branch; its feature checks do not
substitute for full CI on the main-target composed PR. I07 remains open for
commercial configuration, verified adapters, Console, financial ledger,
backfill, activation and its complete acceptance criteria.
