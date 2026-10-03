# I03 approved freshness — local source checkpoint, 2026-10-03

Source: `94c7b390cbffc0fb6eecc3f293fb3e821c94f60f`, based on
`d6a34e2be0f52f5c95b7fd73030ab00aa7ae9139`. [proof.json](proof.json)
binds 27 source inputs, 11 records and 63 compiled core modules. No new DDL,
package versions, publication or production mutation is part of this checkpoint.

The source applies the approved D7 policy: durable grant/revoke epochs in their
write transactions; one repeatable-read authority snapshot; live subject/owner,
closure, app and credential/workload ceiling checks; `acting-as:offline` must
survive the live intersection. Both tiers use the same delegated and scope gates.
Effects make fresh requests; only explicit read callers cache authority (60s/10s).
Errors and malformed replies are not cached. Epoch plus local completion order
reject stale replies, including same-epoch denials. A lookup at least five seconds
old cannot authorize; this deadline alone does not measure revocation.

Both token verifiers require integer issuance/expiry and a positive lifetime at
most 300 seconds, including rejection of older signed hour tokens. The common
issuer produces 300 seconds. The SDK remints old cached hour tokens and expired
bounded tokens. The rollout plan in [SERVICE_TOKENS.md](../../SERVICE_TOKENS.md)
requires the new API revision steady and old issuer tasks retired before refreshing
old callers; caller refresh does not update an old receiver's internal bypass.

Validation at this source:

- Core build exit0; full own-package Jest: 174 suites / 2,144 tests PASS.
- API own-package Jest through the owned PostgreSQL17 runner: four suites / 95
  tests PASS, normal fresh migration138. PID3416042 verified by the runner and
  stopped afterwards. API ESLint and scoped core Biome exit0.
- Two independent Node processes load the built `@oxy.so/core/server` and call the
  real local HTTP authority route with genuine ephemeral signed service tokens.
  After a SQL revoke commits, both next fresh checks deny despite earlier cached
  positive reads: **16.323280ms locally**. This is one local sample, not production
  p99, receiver deployment or provider/domain effects. Only Redis rate limits are
  replaced for this HTTP fixture. The token getter uses the genuine test token.
- The barrier test holds the real grant table lock while a reader takes its
  initial epoch snapshot; a concurrent grant delete/epoch update then commits.
  The old read returns old grant/epoch together, and the next read denies at the
  new epoch. No mixed snapshot is admitted.
- SQL failure after grant/epoch work rolls everything back. Removing offline
  delegation from either live ceiling denies while user:read remains. Revoking
  an agent key after route precheck and before consent persistence leaves no
  grant/code, keeps the marker and leaves the epoch unchanged. The exact helper
  from I01 `efea04c2f` runs before the epoch; full code provenance/exchange awaits
  composition with I01.

`i03-core-red.log` records the initial six failing freshness cases. Their original
untracked harness was not archived at execution; do not call that log a frozen
source replay. The first regression logs identify old hour-token/cache/internal
fixtures intentionally updated to the approved policy. The final source and tests
are pinned independently in the proof.

API `bunx tsc --noEmit` retains one preexisting error: `accountEmail.mail.ts:105`
mentions `credentials_manage`, absent from the current built contracts purpose
union. This checkpoint does not hide it; rebuild/compose I01 contracts before the
combined type gate. There was no complete API suite run or green composite CI
claim here. I03 remains open for composition review, receiver adoption and its
production measurement/acceptance.

Reproduce from this source after the frozen workspace install:

```sh
cd packages/core
bun run build
bun run test --runInBand
cd ../..
python3 scripts/rehearsal/test-approved-api-1519.py src/services/__tests__/approvedActingAsEpochs.test.ts src/middleware/__tests__/serviceTokenEd25519.test.ts src/routes/__tests__/serviceActingAsVerify.test.ts src/routes/__tests__/oauthConsentFinalizers.test.ts
```

The runner accepts no DB override and scrubs inherited DB/libpq variables. Its
full command/process checks and scratch log path are retained in
`i03-api-exact.log`. `i03-core-loaded-dist.json` records the module realpath and
SHA256 inventory from Node resolution in `packages/api`, the worker's own cwd,
after the exact core build. The worker source itself is in the pinned SQL test.
