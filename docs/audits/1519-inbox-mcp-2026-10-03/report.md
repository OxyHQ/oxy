# Inbox external MCP / PostgreSQL evidence

Candidate source on base `5178fab5fc8e984ca722caee3567bfe4c9a1e441`.
Executed 2026-10-02 UTC / 2026-10-03 Europe/Bucharest, local PostgreSQL 17,
Bun package scripts, disposable per-worker databases. No production access.

The existing I06 PostgreSQL 17.11 server at `127.0.0.1:5549`
(`/tmp/oxy-i06-pg-20261002`) remains running; this subtask does not own its
lifecycle. The sanitized maintenance URL is
`postgres://oxy@127.0.0.1:5549/postgres` (local test role, no password).
`jest.globalSetup.ts` creates migrated `oxy_test_<16hex>` worker databases;
`jest.setupWorkerDatabase.cjs` routes the pool to one; the test closes its
HTTP server and SQL pool. `jest.globalTeardown.ts` drops the owned databases
and manifest through `dropTestDatabase`, which guards the exact name pattern.
The final test asserts/logs its disposable database name. After teardown,
a read-only `pg_database` query returned zero for that exact name; see
`database-cleanup.txt`. No other database or persistent server was removed.

## Source and gap

The Inbox frontend at `OxyHQ/Inbox@730850e5ab0992079ab23b6c1c30e9001ad76af7`
has no MCP producer. The real producer is in **Oxy**, at
`packages/api/src/capabilities/inbox-mcp-http.ts`, already present at
`72d41bf5c39cd635453440ce258177574dc1270e` (blob
`6aec4c887686ebc783b84c3175969d8317694ea5`). It authorizes the active account;
`inbox.handlers.ts` sends that account to the shared Inbox domain tools.

Existing tests isolate important parts of that chain:

| Suite | What it measures |
| --- | --- |
| `inbox-mcp-http` | Factory wiring, origin A / active B callback and resource lookup recovery; shared transport and authority mocked. |
| `inbox.handlers` | Active-account forwarding, idempotency projection and errors; domain tools and effect store mocked. |
| `inbox.tools` | Domain adapter semantics; email services mocked. |
| `inbox.contract` | Catalog-wide legacy HTTP and direct MCP handler result equivalence; domain and policy mocked, one account, no MCP HTTP server. |
| `mcpConnection.service` | Real PostgreSQL OAuth connection A→B. Revoking linked B removes B and falls back to A; this does not revoke origin A's token. |
| `mcpOAuth.service` | Real PostgreSQL token/resource binding and refresh replay revocation, independent of Inbox resources. |
| `emailService.messages` | Real SQL message lifecycle and ownership, independent of MCP authentication. |

The new `inbox-mcp-postgres.test.ts` connects the missing product chain:
real `createInboxMcpHttpService`, mounted before `express.json`, real HTTP MCP,
canonical Inbox MCP catalog, handlers, tools, email service, ownership predicates
and PostgreSQL rows. Two synthetic accounts each own a mailbox and message.

## Four executed cases

- Origin A / active B lists exactly B's message and reads B's body.
- Reading A's message while B is active yields an MCP tool error, without A's body.
- Listing A's mailbox while B is active yields an MCP tool error. A's SQL row
  remains present, proving ownership refusal rather than missing fixture data.
- After a successful read, the same token receives inactive introspection on
  the next HTTP call: status 401, no tool result and no B body; B's SQL row remains.

**Explicit synthetic authority boundary:** `resolveMcpResource` returns a test
application id; `introspectMcpAccessToken` returns claims with origin A plus an
active-B connection, then `null` for revocation. The opaque token is synthetic.
The test does not mint or verify a signature, obtain consent, revoke a stored
grant or exercise a real authority endpoint. The separate existing authority
suites above passed in the same validation batch, but are not composed with
this Inbox HTTP test.

Avatar, SMTP, push, assets and AI background boundaries are mocked. Every case
asserts zero global `fetch` calls and zero SMTP sends; only Node HTTP to the
local fixture server and local PostgreSQL are used. No send, financial effect,
DDL change, credentials, manifest/lockfile edit, runtime change or release.

## Validation and reproduction

From the repository root: `bun install --frozen-lockfile --minimum-release-age=0`.
From `packages/api`: `bun run build` (builds workspace dependencies in order),
then, with `TEST_DATABASE_URL=postgres://oxy@127.0.0.1:5549/postgres`:

```sh
bun run test --runInBand --runTestsByPath \
  src/capabilities/__tests__/inbox-mcp-postgres.test.ts \
  src/capabilities/__tests__/inbox-mcp-http.test.ts \
  src/capabilities/__tests__/inbox.handlers.test.ts \
  src/capabilities/__tests__/inbox.contract.test.ts \
  src/capabilities/__tests__/inbox.tools.test.ts \
  src/services/__tests__/mcpConnection.service.test.ts \
  src/services/__tests__/mcpOAuth.service.test.ts \
  src/services/__tests__/emailService.messages.test.ts
```

Eight suites / 104 tests passed. This batch preceded the final non-null cleanup,
exact list-length assertion, external-fetch tripwire and disposable-database guard/log. The final focal run
`bun run test --runInBand --runTestsByPath src/capabilities/__tests__/inbox-mcp-postgres.test.ts`
passed 1 suite / 4 tests with those refinements.

`bun x tsc --noEmit` passed for API source; the normal API config excludes tests.
To check the new test too, a temporary `packages/api/tsconfig.inbox-check.json`
contained the following, and `bun x tsc -p tsconfig.inbox-check.json` passed:

```json
{"extends":"./tsconfig.json","include":["src/capabilities/__tests__/inbox-mcp-postgres.test.ts","src/types/**/*"],"exclude":[],"compilerOptions":{"noEmit":true}}
```

The temporary config was removed after validation. `bun x eslint
src/capabilities/__tests__/inbox-mcp-postgres.test.ts` passed from `packages/api`.
From root, `bun x --minimum-release-age=0 @biomejs/biome lint --error-on-warnings
packages/api/src/capabilities/__tests__/inbox-mcp-postgres.test.ts` passed.
Exact commands, exit codes, source and log hashes are in `proof.json`.

## Acceptance limits

This completes only the bounded I11 external Inbox MCP/domain SQL fixture.
It does not establish three-transport parity, internal MCP adoption, effect
idempotency/ledger parity, live consent or live grant revocation through this
product path, deployed behavior, or adoption of a newly published package.
The test uses a locally built source candidate. I04/I11 and parent #1519 stay
open; publication, consumer adoption and full acceptance remain separate work.
