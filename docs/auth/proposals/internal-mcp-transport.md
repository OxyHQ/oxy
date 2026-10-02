# Candidate design — shared internal and external MCP transport

Status: implemented candidate under review, not activated. See the
[adoption guide and evidence](../internal-mcp.md) for the current APIs and
verified scope. I04 [#1523](https://github.com/OxyHQ/oxy/issues/1523)
under [#1519](https://github.com/OxyHQ/oxy/issues/1519). The authority policy in I03
and autonomous bot authentication in I01 remain decision gates. No package is
published by this document.

## Current source and compatibility

`catalogAdapter.ts` registers only tools exposed as `mcp`, authenticates
`McpPrincipal` from OAuth `authInfo`, and binds domain authorization to
`activeAccountId`. `httpTransport.ts` introspects each HTTP request before
constructing a stateless server. The candidate `ServerAgencyApi` adds
`serviceCatalogs`, `issueCapabilityTicket`, `introspectCapabilityTicket`, and
`createExecutionAuthorization` alongside the existing requester assertions.
Execution authorization uses an explicitly supplied requester bearer and the
existing user-authority route; service identity never becomes requester identity.

The existing `CatalogInvocationContext` and OAuth-only overload remain unchanged.
New opt-in adapter functions provide a discriminated invocation principal;
existing handlers are not forced to read a union with missing OAuth properties.
An internal capability ticket is never converted to `McpAccessTokenClaims`.

## Concrete implementation boundary

1. Contracts add separate external OAuth and internal capability invocation
   principals. Preserve origin account, active/effective account, actor, app,
   tool, resource and catalog version/digest as separate fields. Schema parsing
   is structural validation, never authentication.
2. Core `/server` adds live service methods for catalog discovery, ticket
   issuance/introspection and execution authorization. All service credentials
   remain in the server namespace. Authority lookups disable caching; transient
   network failures fail closed and authority mutations are not automatically
   retried. Requester bearer assertions stay bound to the intended audience.
3. MCP transport receives internal proof in an authenticated transport header,
   not arbitrary tool arguments or logs. It selects a verifier from proof
   format and allowed mechanism, not a client flag. OAuth cannot authenticate
   as Capability, and Capability cannot authenticate as OAuth.
4. The internal verifier validates ticket signature, issuer, audience and TTL,
   then performs live Oxy ticket introspection using the receiving service's own
   credential. For a call, it binds the ticket to the exact catalog digest,
   version, tool, effective account, resource and execution authorization. A
   ticket for tool A cannot discover or invoke tool B by changing the body.
5. An authenticated internal principal is injected privately into that request's
   server/adapter closure. A domain `authorize` callback is still required for
   resource authorization, but cannot create authenticated internal identity.
   The same canonical handlers and input/output validation serve both routes.
6. Tool exposure is evaluated separately for internal and external surfaces.
   Internal-only tools never appear in external `tools/list`, including when
   a caller supplies a forged flag. Discovery evidence is not reusable
   execution proof: every `tools/call` revalidates current authority.
7. Native bot self-authentication support is added only after I01 approval and
   live-key implementation. Own-account capability does not bypass action,
   resource, tool, policy, spend limits or execution authority.

## Migration and verification

The legacy HTTP capability route remains available through I05 comparison and
consumer adoption. I04 does not silently migrate Noted/Mercaria resource
ownership semantics; it supplies fixtures for origin A, active B, A/B resources
and B revoked. Reduced fixtures cover Noted, Mercaria and website. The pinned
Inbox frontend tree has no MCP surface; the real Inbox producer lives in Oxy
(`packages/api/src/capabilities/inbox-mcp-http.ts`). Its separate
[I11 fixture](../../audits/1519-inbox-mcp-2026-10-03/report.md) covers external MCP
with real Inbox SQL and an explicit synthetic introspection boundary. Internal
transport adoption and full product parity remain pending. I11 owns product changes.

Acceptance requires type/audience/signature negative cases, tool A/B mismatch,
resource/account mismatch, changed catalog digest/version, revoke between list
and call, timeout/recovery, independent requests, and idempotent effect retry.
Run these against both ESM and CJS from tarballs built and packed in the same
command with `bun run build && bun pm pack`; fixture projects must resolve the
packed package, not workspace source. Coordinate one version window with I07
for contracts/core/mcp. A real breaking API requires its own version decision;
calling the change additive does not establish compatibility.

## Decisions and remaining evidence

The first implementation milestone adds an optional `expectedCatalog` binding
to ticket requests and the corresponding signed `catalog` claim. Issuance and
live introspection compare the registration ID, version and digest with the
active catalog. Legacy requests and tickets without this field retain their
existing behavior; they cannot authenticate through the internal MCP
entrypoint. A legacy strict claim decoder must be upgraded before receiving a
pinned ticket. This is an opt-in wire extension, not a rollout claim.

Authority SDK calls disable caching, deduplication, retries and implicit
authentication retries. The five-second request timeout does not change the
existing ticket TTL or establish an I03 freshness SLA. Tests cover explicit
requester authority, abort and network failure, legacy ticket compatibility,
wrong bindings, signature verification, and a catalog change that retains the
same tool name. Local verification passed 9 contract tests, 18 server SDK tests,
22 API authority tests against isolated PostgreSQL, all 19 package builds,
strict core typechecking and scoped Biome with zero warnings. That first milestone has now been extended with the internal transport, resource
resolution, packed ESM/CJS fixtures, generic three-transport PostgreSQL parity
and three reduced consumer-policy projections. The current counts, final pack
hashes and consumer limits are in the [adoption guide](../internal-mcp.md).
Actual product adoption and product parity remain pending.

The internal ticket mechanism already exists; the additive boundary above was
reviewed against ADR 0018. I03 has not approved a new freshness maximum,
service-credential revocation guarantee, or internal header/session binding
policy. The two-process session-cache test and bot-own-session acceptance are
not supplied by source inspection. Final local package artifacts and generic integration traces are available;
review, coordinated release and actual pilot parity remain gates before I04
can be completed or described as adopted.
