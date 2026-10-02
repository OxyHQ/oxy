# Identity and authority correction evidence · 2026-10-02

Candidate for I01/I02/I03 under #1519. Foundation is the local composition of
#1530 `ca69120daaf0c9ed0a461deeaf9d00a50aa17e2f` and #1532
`6802ed15cdf088a376df964baeb0f72226c395ff`, integration commit
`7040a69805d06dc3b59d740d83b4beb848fdbe36`. This is not the final composition of
billing/inference/MCP work and is not approved for deployment.

## What is corrected

OAuth direct authorization and both bearer AuthSession approvals retain the
verified operator. An operated approval stores the actual approver separately
from the effective account using existing columns. Finalization and token
exchange check the operator's live `account:act_as` membership. A represented
bot remains represented; this change does not authenticate the bot autonomously.

Remote session validation now reads the database row and managed membership
with the existing `useCache:false` authority-decision option. Its cost is a
live row lookup per validation rather than accepting the local five-minute
row cache. This is a correction to authority validation, not a measured
performance claim or a new normal-session freshness policy.

Successful HTTP acting-as denials use the existing 60-second denial TTL,
matching the existing failed-lookup path. The accidental five-minute denial
TTL is removed. Positive grant TTL and error TTL are unchanged; new 10-second,
60-second or five-minute guarantees are not approved by this correction.

## Executed evidence and limits

Tests run in the isolated identity worktree on Linux, using the newly created
local Postgres17 at `127.0.0.1:5549`. API global setup creates/drops separate
random test databases. No production connection, funds or credentials are used.

| Command | Evidence |
| --- | --- |
| API `bun run test --runInBand operatedApprovalKeepsOperator` | 23 passed. Real auth middleware, bearer, stored authorization code and form-encoded PKCE exchange. Three OAuth entries × organization/bot. Live membership rejection before approval/finalize/exchange and after session mint; validate/refresh deny, code replay creates no session; approver row disappearance fails closed. |
| Same tests with foundation's auth route and AuthSession service | 13 failed / 10 passed; own files restored with byte verification. |
| API `bun run test --runInBand authorityValidationProcesses` | 3 passed. Two independent Bun processes each own the real session service, local cache and pool. Both caches are hot, one process revokes a row or membership, the other's controller denies without clock advancement or invalidation. Only the listener/socket server module is stubbed. |
| Same process tests with foundation's controller | 3 failed: stale process responds 200; own controller restored with byte verification. |
| API `bun run test --runInBand oauthConsentFinalizers` | 34 passed, including first-party/third-party × explicit/empty × first consent/revoked and both finalizers. Empty request behavior remains a decision; the test records its current asynchrony, not approval. |
| API targeted OAuth/controller selection | 10 suites / 238 passed before adding the eight consent characterization cases. |
| Core `bun run test --runInBand` | 170 suites / 2,105 passed; denial-to-grant clock and app/account isolation included. |
| Core `bun run lint` | Biome error-on-warnings clean. |
| `bun run build:all` | 19/19 passed before final fixtures/docs. API build later passed; final strict typecheck is required at the submitted head. |
| `bun run validate:agents-md` | Budget and self-tests passed. |

The unsharded whole API run exceeded Node heap limits. It also observed an
inference ledger reserved-balance fixture failure and a token fixture missing
live membership. The latter is corrected; the ledger finding is delegated to
I09. Six API shards are being run with the repository's own worker ceiling;
this document does not claim a complete green API until final results are
attached to the draft PR.

These tests prove authority reads in independent processes, not production
latency, a full deployed HTTP load profile, event delivery/ordering, epochs,
service-credential revocation, internal header authorization, or bot-own-key
parity. I01 D1–D7, I02 empty consent and I03 policy remain open. I04 has a
separate implementation blueprint; no publication or consumer migration occurs.
