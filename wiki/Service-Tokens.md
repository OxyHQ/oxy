# Service Tokens

Internal Oxy ecosystem apps authenticate with each other using short-lived service JWTs, following the OAuth2 Client Credentials pattern.

## Flow

```
1. Register an Application (type: 'internal' or isOfficial) with an
   ApplicationCredential of type: 'service'
2. Service exchanges the credential's publicKey (oxy_dk_…) + secret
   -> POST /auth/service-token
   -> Returns 1-hour JWT with type: 'service'
3. Service uses JWT as Authorization: Bearer <token>
   + X-Oxy-User-Id: <userId> for user delegation
4. auth() middleware recognizes type: 'service' JWTs
   (stateless — no session DB lookup needed)
```

## Setting Up a Service Credential

Service tokens are minted against the Application registry:

- **`Application`** (collection `applications`) — the app record. Must be `status: 'active'` and platform-trusted (`type: 'internal'` or official); self-service third-party applications cannot mint service tokens.
- **`ApplicationCredential`** (collection `applicationcredentials`) — the credential. `publicKey` (`oxy_dk_…`) is the client id; `secretHash` stores sha256 of the secret. The plaintext secret is returned **once** on create/rotate and never retrievable again. `type` must be `'service'`.
- Rotation keeps the previous credential usable during a 7-day grace window (`isCredentialUsable` in `packages/api/src/utils/credentialUsability.ts`); revocation is immediate.

## Getting a Service Token

```typescript
import { OxyServices } from '@oxy.so/core';

const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
oxy.configureServiceAuth('oxy_dk_...', 'secret...');

// Auto-cached, auto-refreshed (cached until expiry minus buffer)
const token = await oxy.getServiceToken();
```

### Token Payload

```json
{
  "type": "service",
  "appId": "<applicationId>",
  "appName": "mention-backend",
  "credentialId": "<applicationCredentialId>",
  "scopes": ["notifications:write"],
  "iat": 1707235200,
  "exp": 1707238800
}
```

`appId` is the `Application._id` (stable claim name). `credentialId` attributes the token to the specific `ApplicationCredential` that minted it. `scopes` is the credential's requested scopes intersected with the application's granted scopes.

## Making Service Requests

### Simple Request

```typescript
const token = await oxy.getServiceToken();

const response = await fetch('https://api.oxy.so/profiles/username/alice', {
  headers: {
    'Authorization': `Bearer ${token}`,
  },
});
```

### Delegated Request (Acting on Behalf of a User)

```typescript
// makeServiceRequest handles token acquisition + X-Oxy-User-Id header
const result = await oxy.makeServiceRequest(
  'POST',
  '/notifications',
  { message: 'New follower' },
  'user-id-to-act-as'
);
```

This sets both `Authorization: Bearer <service-token>` and `X-Oxy-User-Id: <userId>`.

## Protecting Internal Endpoints

### Service-only (rejects user JWTs)

```typescript
const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });

// Only allows service tokens
app.use('/internal', oxy.serviceAuth({ jwtSecret: process.env.ACCESS_TOKEN_SECRET }));

app.post('/internal/trigger', (req, res) => {
  console.log('Service:', req.serviceApp);     // { appId, appName, credentialId, scopes }
  console.log('Delegate user:', req.userId);    // from X-Oxy-User-Id
});
```

### Mixed (allows both user and service tokens)

```typescript
app.use('/data', oxy.auth({ jwtSecret: process.env.ACCESS_TOKEN_SECRET }));

app.get('/data', (req, res) => {
  if (req.serviceApp) {
    // Service token request
  } else {
    // Regular user request
  }
});
```

## Security

- Service tokens are verified via **HMAC-SHA256 signature** (not just decoded)
- The `jwtSecret` option must be provided to `auth()` / `serviceAuth()` for signature verification
- If `jwtSecret` is not provided, service tokens are **rejected** (secure default)
- Secrets are stored as sha256 hashes; the exchange uses a timing-safe comparison
- Service tokens bypass CSRF protection (bearer-only, not vulnerable to CSRF)
- Expiration is checked locally (no DB round-trip)
- Per-scope authorisation via `oxy.requireScope(...)` after `serviceAuth()`

## Key Files

| File | Purpose |
|------|---------|
| `packages/api/src/routes/auth.ts` | `POST /auth/service-token` endpoint |
| `packages/api/src/models/Application.ts` | `type` / `isOfficial` / `isInternal` fields |
| `packages/api/src/models/ApplicationCredential.ts` | `publicKey`, `secretHash`, `type: 'service'` |
| `packages/api/src/utils/credentialUsability.ts` | `isCredentialUsable()` (active or in rotation grace) |
| `packages/core/src/mixins/OxyServices.utility.ts` | `auth()` and `serviceAuth()` middleware |
| `packages/core/src/mixins/OxyServices.auth.ts` | `getServiceToken()`, `makeServiceRequest()`, `configureServiceAuth()` |
