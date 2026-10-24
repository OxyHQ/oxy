# Zod parser security boundary

The first-party schemas retain the Zod4 validation and wire semantics introduced
with contracts6/core7. They now import `@oxy.so/zod4`, a transparent maintained
source build of upstream4.6.7 that also fixes its embedded `/v3` parser.
Third-party dependencies that require Zod3 resolve the same-major
`@oxy.so/zod3` source backport. Neither generation relies on an audit waiver.

Both forks reject oversized size-constrained collections before traversing their
elements. They preserve ordinary input, transformations, lower bounds, custom
errors and advertised CJS/ESM/source exports. Unconstrained collections do not
acquire an implicit limit. Source archives, integrity, upstream commits, MIT
attribution and complete patches live in `packages/zod3` and `packages/zod4`.

CI compiles the pinned source, verifies every parser export, proves upstream
negative controls and detects mutations that restore vulnerable code. It scans
all physical installed copies, including embeddedv3 paths and aliased packages.
The ordinary dependency audit remains active. Published MCP consumers are tested
with both npm and Bun without monorepo overrides. Any future parser version or
export change must pass these source and artifact checks.

## Independent linked-account transport budgets

The existing linked-account defenses remain in place. Before HTTP response JSON
reaches atproto, `safeWhatwgFetch` enforces16,384 nodes,2,048 entries per collection,
depth64 and the existing1MiB body limit. Decoding remains BOM-tolerant and does
not trust Content-Type. DNS pinning, SSRF rejection, redirects and timeouts are
unchanged. Valid response bytes, headers, status and final URL are preserved.

The guarded fetch reaches authorization/protected-resource metadata, PAR/token
responses, DID PLC/web resolution and client metadata paths. No persisted
resolver cache is supplied. State/session stores check the same complexity budget
before writes and restores, including serialized DPoP JWK JSON; consuming OAuth
state clears its secrets before restored-state validation. These limits also
protect unbounded schemas, outside the constrained-collection parser fix.

Tests load the actual installed atproto parser and prove its bounded-array fix,
then independently prove transport rejection before parsing. Real NodeOAuthClient
fixtures, global-fetch prohibition, legacy-state restore and replay protections
remain. No credential-persistence or authorization behavior changes here.
