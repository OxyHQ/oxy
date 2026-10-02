# Internal MCP adoption candidate

I04 [#1523](https://github.com/OxyHQ/oxy/issues/1523), reviewed against
[ADR 0018](../adr/0018-native-alia-agency-and-app-capability-catalogs.md).
This is an additive implementation candidate awaiting review and coordinated
release. It has not been published, deployed or adopted by product consumers.
The earlier [design proposal](proposals/internal-mcp-transport.md) explains the
boundary; this page describes the implemented APIs and migration requirements.

## Authority and shared handlers

`InvocationPrincipal` distinguishes `kind: 'oauth'` (origin account, active
account, client, scopes, resource) from `kind: 'capability'` (verified ticket
claims, including actor, requester, resource, coordinator and execution
authorization). Schema parsing alone does not authenticate either principal.

`OxyServer.agency` adds live `serviceCatalogs`, `issueCapabilityTicket` and
`introspectCapabilityTicket` calls on the service lane. The existing user route
is exposed as `createExecutionAuthorization(input, { requesterToken })`: the
requester's explicit bearer is mandatory, and a service token cannot replace it.
Calls disable caching, deduplication and automatic retries. The default 5-second
network timeout establishes no new I03 policy or freshness SLA; ticket TTL is
unchanged. Service credentials stay in server code.

`createInternalCatalogMcpHttpService` mounts a separate `/_oxy/mcp` lane and
accepts only `Authorization: Capability <ticket>`. Every request verifies the
ticket, and every call verifies again before resource authorization and after
the domain authorization callback. Use `createLiveCapabilityTicketVerifier`
from `@oxy.so/core/server` to combine local signature/issuer/audience/expiry
checks with live Oxy introspection. Its active claims must exactly match the
signed claims, and expiry is checked again after introspection. A failure,
revocation, timeout or cancellation refuses the operation.

The server requires exact catalog registration/version/digest, tool, app,
resource, effective account, required capabilities and signed input limits.
`resolveResource` derives the complete `ResourceRef` from the domain input;
`authorize` still checks current domain access. Only the signed tool, when
exposed internally, is registered. `tools/list` grants no later execution right.

Use one `InvocationHandlers` map for both lanes. The opt-in external adapter
`createCatalogMcpHttpServiceWithInvocationPrincipal` projects OAuth into the
discriminated context. Existing `createCatalogMcpHttpService` consumers retain
their OAuth context and behavior. OAuth credentials cannot enter the internal
lane, and internal tickets cannot authenticate on the external `/mcp` lane.

## Mount before body parsing

The following wiring assumes a registered canonical catalog and its binding,
the receiving app's existing `OxyServer`, a trusted public-key resolver, and
domain-owned `handlers`, `resolveResource` and `authorize` callbacks:

```ts
import { createLiveCapabilityTicketVerifier } from '@oxy.so/core/server';
import { createInternalCatalogMcpHttpService } from '@oxy.so/mcp';

const verifyTicket = createLiveCapabilityTicketVerifier({
  issuer: 'https://api.oxy.so',
  audience: catalog.audience,
  resolvePublicKey,
  introspect: (ticket, { signal }) =>
    oxy.agency.introspectCapabilityTicket(ticket, { signal }),
});

const internalMcp = createInternalCatalogMcpHttpService({
  catalog,
  binding, // { registrationId, version, digest } from the live registry
  verifyTicket,
  handlers,
  resolveResource,
  authorize,
});

app.use('/_oxy/mcp', (req, res) => {
  void internalMcp.handleMcp(req, res);
});
// Mount the external MCP handler here too, before consuming its request stream.
app.use(express.json());
```

MCP owns bounded body parsing; mounting after a global `express.json()` consumes
the stream too early. Host validation uses the catalog's `internalBaseUrl`.
Configure proxy Host forwarding and the trusted catalog consistently. HTTPS is
required for the client except loopback HTTP; loopback remains valid in every
environment. `allowedOrigins` is an explicit allowlist, not an authority bypass.

## Call with one proof per operation

The coordinator discovers the live registration and requests a ticket for an
existing execution authorization, pinning the selected catalog:

```ts
import { createInternalCatalogMcpClient } from '@oxy.so/mcp';

const binding = {
  registrationId: registration.id,
  version: registration.version,
  digest: registration.digest,
};
const grant = await coordinator.agency.issueCapabilityTicket({
  executionAuthorizationId,
  expectedCatalog: binding,
}, { signal });
if (!grant.decision.allowed || !grant.ticket) throw new Error('Action refused');

const client = createInternalCatalogMcpClient({
  endpoint: new URL('/_oxy/mcp', registration.catalog.internalBaseUrl).href,
});
const result = await client.callTool(grant.ticket, toolName, input, { signal });
```

Select the registration by the intended app and resource, not by list order.
The endpoint must be trusted server configuration/discovery. The client creates
and closes an ephemeral MCP client per `listTools` or `callTool` operation,
sends proof only in the transport header, omits cookies, refuses redirects and
does not reconnect/retry automatically. Tickets never belong in tool arguments,
session state or logs. An MCP tool refusal may be a result with `isError: true`;
transport/authentication failures can reject the promise. Handle both forms.

Idempotency remains the canonical domain handler's responsibility. A retry
keeps the same authorized operation identity; a deliberate new intent needs a
new execution authorization. The transport itself does not create an effect
ledger, durable audit record or autonomous bot authentication.

## Migration and release window

1. Release reviewed contracts and the common server/client support together
   with I07 and the SDK OAuth workstream. Choose new publishable versions;
   local candidates still carry the old package numbers for fixture testing.
   Core and MCP dependency/peer minimums must require the contracts release
   containing `canonicalCapabilityJson`, `inputSatisfiesCapabilityLimits`,
   `isLoopbackOrigin`, the discriminated principal and ticket request schema.
   A range admitting older contracts is invalid. Consumers must likewise
   require the first core/MCP releases containing these new APIs. Preserve upper
   bounds on peer ranges for packages with breaking majors. Rebuild and pack
   each release candidate in the same command, inspect packed dependency ranges,
   and repeat the isolated packed ESM/CJS check on the selected versions.
2. Upgrade all strict ticket claim decoders before opting into `expectedCatalog`.
   It is optional on the existing API; legacy tickets without `catalog` keep
   their legacy behavior but are refused by the new internal MCP lane.
3. Register the canonical catalog and mount both lanes with the same handlers.
   Canonical JSON preserves valid `__proto__` schema properties via a null
   prototype object. Historical registrations whose digest omitted such a key
   need re-registration and fresh pinned tickets. Do not accept an old digest
   as an alias for the corrected definition. Ordinary catalog digests keep
   registry-compatible key ordering and omitted undefined object properties.
4. Adapt a server and coordinator pilot, preserve live domain membership and
   resource permissions, compare old HTTP capabilities/internal MCP/external MCP,
   and review audit attribution and idempotency on the actual product handlers.
   I11 owns Noted/Mercaria consumer changes. I04 fixtures do not perform them.
5. Keep `/_oxy/capabilities` available until actual consumer parity, adoption and
   absence of remaining legitimate legacy traffic are demonstrated. Package
   publication, deployment and removal of the legacy lane are separate gates.

No production schema migration, version bump or publication is part of this
candidate. I03 policy decisions and I01 bot authentication remain their own
workstreams; the implementation does not claim to settle them.

## Evidence and consumer limits

The [evidence manifest](../audits/1519-i04-2026-10-02/evidence.json) records source,
log and final tarball SHA-256 values. Local Linux/Bun 1.4.2 validation on
2026-10-02 passed contracts 53 suites/915 tests; core 172/2116, followed by the
final live-verifier suite 1/4; and final MCP 8/35. API authority exercised real
HTTP and isolated PostgreSQL (1 suite/13 tests). Generic transport parity used
one real HTTP/PostgreSQL fixture (1/1): all three transports share a handler
and SQL effect ledger, deny account/resource mismatch and revocation, preserve
one effect for replay, and permit a second effect for a newly authorized intent.
It does not run four product integrations.

Final packed verification installed 120 dependencies in a separate directory,
resolved the installed tarballs rather than workspace source, and passed CJS
and ESM signature/live authority/client/resource/revocation checks. The manifest
names the final `i04-packed-consumer-nOsZpG` fixture, superseding earlier packs.
Reproduce after building each required package with `bun run build && bun pm pack`:

```sh
node packages/mcp/scripts/verify-internal-packed.mjs
```

`consumerAccountBinding.test.ts` contains three reduced policy projections with
real HTTP through the common OAuth adapter. They are not executions of product
code, internal MCP adoption, or product end-to-end parity:

| Consumer and pinned source | Evidence and remaining work |
| --- | --- |
| [Noted `806e9cae`, backend](https://github.com/OxyHQ/Noted/blob/806e9cae040a7d9446557e7ce9eda64069116056/packages/backend/src/capabilities/noted-mcp-http.ts) | Callback returns origin `accountId`; reduced fixture demonstrates A→B denial and an explicit active-account adaptation plus central revocation. Product change remains I11. |
| [Mercaria `9e546e66`, backend](https://github.com/OxyHQ/Mercaria/blob/9e546e66b36b8050bfe07a37f53ee436444688cf/packages/backend/src/capabilities/mercaria-mcp-http.ts) | Origin callback projection; adaptation retains a reduced store membership/permission boundary and rejects A-owned store access as B. Full product membership/resource parity remains I11. |
| [website `a53531ee`](https://github.com/OxyHQ/website/blob/a53531ee471304b390e4be5ec1322e0672c9b08e/server/mcp/catalog.ts) | Active-account/admin boundary projection, with revocation; external-only exposure stays external-only. |
| [Inbox frontend `730850e5`](https://github.com/OxyHQ/Inbox/tree/730850e5ab0992079ab23b6c1c30e9001ad76af7) | This frontend repository has no MCP/capabilities surface. It is distinct from the real Inbox producer in Oxy below. |
| [Inbox producer in Oxy `72d41bf5`](https://github.com/OxyHQ/oxy/blob/72d41bf5c39cd635453440ce258177574dc1270e/packages/api/src/capabilities/inbox-mcp-http.ts) | Uses `activeAccountId`. The [I11 source fixture](../audits/1519-inbox-mcp-2026-10-03/report.md) executes real HTTP MCP, Inbox handlers/domain and Postgres: origin A with active B reads B, refuses A resources, and rejects the next request when synthetic introspection becomes inactive. It does not prove live consent, internal transport adoption or three-transport parity. |

I04 remains open pending review and acceptance. Candidate artifacts establish
local package behavior; they do not establish a published version, live rollout,
consumer adoption, end-to-end audit coverage or authorization-policy approval.
