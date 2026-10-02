# Coordinated SDK release candidate

The integration now combines SDK recovery/logout (#1551), internal MCP operation
keys and verified resource context (#1552), and Inbox's real PostgreSQL read
fixture. Candidate manifests and lock are committed in `b31d1f8d4`; no npm
package has been published and no product consumer manifest has been changed.

The [proof](proof.json) pins source, logs and six freshly built tarballs.
Contracts 4.9.0, protocol 1.2.2, core 4.2.0, services 11.1.0 and MCP 1.1.0 are
prospective versions. Telemetry remains 1.2.0. Protocol has only the mandatory
peer metadata change. Both lockfile checks pass; the lock delta changes no
resolved dependency versions. Descriptions and native dependencies are preserved.

Every package used `bun run build && bun pm pack` in its own directory.
Extracted manifests contain contracts `^4.9.0`, core's protocol `^1.2.2`, and
services' core dependency `4.2.0` plus peer `^4.2.0`. No workspace/catalog
specifier remains. All 3,401 installed files of the isolated six-package
consumer equal their tarball bytes. CJS and ESM MCP fixtures verify actual
signature/live authority, operation header, missing-key refusal, resource
boundary and revocation. Core package format checks pass.

The composed MCP package passes 9 suites / 49 tests. Final internal parity and
Inbox HTTP/handler/domain reads pass 2 suites / 5 tests on newly initialized
PostgreSQL 17, port 5567, PID 3144271. The harness verifies local PID, executable,
data directory and listening socket before creating a unique database and stops
its server. Inbox authority is synthetic; its read path and SQL are real. This
does not prove production consent, Mention receipts or three-transport parity.

API and scripts TypeScript checks pass. The isolated consumer passes Vite build
and strict TypeScript with `skipLibCheck: true`, including MCP's capability
principal and NativeWind preview.3 type reference. This is not validation of the
entire dependency declaration graph. Source and versioned packed browser runs
pass four OAuth/logout/state-mismatch scenarios with mocked network responses,
zero cookies, page errors and shared-device requests. Recovery/logout failures
are separately covered by the composed SDK's 6 suites / 95 tests in the
[SDK proof](../1519-sdk-p2-composite-2026-10-02/proof.json).

NativeWind's measured version is `5.0.0-preview.3`; the candidate range is
`>=5.0.0-preview.3 <6.0.0`. Services references its types, while styling uses
react-native-css. No other preview or native peer family is certified here.
The [release rationale](release-plan.md) and captured registry observation
distinguish unpublished candidates from actual versions.

Builds used `b31d1f8d4`. The later Inbox fixture and runner amendment change
tests/docs only; compiled package source and manifests still match those builds.
The final runner was tested while WIP and is now pinned by the proof's source
head. Full CI applies to the subsequently published integration head.

The INACTIVE Forge proposal freezes a different source tree. It cannot authorize
this changed integration or release. Final security review, release authorization
and product adoption remain separate; no merge, deployment or publication is
performed by this evidence.

The later [fixture delta](fixture-delta-proof.json) pins `f6cee376c`. CodeQL on
`a33c316ad` reported two duplicate alert pairs: loopback HTTP work without a
limiter and URL values interpolated into popup HTML. A constant synthetic
rate-limit key bounds all three parity endpoints before authentication/domain
work, without storing IPs. Popup HTML/script is literal; URL state is read as
data after navigation. A real popup regression sends a script terminator as
state, observes the exact literal message and proves no injected script runs.
Both popup branches and the four source/packed OAuth scenarios pass. Final API
parity plus Inbox still pass 2 suites / 5 tests on another verified, owned local
PostgreSQL server, which is stopped. API/scripts TS and scoped fixture lint pass.
Package runtime is identical to the preserved build source, so tarballs were
not repacked. External CodeQL and full CI must confirm the new draft head; the
historical statement of Audit-only failure applies specifically to CI/CD jobs,
not every external check.
