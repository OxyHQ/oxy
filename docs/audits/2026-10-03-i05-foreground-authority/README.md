# I05 common present-requester authority checkpoint

Source `e12930eb49af4297b0fb74274b1baa08fb0eea21` adds the common
foreground read authorization, SDK method, canonical Oxy profile catalogue,
HTTP/MCP receiver and generated migration 0141. It does not configure the live
Mention application or claim pilot adoption. ADR 0034 records the boundaries.

`proof.json` binds 29 committed inputs, the executed logs, two rebuilt candidate
tarballs and the installed file census. PostgreSQL was freshly initialized by
the owned-process harness; PID/executable/data/socket ownership was checked
before database creation. Normal genesis applied 141 migrations; repeat added
no ledger rows. Both GREEN and mutated RED processes stopped in `finally`.
There was no production database or provider request.

The final API group passed 7 suites / 66 tests, including 16 foreground tests.
The tests execute real JWT and ticket signatures, SQL, service authentication,
registered catalogue, HTTP and common MCP handlers. Only AWS attestation and
Redis transport are fixture boundaries. They cover the inert canonical workload
attribution row, shared/app-bound sessions, a principal acting as an organization,
bot signer withdrawal, canonical session withdrawal/rotation/scope narrowing,
app/owner fences, catalogue changes, wrong actor/presenter/tool/signature,
private ranking under the verified `Application.id`, graph selectors and
absence of a service-header impersonation shortcut. Deleting a session denies
reads while keeping its historical authorization row.

The controlled audit barrier checks withdrawal and expiry after the last I/O.
Removing only that final recheck fails those two tests; the same final harness
and committed inputs pass with the original bytes. An audit row is not proof
that a result was released. The earlier single-suite mutant is superseded here
by the final identical harness and input comparison. The immutable fixture
clock controls an expiry boundary without a timing inference.

Separate package commands passed contracts 11 tests, core 3 suites / 14 tests
and MCP 9 suites / 49 tests. API and scripts strict TypeScript passed. Biome
1.9.4 reports zero on the 12 scoped files; the eight shared files retain the
exact category/description multiset of their parent diagnostics. This is not
a claim of repository-wide zero lint. Migration phase/journal/snapshot and
payload guards pass; a second generate emits nothing (223 tables). OpenAPI is
fresh (367 paths / 422 operations); 37 positive and negative guard fixtures
include the new requester body, signed graph and optional ranking filters.

Contracts and core were built and packed with Bun from this source. The
installed candidate consumer executes ESM and CJS against bounded synthetic
loopback transport, preserving independent service proof and requester proof
only in the Oxy request body. Malformed proof or free identity is refused before
HTTP. All 779 installed files match those two archives. Its strict TypeScript
consumer uses `skipLibCheck`; it does not validate every dependency declaration.
The transport fixture does not authenticate a remote presenter; the API group
above demonstrates actual authority separately. Prior unchanged protocol and
telemetry candidate archives are explicit file dependencies in its manifest.

## Reproduce

From this worktree:

```sh
python3 scripts/rehearsal/test-i05-foreground-authority.py
bun --no-env-file scripts/check-no-payload-persistence.mjs
node scripts/check-migration-phases.mjs
node scripts/check-migration-journal-order.mjs
node scripts/check-drizzle-snapshot-sync.mjs
node scripts/check-openapi-fresh.mjs
node scripts/test-check-openapi-fresh.mjs
```

Package tests use each package's own `bun run test`. Tarballs remain candidates
identified by SHA, not a registry publication. Live registration, Mention
compare-and-set permissions, consumer pilot parity and adoption of the published
SDK remain separate required work. No offline grants were synthesized and
Inbox's catalogue and legacy HTTP/session routes were not replaced.
