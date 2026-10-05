# Local Oxy One lifecycle fixture

Use the isolated Oxy and Peable draft checkouts with installed dependencies and Bun. Build Peable shared-types and SDK first. The product manifest remains pinned to its public SDK; this fixture exercises the updated SDK in a separate Peable process and communicates normalized observations to Oxy over a local test protocol.

From Peable:

```sh
cd packages/shared-types
bun run build
cd ../sdk
bun run build
```

From Oxy `packages/api`, supply explicit local PostgreSQL URLs and the absolute path to the fixture in your Peable checkout:

```sh
DATABASE_URL=postgres://oxy:oxy@127.0.0.1:5432/oxy_dev \
TEST_DATABASE_URL=postgres://oxy:oxy@127.0.0.1:5432/oxy_dev \
PEABLE_ONE_FIXTURE_RUNNER=/absolute/Peable/packages/backend/src/__tests__/fixtures/oxyOneLifecycleServer.ts \
bun run test --runInBand peablePersonalLifecycle.integration.test.ts
```

Both fixture processes refuse non-loopback database hosts; the Peable runner additionally refuses external fetches. Peable creates, fully migrates through its real phase-aware entrypoint, and drops a throwaway database. Oxy uses its repository's configured local test connection. No real keys, seller/tax facts, rates, provider prices or payments are required or created. Actual SDK HTTP and scoped routes run with synthetic service authentication/downstream responses. Test tax figures and future periods are fixtures, not approved provider acceptance or a Faircoin renewal mandate.

The test requires the runner flag; otherwise it is explicitly skipped. It covers checkout correlation, duplicate paid activation, account isolation, signed observation/replay, cancellation/paid-period retention, completed refund/individual coexistence, delayed events, a second paid month and expiry. The inactive handler has no mounted route; the relay has no boot worker. See launch readiness for migration, release, commercial and operational gates.
