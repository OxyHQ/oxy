# First-party platform access

[ADR 0049](../adr/0049-first-party-platform-authority.md) defines the target
contract. Consult the [migration tracker](../architecture/first-party-integration-migration.md)
for implementation and rollout state; this page is not a deployment claim.

| Caller | Authentication | Authorization |
|---|---|---|
| Person in an Oxy product | One `OxyProvider`, existing device session and linked clients | Active account, ownership, membership and domain policy; no app scopes or OAuth consent |
| Own backend | Attested workload, active application/binding, explicit environment | `authority: first_party`; exact recipient audience; account/resource rules, no scopes |
| Own agent acting for a person | Verified requester/effective account carried through run and ticket | Live internal catalogue; correct person's data, no per-app levels |
| Bot acting as itself | Its own bot identity | Its own resources, never a requester's or owner's data by inference |
| External OAuth/MCP client | Explicit account connection with PKCE and isolated bearer | Requested/registered scopes, user consent and live revocation |
| Customer API key | External credential | Credential limits/scopes and resource authority; never promoted by app branding |

## Integrating two Oxy products

Use the receiving product's SDK. Frontend calls use the existing Oxy linked
client so account switching, refresh and cancellation remain centralized.
Backend calls use the shared `OxyServer` workload transport with the receiving
application's audience; no customer API key or application-local token plumbing.
For a registered `oxy-service:<applicationId>` receiver, shared middleware
checks every service token against live central introspection. External service
JWTs retain the intersection of signed scopes and current credential/application
ceilings, with exact application, credential, billing owner, environment,
audience and expiry. A legacy `oxy-api` external audience remains scoped during
client migration. A changed brand flag cannot promote a customer key. Raw
machine keys and external OAuth session introspection remain the existing
Clarity resource API; accepting a signed service JWT does not open those lanes.
The receiver then applies its own resource rules. A service identity is not a substitute for the identity
of the person whose private resource is requested.

Keep the original caller's authority when proxying external traffic. Never infer
full access from the fact that an Oxy backend performed the final HTTP hop.
Public reads, person-bound calls and asynchronous operations are distinct:
a worker retains the original account and operation binding, not a persistent
copy of the user's bearer or a caller-supplied user ID.

## Authentication surfaces

Own sign-in is the ordinary account dialog/Commons confirmation of a sign-in,
without a permissions list. `requestOAuthConsent` is an external-connection API;
own applications receive `unsupported: first-party-application`. The server
resolves own OAuth scope requests to `[]` and never records them as a connection.
New own sign-ins create no Connected apps entry. Historical grants lack lane
provenance and remain revocable until an evidence-based data migration; changing
registry trust must never hide an external connection. Third-party grants remain
visible, revocable and isolated from shared device credentials.

## Agent data

Own agents and Alia can use the live own-app catalogue across products. Remove
per-app permission selectors and grant/ceiling lookups, retaining model/tool
selection, product entitlements and domain rules. A turn by person B with an
agent owned by A operates on B's effective account; choosing that agent must
not expose A's mail. A scheduled task continues as its verified original
requester/account and ends when that authority is no longer valid.

Do not confuse OAuth scopes with lexical variables, database tenant boundaries,
cloud bucket restrictions, app roles or signed operation tickets. Those names
can contain “scope” without representing the removed inter-app permission model.

## Live service authentication

All platform service routes, including mixed user/service routes, must use
`serviceAuthMiddleware` or the shared `userOrServiceAuthMiddleware` dispatcher.
A JWT signature is necessary but does not prove that a workload binding,
application, owner or external credential remains active. Both required and
optional service authentication resolve current authority before attaching a
principal. External scopes are the intersection of the original signed scopes
and the live credential/application ceiling; official branding never changes
that authority. Invalidated service identities fail authentication before a
resource is resolved. Domain and tenant checks still run after authentication.
