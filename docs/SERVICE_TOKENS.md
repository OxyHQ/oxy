# Service Tokens

Internal Oxy ecosystem apps authenticate with each other using short-lived service JWTs (OAuth2 Client Credentials pattern).

## Flow

```
1. Register an Application (type: 'internal' or isOfficial) with an
   ApplicationCredential of type: 'service' (Console staff view or DB)
2. Service exchanges the credential's publicKey (oxy_dk_…) + secret
   -> POST /auth/service-token
   -> Returns 1-hour JWT with type: 'service'
3. Service sends JWT as Authorization: Bearer <token>
   + X-Oxy-User-Id: <userId> for user delegation
4. auth() middleware recognizes type: 'service' JWTs
   (stateless — no session DB lookup)
```

## Setup

Service credentials belong to an `Application` (collection `applications`) via an `ApplicationCredential` (collection `applicationcredentials`):

- `ApplicationCredential.publicKey` = the client id (`oxy_dk_…`)
- `ApplicationCredential.secretHash` = sha256 of the secret — the plaintext secret is shown **once** at create/rotate time and never retrievable again
- `ApplicationCredential.type` must be `'service'`
- The owning `Application` must be `status: 'active'` and platform-trusted (`type: 'internal'` or official) — self-service third-party applications cannot mint service tokens
- Rotation: a rotated credential stays usable during a 7-day grace window; `revoked` is immediate

## Usage

### Get a Service Token

```typescript
import { OxyServices } from '@oxyhq/core';

const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
oxy.configureServiceAuth('oxy_dk_...', 'secret...');

// Auto-cached, auto-refreshed (cached until expiry minus buffer)
const token = await oxy.getServiceToken();
```

### Delegated Requests

Act on behalf of a user:

```typescript
const result = await oxy.makeServiceRequest(
  'POST',
  '/notifications',
  { message: 'New follower' },
  'user-id-to-act-as'  // Sets X-Oxy-User-Id header
);
```

### Protect Internal Endpoints

```typescript
// Service-only (rejects user JWTs)
// Defaults to https://api.oxy.so/.well-known/jwks.json.
// Override serviceTokenJwksUrl only for a private Oxy deployment.
app.use('/internal', oxy.serviceAuth());

app.post('/internal/trigger', (req, res) => {
  req.serviceApp; // { appId, appName, credentialId, ownerAccountId, scopes, environment }
  req.userId;     // from X-Oxy-User-Id (or null) — attribution, NEVER the payer
});
```

### Mixed Auth (user + service)

```typescript
app.use('/data', oxy.auth());

app.get('/data', (req, res) => {
  if (req.serviceApp) {
    // Service token request
  } else {
    // Regular user request
  }
});
```

## Token Payload

```json
{
  "type": "service",
  "appId": "<applicationId>",
  "appName": "mention-backend",
  "credentialId": "<applicationCredentialId>",
  "ownerAccountId": "<accountId>",
  "environment": "production",
  "scopes": ["notifications:write"],
  "iss": "oxy-auth",
  "aud": "oxy-api",
  "iat": 1707235200,
  "exp": 1707238800
}
```

Every one of `appId`, `appName`, `credentialId`, `ownerAccountId` and `environment`
is REQUIRED. A signature-valid token missing any of them is refused by both
verifiers — the API's `verifyServiceToken` answers `not_service`, and
`@oxyhq/core`'s middleware answers `401 INVALID_SERVICE_TOKEN`.

- `appId` is the `Application._id` (the claim name is intentionally stable — `@oxyhq/core` reads it under this name).
- `credentialId` attributes the token to the specific `ApplicationCredential` that minted it (useful for post-rotation revocation).
- `ownerAccountId` is `applications.owner_account_id`: the Oxy account that owns the application and is **financially responsible** for what it does (ADR 0007). It is resolved server-side from the presented credential at mint time and is never accepted from the request; it is read live, so an application transferred to another account mints the new owner from the next token onward.
- `environment` mirrors the minting `ApplicationCredential.environment`, for test/live isolation.
- `scopes` are the EFFECTIVE scopes: the credential's requested scopes **intersected** with the application's granted scopes (`intersectScopes`, the single authority — nothing intersects a second time downstream). A credential with no explicit scopes inherits the app's full set. The intersection runs at MINT time, so a scope the application has since lost is gone from the next token even though the credential row still names it.

There is deliberately **no user claim**. A delegated end user travels in the
`X-Oxy-User-Id` header, is authorised per request against an explicit acting-as
grant, and is attribution only.

## Attribution — who pays vs. on whose behalf

The five claims above are the canonical attribution tuple of
[ADR 0007](adr/0007-canonical-request-attribution.md) minus the delegated user.
`@oxyhq/core/server` exposes them as two deliberately different shapes:

```typescript
import {
  getOxyBillingPrincipal,      // OxyBillingPrincipal | null  — who is charged
  getOxyDelegatedUserId,       // string | null               — on whose behalf
  getOxyRequestAttribution,    // both, as one object
} from '@oxyhq/core/server';

const principal = getOxyBillingPrincipal(req);
// { accountId, applicationId, credentialId, environment, scopes }
```

`getOxyBillingPrincipal` reads `req.serviceApp` and nothing else — never
`req.userId`, `req.user` or `req.serviceActingAs`. And because it returns an
OBJECT while every user-identity accessor returns a `string`, a delegated user
id cannot be passed where a billing principal is expected: the substitution
ADR 0007 forbids is a compile error, not a review question.

Restated as the rule a reviewer applies: **if removing `X-Oxy-User-Id` from a
request would change what any account is charged, the code is wrong.**

## Acting as a user

`X-Oxy-User-Id` is a header, so on its own it proves nothing. `oxy.auth()`
therefore treats it as a request to be authorised, not as an identity: on every
request carrying it, the middleware calls

```
GET /internal/service-acting-as/verify?appId=<app>&userId=<user>
→ { "authorized": boolean, "scopes": string[] }
```

and refuses with `403 SERVICE_ACTING_AS_UNAUTHORIZED` unless the answer is yes.
There is **no fail-open path**: an unreachable endpoint, an unconfigured
verifier and an explicit refusal all produce the same 403. Omitting the header
is not a failure — it means the service acts as itself, and `req.userId` is
`null`.

### Who may be acted for

**Every application needs explicit user consent.** Platform trust permits an
application to hold a service credential; it does not permit that credential to
borrow an arbitrary person's identity. The user must approve the
consent-required `acting-as:offline` scope, which writes a per-(user,
application) `app_grants` row.

Resolution order, and the order is the security property:

| | condition | answer |
|---|---|---|
| 1 | the user revoked this application | no |
| 2 | the application is missing or not `active` | no |
| 3 | the user granted it `acting-as:offline` | yes, with the **grant's** scopes |
| 4 | otherwise | no |

Revocation is checked **first**, so it wins over a stale or concurrently
recreated grant. Trust is deliberately absent from this resolution: it is a
credential-mint decision, not a per-user consent decision. A user who has never
approved `acting-as:offline` is refused, including for an official application.
This bounds a leaked first-party credential to users who explicitly opted in.

### Revocation

`DELETE /auth/grants/:applicationId` is the one user action. It deletes the
`app_grants` row if there is one **and** writes a marker to
`service_acting_as_revocations`. The marker makes an explicit refusal win even
if a stale or racing writer recreates the grant; absence of a grant always means
unauthorized.

It is a marker table rather than a column on `app_grants` because a revocation
row living in the grant table would be a row whose presence means the opposite of
every other row there, in a table `followCapability` already reads as consent.
This is not a second revocation surface of the dangerous kind: a second place to
say YES is dangerous because revoking in one leaves the other authorising, while
a second place to say NO can only ever subtract authority.

**Undoing it takes a real decision.** The marker is cleared only when an
authorize names `acting-as:offline` — a scope that is privileged (staff-only on an
application's ceiling) and consent-required (never auto-approved, whoever the
application is), so a request carrying it always reaches a consent screen.
Clearing on any successful authorize would have made revocation worthless: a
a weaker authorize can still be auto-approved for a first-party application and
must not silently undo a deliberate refusal.

### Non-trusted applications

They keep the grant path: a grant naming `acting-as:offline`, and nothing weaker.
Unreachable today — the mint refuses them a service token and `/internal` refuses
them again — and kept because "unreachable" is a property of two other files, and
the day either changes this must not start authorizing an application no user
agreed to.

### How the two scope sets compose

| | source | says |
|---|---|---|
| `req.serviceApp.scopes` | credential ∩ application ceiling, at mint | what the PLATFORM allows this app to do |
| `req.serviceActingAs.scopes` | the explicit grant row | what the USER allows it to do |

`oxy.requireScope(s)` requires `s` in **both** for a delegated request, and in
`serviceApp.scopes` alone for a request acting as itself. The intersection is
the point: only the app scope would let an app do to a user what that user never
consented to; only the grant would let a user hand an app authority staff never
gave it.

There is no automatic path. The verify endpoint returns the grant's scopes, so
the user's decision always narrows the token.

### Who may call the verify endpoint

`/internal` is service-to-service only, gated on a valid service token **and** a
platform-trusted calling application. The second gate is not redundant — the
mint has a deliberate carve-out letting a non-trusted app mint a service token
from a payments-only credential, so holding a token is not the same as being a
first-party service.

The verifier is not the application being asked about (Syra asks about Alia), so
"may only ask about itself" would break the mechanism rather than tighten it.
The residual disclosure — a trusted first-party service can learn whether a user
delegated to some other app — is accepted and logged. Every negative answer is
byte-identical (`{ authorized: false, scopes: [] }`, always 200, never 404), so
the endpoint is not an oracle for which users or applications exist.

## Security

- Service tokens are signed with Ed25519 and carry an exact `kid`; external
  `auth()` / `serviceAuth()` verifiers fetch public keys from
  `https://api.oxy.so/.well-known/jwks.json` by default.
- A verifier pins EdDSA, issuer `oxy-auth`, audience `oxy-api`, expiry/not-before,
  token type and exact non-empty scopes/attribution IDs. Unknown keys and an
  unavailable expired cache fail closed.
- Never pass or distribute `ACCESS_TOKEN_SECRET`. `jwtSecret` exists only as an
  Oxy-API-internal HS256 transition while pre-cutover tokens drain; external
  consumers use JWKS and hold no mint-capable key. See
  [ADR 0012](adr/0012-service-token-signing-key-model.md).
- Secrets stored as sha256 hashes; timing-safe comparison on exchange
- Service tokens bypass CSRF (bearer-only, not vulnerable)
- Expiration checked locally (no DB round-trip)
- Per-scope authorisation via `oxy.requireScope('files:write')` after `serviceAuth()`

## Key Files

| File | Purpose |
|------|---------|
| `packages/api/src/routes/auth.ts` | `POST /auth/service-token` endpoint; `GET`/`DELETE /auth/grants` |
| `packages/api/src/routes/internal.ts` | `/internal` router + `GET /internal/service-acting-as/verify` |
| `packages/api/src/services/serviceActingAs.service.ts` | resolves the delegation grant; `acting-as:offline` |
| `packages/api/src/db/schema/appGrants.ts` | `app_grants` — the revocable per-(user, app) consent row |
| `packages/api/src/utils/applicationScopes.ts` | the scope vocabulary, privileged and consent-required sets |
| `packages/api/src/db/schema/applications.ts` | `type` / `isOfficial` / `isInternal` fields |
| `packages/api/src/db/schema/applicationCredentials.ts` | `publicKey`, `secretHash`, `type: 'service'` |
| `packages/api/src/utils/credentialUsability.ts` | `isCredentialUsable()` (active or in rotation grace) |
| `packages/core/src/mixins/OxyServices.utility.ts` | `auth()` + `serviceAuth()` middleware |
| `packages/core/src/mixins/OxyServices.auth.ts` | `getServiceToken()`, `makeServiceRequest()`, `configureServiceAuth()` |
