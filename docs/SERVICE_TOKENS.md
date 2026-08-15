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
| `packages/api/src/routes/auth.ts` | `POST /auth/service-token` endpoint |
| `packages/api/src/models/Application.ts` | `type` / `isOfficial` / `isInternal` fields |
| `packages/api/src/models/ApplicationCredential.ts` | `publicKey`, `secretHash`, `type: 'service'` |
| `packages/api/src/utils/credentialUsability.ts` | `isCredentialUsable()` (active or in rotation grace) |
| `packages/core/src/mixins/OxyServices.utility.ts` | `auth()` + `serviceAuth()` middleware |
| `packages/core/src/mixins/OxyServices.auth.ts` | `getServiceToken()`, `makeServiceRequest()`, `configureServiceAuth()` |
