# Published product SDK composition

The existing `scaffold-smoke` workflow runs this isolated consumer after building
and packing platform HEAD. It runs on relevant pull requests, nightly and manual
smokes. The required CI apps job runs the same check on merge-group/push trees,
so the exact queued source must pass before publication. It does not publish
packages or call production services.

`packages/core/scripts/test-product-sdk-composition.mjs` copies this fixture into
a **new directory outside the checkout**, installs the real published product
SDKs and substitutes only the six platform packages being tested with their
built tarballs. It refuses an existing directory, verifies installed files against
those tarballs and checks that every product's declared platform dependency/peer
range still admits the packed version. An override cannot silently bypass a
product's major-version compatibility boundary.

The fixture's explicit registry pins are consumer inputs, not workspace catalog
entries. Update them in reviewed dependency changes; a new product SDK version
must pass this same smoke. SDK maintainers update these product pins when
adopting a new published factory contract. The root Dependabot Bun job targets
the monorepo lockfile; this isolated fixture is not a workspace, so do not assume
that job updates its pins automatically. Platform HEAD may be unpublished, which is why the
pre-merge check uses tarballs instead of forcing a premature release. The existing
scaffold registry-range and release artifact inspectors remain in place.

Six real loopback-HTTP tests exercise:

- Core workload v2 cache/401 refresh, with explicit customer credentials still
  using their external scoped request even when a workload provider is configured;
- published Alia/Clarity factories and recipient audiences, immutable requester
  headers, foreign-origin and redirect refusal;
- published Kaana attribution and the MCP platform transport;
- a real Kaana SSE frame, canonical workload audience and cancellation that closes
  the upstream response without replay;
- linked session bearer/disposal/origin behavior;
- published Alia session JSON POST replay after one401 and rejection of a pending
  response after switching the Oxy account.

Only Alia's renderer hooks are mocked so its published pure HTTP transport can
run without mounting React. Core authentication/HTTP code and product factories
are actual installed packages. The issuer and resource servers are synthetic:
these tests do **not** verify signatures, live grants/revocation, production or
native UI acceptance. Existing API/core authority tests cover those boundaries.
Typechecking and both Node CJS/ESM imports run after the HTTP tests.

For a local run, build and pack `contracts`, `protocol`, `telemetry`, `core`,
`services` and `mcp` into a fresh directory using their package build commands
and `bun pm pack`, then:

```sh
node packages/core/scripts/test-product-sdk-composition.mjs /absolute/packed /absolute/new-consumer
```

Inside the prepared consumer, its package-owned commands are `bun run test` and
`bun run typecheck`. It uses Vitest under Node rather than the monorepo's Jest
source aliases, so passing proves the installed tarball composition.
