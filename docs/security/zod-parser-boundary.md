# Zod parser boundary review

Status: reviewed residual paths for `GHSA-mrhx-c7xc-m3w5`, 2026-10-24.
The platform's own schemas use Zod **4.6.7**, including published contracts and
core. This document does not acknowledge Zod 3 in a public SDK or another runtime
parser. The audit gate enforces the exact advisory and dependency graph with
`scripts/zod-audit-paths.mjs`; a different advisory, version, consumer or vendored
CLI artifact requires a new review. It runs without installed dependencies.

## Defect and remediation

The advisory concerns work performed after a collection's size bound already
fails. A 20,009-byte object with 10,000 invalid elements produces 10,001 issues in
the installed Zod 3.25.76 positive control despite a 100-element maximum. A 1 MiB
HTTP body limit does not mitigate that behavior. Own schemas use the upstream
patched release; an HTTP test proves an oversized array is rejected before any
element parser runs. No prototype modifications, package-manager patch or
`zod/v3` import is used by the migrated code.

Wire semantics are retained using supported Zod checks: UTF-16 string limits,
minute-resolution ISO timestamps, URL validation without implicit output trimming,
and integer validation without a new implicit safe-integer ceiling. Generic GUID
validation retains the previous hexadecimal UUID grammar. Existing explicit
resource, financial, numeric and strict-object limits remain in place.

## Unavoidable atproto runtime dependency

Reviewed chain: API → `@atproto/oauth-client-node@0.5.7` →
`@atproto/oauth-client@0.8.7` → `@atproto/oauth-types@0.7.6` → `zod@3.25.76`.
The lock guard freezes all reviewed atproto parser/resolver versions, not just
this abbreviated chain. The upstream replacement still depends on Zod 3; there
is no supported patched v3 release. This is a bounded residual risk, not a claim
that the dependency itself is fixed.

Every linked-account HTTP response is read through `safeWhatwgFetch` in
`packages/api/src/services/linkedAccounts/http.ts`. Before any response reaches
atproto, the transport applies an iterative JSON complexity budget: **16,384
nodes, 2,048 entries per collection and depth 64**, independently of the existing
1 MiB byte limit. It uses the same BOM-tolerant decoding as `Response.json()` and
does not trust Content-Type. Valid response bytes, status, headers and final URL
are preserved. Existing DNS pinning, SSRF rejection, redirect and timeout rules
remain. Non-JSON responses retain their normal downstream failure behavior.

| Parser input | Actual upstream path | Boundary and provenance |
| --- | --- | --- |
| Authorization and protected-resource metadata | `oauth-authorization-server-metadata-resolver.js`, `oauth-protected-resource-metadata-resolver.js` call `response.json()` and schema parsers | Constructor receives the guarded fetch; both resolvers receive that same function. |
| PAR and token responses | `oauth-server-agent.js` uses `fetchJsonProcessor`, then `oauthParResponseSchema` or `atprotoOAuthTokenResponseSchema` | `OAuthServerFactory` forwards the guarded fetch to each agent. Access/refresh token strings are opaque in this flow. |
| DID PLC/web documents | `@atproto-labs/did-resolver` methods `plc.js` and `web.js` use `didDocumentValidator` | `createIdentityResolver(options)` receives the same injected fetch. The Node handle resolver also receives it; Bun's configured AppView resolver uses it. |
| Client metadata | `validate-client-metadata.js`; optional static `OAuthClient.fetchMetadata` | Oxy passes its own fixed metadata object to the constructor. It does not invoke the static remote-client metadata loader. |
| DPoP JWK restored from a store | `node-dpop-store.js` → `JoseKey.fromJWK`; a serialized string is JSON-parsed before `jwkSchema` | Both Oxy state/session stores apply the budget before writes and restores, including nested object JWK and serialized JWK JSON. String JWK has the same 1 MiB byte bound. |
| JWT/JWKS helpers exported by the dependency | `@atproto/jwk` and `@atproto/jwk-jose` export generic decode/verify helpers | Oxy's supported linking flow does not call those helpers on provider JWTs, ID tokens or arbitrary remote JWKS. No claim is made for arbitrary consumers of these exports. A new consumer is rejected by the dependency-path guard and requires review. |
| Resolver caches | Upstream in-memory metadata caches, populated after the guarded fetch and parse | No persisted resolver cache is supplied. A process restart creates empty caches. |

Persisted OAuth state contains server-created flow data and locally generated
DPoP private JWK, with a ten-minute lifetime. `stateStore.get` consumes the
challenge once and clears its secrets before rechecking the restored state, so
an oversized legacy row fails closed and cannot be replayed. Session state is a
per-process map, not a durable token store; it is rechecked on both set/get and
cleared after the flow. No new credential persistence was introduced.

Tests use the actual installed Zod 3 parser as an explicit amplification positive
control. A separate real `NodeOAuthClient` fixture resolves valid authorization
metadata and rejects an oversized DID response through the injected guarded
fetch, with global fetch forbidden. The fixture uses a Node child solely because
Jest's CommonJS runner cannot load the upstream ESM module. Store tests cover
oversized serialized JWK, in-memory restore, legacy database restore, secret
clearing and replay rejection.

## Build tooling residuals

- `shadcn@3.8.5 → zod@3.25.76` is a development dependency of the Vite test app.
  The app imports its static Tailwind stylesheet at build time; it does not import
  the generator's JavaScript or execute the CLI in a served runtime. Moving it
  into runtime dependencies or another workspace fails the guard.
- The exact vendored `@oxy.so/expo-cli-native@58.1.11+oxy.native.1` artifact contains
  Expo's Node build CLI dependency on Zod 3.25.76. Expo installs this CLI alongside
  the framework, but it is not the React Native app runtime or an API parser.
  The guard binds the existing artifact identifier and integrity, and admits only
  the current incoming `expo@58.0.14 → @expo/cli (^58.1.11)` edge. Direct API/SDK
  CLI dependencies and a new transitive parent are rejected. This exception
  does not cover another CLI version, an altered artifact, or a direct weak Zod
  import in an app or published package.

## Removal and regression gates

Upgrade or replace the upstream atproto dependency when a supported patched
parser is available; rerun actual linking/restore tests and remove the residual
entry. Upgrade the two tooling paths independently. Once no vulnerable resolution
remains, the audit gate rejects the stale acknowledgement until it is removed.
The guard mutation tests cover a vulnerable API/SDK parser, alternate runtime
consumer, old v3 or v4 resolution, atproto version drift, CLI drift, new weak leaf
and complete removal. The generic audit tests also reject any new high Zod
advisory. Full API and shared contract tests remain required.

Sources: [GitHub advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
[upstream collection-bound fix](https://github.com/colinhacks/zod/pull/6652).
The upstream call paths above were inspected in the exact installed versions
recorded by the committed lockfile; they are not assumptions about future releases.
