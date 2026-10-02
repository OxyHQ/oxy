# I05 internal MCP transport preparation

Source candidate on composite base `a33c316ad3fb17cb4d9eed5b78b4c3f7d58854a4`,
validated 2026-10-02 UTC on Linux, Bun 1.4.2, Node 24.21.0 and PostgreSQL 17.
The [manifest](evidence.json) pins inputs, logs, five tarballs, installed files
and the standalone consumer. Existing package version numbers identify local
candidates only; these bytes are not published or publishable releases.

`callTool` accepts a per-call operation key, validates the shared 1–255 character
contract and HTTP header syntax before network access, and sends it in a header.
The receiving transport enforces required keys only during tool execution,
before domain authorization/effects. Discovery remains available without a key.
`resolveResource` receives a verified capability principal, allowing account-root
products to derive the effective account without caller-supplied authority.

## Verification

- Initial real HTTP fixture against unchanged base: six failures out of six.
  The key was lost, missing keys entered domain code, and invalid keys attempted
  network access. Synthetic tickets in failure diagnostics are redacted here;
  the manifest retains hashes and paths of original local logs.
- Final MCP suite: nine suites / 49 tests pass. Raw HTTP rejects invalid keys;
  missing required keys never authorize/execute; `none` and `supported` retain
  optional keys; maximum-length keys work; calls/discovery do not inherit keys.
  Resource B remains distinct from requester/owner/actor A; resource disagreement,
  caller authority fields and revocation during domain awaits prevent effects.
- TypeScript and Biome lint with zero warnings pass; MCP builds and packs pass.
- API generic parity fixture: one suite / one test passes on owned PG17 loopback
  5557 with the real migrator and a disposable database. Catalog policy remains
  `required`; calls now supply existing operation identities. The fixture uses
  its own SQL ledger, not Mention's actual receipt service or product integration.
- Standalone tarball consumer: CJS and ESM pass signature/live authority,
  required operation key, missing-key, resource and revocation checks. Installed
  package realpaths resolve under the consumer, not workspace source.

The first compatibility fixture incorrectly combined `write` with `none`, which
the existing contract refuses. It was corrected to a read fixture for `none`;
the write fixture remains `supported`/`required`. The first API attempt stopped
before tests because the fresh worktree lacked the built `@oxy.so/db/migrate`
entrypoint; building that dependency resolved setup. Both first-attempt logs
are retained, and neither is presented as a runtime regression.

From this worktree, reproduce after frozen install:

```sh
bun install --frozen-lockfile --minimum-release-age=0
cd packages/contracts
bun run build && bun pm pack
cd ../protocol
bun run build && bun pm pack
cd ../telemetry
bun run build && bun pm pack
cd ../db
bun run build
cd ../core
bun run build && bun pm pack
cd ../mcp
bun run test --runInBand
bun run typescript
bun run lint
bun run build && bun pm pack
cd ../..
node packages/mcp/scripts/verify-internal-packed.mjs
```

For API parity, first validate the disposable server owner/executable/data
directory and listening socket against `pg-owner.json`, or provision your own
disposable PG17. Clear inherited `PG*`/database URL variables, then from
`packages/api` use your verified local maintenance URL:

```sh
TEST_DATABASE_URL=postgresql://oxy@127.0.0.1:5557/postgres NODE_ENV=test \
  bun run test --runInBand --runTestsByPath \
  src/services/__tests__/internalMcpParity.db.test.ts
```

## Limits

The new transport suite uses a simulated receipt set and effect observer; it
proves key propagation and separation of intentions, not durable Mention replay.
Live introspection is a controlled fixture. No consumer implementation,
manifests, DDL, credentials, publication, deployment, financial operation or
legacy route removal occurs here. I04/I05 remain open for coordinated release
and actual product parity. The [consumer preflight](../../architecture/i05-adoption-preflight.md)
identifies the next source and acceptance boundaries.
