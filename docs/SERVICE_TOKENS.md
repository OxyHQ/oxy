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
app.use('/internal', oxy.serviceAuth({
  jwtSecret: process.env.ACCESS_TOKEN_SECRET
}));

app.post('/internal/trigger', (req, res) => {
  req.serviceApp; // { appId, appName, credentialId, ownerAccountId, scopes, environment }
  req.userId;     // from X-Oxy-User-Id (or null) — attribution, NEVER the payer
});
```

### Mixed Auth (user + service)

```typescript
app.use('/data', oxy.auth({
  jwtSecret: process.env.ACCESS_TOKEN_SECRET
}));

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

### The grant

Authority lives in **`app_grants`** — the same revocable row the OAuth consent
screen writes, `GET /auth/grants` lists and `DELETE /auth/grants/:applicationId`
removes. There is deliberately no separate delegation table: a second store
would be a second revocation surface, and a user disconnecting an app in
"Connected apps" means it.

A row alone authorises nothing. The grant must name **`acting-as:offline`**,
which is:

- **privileged** — only Oxy staff may add it to an application's ceiling, so an
  arbitrary self-service app can never put the question to a user; and
- **consent-required** — never auto-approved, whoever the application is. This
  is what makes the mechanism work at all: trusted applications are otherwise
  auto-approved and record **no** grant row, and every application that can mint
  a service token is trusted.

Both gates are needed. Consent alone would let any app ask; privilege alone
would let the platform decide for the user.

### How the two scope sets compose

| | source | says |
|---|---|---|
| `req.serviceApp.scopes` | credential ∩ application ceiling, at mint | what the PLATFORM allows this app to do |
| `req.serviceActingAs.scopes` | the user's `app_grants` row | what THIS USER allowed it to do |

`oxy.requireScope(s)` requires `s` in **both** for a delegated request, and in
`serviceApp.scopes` alone for a request acting as itself. The intersection is
the point: only the app scope would let an app do to a user what that user never
consented to; only the grant would let a user hand an app authority staff never
gave it.

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

- Service tokens verified via **HMAC-SHA256 signature** (not just decoded)
- `jwtSecret` must be provided to `auth()` / `serviceAuth()` for verification, and the only value that works is **`ACCESS_TOKEN_SECRET`** — there is no separate service-token secret (issue #987; earlier SDK docs named a `SERVICE_TOKEN_SECRET` that has never existed). Because the scheme is symmetric, a host that can VERIFY a service token can also MINT one, and that same secret signs every user access token. **So local verification belongs inside the Oxy API's own trust boundary only, and no service outside it holds the key today** — the hazard is a documented configuration nobody has followed, not a live exposure. [ADR 0012](adr/0012-service-token-signing-key-model.md) records the decision to retire it for asymmetric signing against a published JWKS, the dual-accept window any key change needs, and the two sub-decisions (key custody, cutover schedule) that need the owner.
- Without `jwtSecret`, service tokens are **rejected** (secure default)
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
