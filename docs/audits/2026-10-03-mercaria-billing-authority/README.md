# Prepared Mercaria billing authority

Source3201f6f4ccd792aa78fff1a4897e8464f677e994, base2d1072329. No production write,
CLI invocation, token mint or cohort activation executed. Root review and exact
live readback/plan are still required.

Validation: API package `bun run test --runInBand
src/services/__tests__/mercariaBillingAuthority.db.test.ts`, final12/12 PASS.
PostgreSQL17 own instance127.0.0.1:5575/roleoxy_i08_mercaria; repository harness
creates/migrates/drops oxy_test_* databases. Empty teardown query verifies none
remain; persistent local server is ours, not stopped. First attempt8 failures
were fixture construction mistakes (wrong seed export, missing credential name),
not product RED. Corrected8/8, then12/12 with negative environment/expiry/inheritance.

API+scripts strict TypeScript passed with package-local tsc after dependencies
built/restored by Turbo (8 cache hits); initial types.log records missing built
workspace modules. Root-level bun x --no-install biome found no executable and
produced no validation; authoritative Biome uses packages/contracts/node_modules/.bin/biome
(3files,0diagnostics). ESLint scoped3sourcefiles max-warnings0 passed; scripts
are excluded by existing ESLint config and instead covered by strictTS+Biome.
No full API suite claim.

Tests cover read-only prepare, untouched fields/other credentials, apply+rollback,
concurrent CAS, ABA including restored timestamp, rollback drift, revoked/closed/
wrongowner/nonstaff/wrongkind, unsupported namespace/expiry/empty/partial scopes,
and actual second-write SQL constraint failure rolling back the first write.
CLI's STS/filesystem/production-target wrapper is source-reviewed only, not an
executed production command. The internal actor flag is a trusted operator seam,
not customer authentication or an HTTP API.
