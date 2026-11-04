# Service tokens

Own Oxy backends authenticate with workload identity. External integrations use
bounded customer credentials. [ADR 0049](adr/0049-first-party-platform-authority.md)
and [first-party platform access](auth/first-party-platform-access.md) define the
boundary; an official application name never promotes an external credential.

| Lane | Issuance | Authority |
|---|---|---|
| Own workload | Shared infrastructure proof, live binding and protocol-2 mint | `first_party`, no OAuth scope list |
| External service credential | Client id + secret exchanged at `/auth/service-token` | `external`, live credential/application scope ceilings |
| External machine key or OAuth session | Its documented key/session API | Its existing scopes and revocable grants; not a workload |

## Own service clients

```typescript
import { OxyServer } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';

const oxy = new OxyServer({
  workloadCredentials: createAwsWorkloadCredentialProvider(),
});
const product = oxy.createServiceClient({
  baseURL: 'https://<product-api-origin>',
  audience: 'oxy-service:<registered-product-application-id>',
});
// Use product.fetch (or the product SDK factory) for that recipient.
// Keep the client until its owning process/context ends, then dispose it.
```

The server-only AWS provider uses temporary role credentials, including supported
local role/SSO development. It does not fall back to a customer key. Install its
optional AWS peer as an explicit server dependency. The shared transport handles
challenge, mint, caching, one authorized refresh, destination checks, redirects
and cancellation. Do not implement those in an application.

`application_workload_identities` binds the canonical infrastructure subject to
one application and explicit environment. The issuer checks the active own
application, owner and unexpired binding; live receiver introspection repeats the
relevant authority checks. `credentialId: wl_…` identifies the materialized
attribution row, not a secret. Binding scopes are historical storage, not runtime
authority. Provisioning rejects `--scopes`; see
[binding administration](engineering/auth-and-identity.md#binding-administration).

All workload token helpers now emit protocol 2, including maintenance uses of
`serviceToken()` and `serviceTokenFor()`. Protocol 1 and scoped workload requests
are refused. The [verified retirement](auth/workload-v1-retirement.md) records
publication, rollout, parking and drain separately from source tests.

## Recipient and token lifetime

Product APIs use the exact `oxy-service:<applicationId>` audience, Oxy uses
`oxy-api`, and Kaana uses `kaana.ai`. Shared middleware verifies EdDSA, `kid`,
issuer `oxy-auth`, recipient, token type, attribution, expiry and live authority.
It fetches public keys from `https://api.oxy.so/.well-known/jwks.json` by default;
a receiver cannot mint with those public keys. HS256 is refused.

Both issuer and verifiers use `OXY_SERVICE_TOKEN_MAX_LIFETIME_SECONDS` from
`packages/core/src/server/serviceTokenLifetime.ts`: **300 seconds**, not one hour.
`iat`/`exp` must be integer seconds with a positive bounded lifetime. Cache checks
alone confer no authority. Recheck the deployed constant when planning a drain.

An own token carries `authority: 'first_party'`, application id, credential
handle, owner account, environment and exact audience, with no `scopes`. External
service tokens carry `authority: 'external'` and bounded scopes. Branding or
legacy `tier` is never an authority proof. The supported external `oxy-api`
audience compatibility does not admit retired workload-v1 tokens.

## Requester authority and attribution

A service identity authorizes the service's own operations. Access to private
resources additionally needs a verified original requester and effective account:
use the shared session/task/context facilities in
[first-party tasks](auth/first-party-tasks.md). Downstream services use the
verified derived context; they cannot reuse another coordinator's naked task id.
Resource ownership, membership, bot identity and operation constraints remain.
No own app connection grant or permission level is required.

`X-Oxy-User-Id` by itself is not proof. Inference's immutable `kaana.ai`
attribution is deliberately separate from private-data authority. The billing
principal comes from the verified application owner and credential/workload
identity, never a forwarded user header; see
[inference attribution](inference/attribution.md).
`getOxyBillingPrincipal`, `getOxyDelegatedUserId` and
`getOxyRequestAttribution` keep those concepts separate.

## External credentials and delegation

Explicit `serviceAuth` remains the external customer credential flow. Its
credential must be usable and its application active; live scope intersections,
owner/environment checks, rotation grace and revocation remain enforced. Creating
that credential under an official app does not make it an own workload.

External offline delegation requires the real user's `acting-as:offline` grant
and the matching live application/credential ceiling. `DELETE
/auth/grants/:applicationId` removes the grant, records the revocation and advances
the durable epoch. A stale token or racing grant write cannot override an explicit
revocation. OAuth consent and MCP connection scopes retain their distinct
contracts. Forwarding an external bearer through an own backend never widens it.

Shared `verifyActingAs` and middleware perform central verification and fail
closed on unavailable or malformed authority; callers must not synthesize a
person from a raw header. Account membership and sensitive-operation policy are
additional checks, not substitutes for an external grant. Use
[external auth integration](auth/integration-guide.md) for consent and PKCE,
and [inference credentials](inference/credentials.md) for customer key examples.

## Receiver integration and source pointers

Use `OxyServer.middleware.service()` for a service-only mount and
`middleware.auth()` for supported mixed identity lanes. Configure the registered
recipient identity; apply product ownership and domain rules after authentication.
Use `req.serviceApp.authority`, not a brand flag or `tier`, when distinguishing
own service authority from external scope checks. Do not require OAuth scopes
from a first-party workload or skip resource checks because it is first-party.

| Source | Responsibility |
|---|---|
| `packages/api/src/routes/auth.ts` | External credential exchange and own workload mint |
| `packages/api/src/services/workloadIdentity.service.ts` | Infrastructure binding and explicit environment |
| `packages/api/src/services/agencyServicePrincipal.service.ts` | Live workload and external credential authority |
| `packages/api/src/services/serviceActingAs.service.ts` | External delegation grants and revocation |
| `packages/api/src/services/firstPartyTaskAuthority.service.ts` | Own durable requester/task authority |
| `packages/core/src/server/OxyServer.ts` | Shared caller transport and authority clients |
| `packages/core/src/server/middleware.ts` | Shared recipient authentication |
| `packages/core/src/server/serviceTokenLifetime.ts` | Shared 300-second ceiling |
