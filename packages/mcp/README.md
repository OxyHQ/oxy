# @oxy.so/mcp

Shared MCP catalogue, HTTP and OAuth resource transport for Oxy products and
external integrations.

An own product uses its `OxyServer` workload transport for catalogue registration,
central introspection, account connection operations and audit/event posts:

```ts
import { OxyServer } from '@oxy.so/core/server';
import { registerCapabilityCatalog, postOxyServiceJson } from '@oxy.so/mcp';

const oxyApiUrl = 'https://api.oxy.so';
const oxy = new OxyServer({ baseURL: oxyApiUrl });
const transport = oxy.createServiceClient({ baseURL: oxyApiUrl, audience: 'oxy-api' });

const binding = await registerCapabilityCatalog(catalog, { oxyApiUrl, transport });
await postOxyServiceJson(event, { endpoint: `${oxyApiUrl}/capabilities/audit`, transport });
```

The transport owns authentication, token renewal and recipient binding. MCP
helpers do not mint tokens or run a second refresh loop. Keep the transport for
the process lifetime and dispose it during shutdown. A local process can give
`OxyServer` the optional temporary IAM provider from `@oxy.so/core/server/aws`.

`introspectOxyMcpAccessToken`, `requestOxyMcpAccountLink`,
`selectOxyMcpConnectionAccount` and `createCatalogMcpHttpService` accept the same
`transport` option. `createCatalogMcpHttpService` also supports its existing
`introspectToken` callback for a colocated authority.

External callers retain `getServiceToken`, optional `invalidateServiceToken`
and an optional `fetch`. This lane cannot be combined with `transport`. Oxy
still decides whether the presented external credential may use the endpoint.
All authority reads are uncached; redirects and ambient cookies are disabled.
Resource scopes on third-party MCP connections remain enforced.
