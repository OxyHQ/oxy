# Oxy Architecture

Complete architecture documentation for the Oxy ecosystem: identity, authentication, and services.

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [System Architecture](#system-architecture)
3. [Identity System](#identity-system)
4. [Sessions — Device-First Model](#sessions--device-first-model)
5. [Authentication Methods](#authentication-methods)
6. [User Linking](#user-linking)
7. [API Reference](#api-reference)
8. [Database Schema](#database-schema)
9. [Security](#security)
10. [Quick Start](#quick-start)

---

## Core Concepts

### The Phone IS the Password

Oxy uses **device-based cryptographic identity** as the primary authentication method. Your mobile device securely stores your private key, making the device itself your password.

```
+-----------------------------------------------------------------+
|                    IDENTITY vs AUTHENTICATION                    |
+-----------------------------------------------------------------+
|                                                                  |
|  IDENTITY (Private Key)          AUTHENTICATION (Oxy SDK)        |
|  ----------------------          ----------------------------    |
|  - Stored ONLY in               - Handles login flows            |
|    Commons by Oxy app           - Token management               |
|  - Never leaves device          - Device-first sessions          |
|  - Device = Password            - Multiple auth methods          |
|  - BIP39 recovery phrase        - In-app sign-in dialog          |
|                                                                  |
|  [Commons app]  ------------>   [@oxyhq/core]     (foundation)   |
|   (native only)                 [@oxyhq/services] (all UI:       |
|                                   Expo, RN, and RN Web)          |
|                                                                  |
+-----------------------------------------------------------------+
```

### Key Principles

1. **Self-Custody**: Private keys never leave the user's device
2. **Offline-First**: Identity works without internet
3. **Multi-Method Auth**: Same user can authenticate via identity, password, or social
4. **User Linking**: Different auth methods can be linked to same account
5. **Platform Agnostic**: Auth works on native, web, and backend
6. **One SDK UI**: `@oxyhq/services` (`OxyProvider`) is the single UI SDK for every platform — web included, via React Native Web. There is no separate web-only auth SDK.
7. **Server is the session authority**: which accounts are signed in on a device lives in the server-side `DeviceSession` model, never in per-app client state.

---

## System Architecture

### SDK Packages

| Package | Purpose | Platform |
|---------|---------|----------|
| **@oxyhq/contracts** | Zod API contracts (request/response schemas, inferred types) | All (only `zod`) |
| **@oxyhq/protocol** | App-agnostic base substrate: signed-record envelope, canonical JSON, signature/verification, platform crypto | All |
| **@oxyhq/core** | Foundation: API client (`OxyServices`), `SessionClient`, device-first cold boot, OAuth + PKCE helpers, `/server` middleware | All (Node.js, web, native) |
| **@oxyhq/services** | The single UI SDK: `OxyProvider`, `useAuth`/`useOxy`, `OxyAccountDialog`, `OxySignInButton`, `OxyConsentScreen`, screens | Expo / React Native / RN Web |

### Package Structure

```
OxyHQServices/
├── packages/
│   ├── commons/           # Native-only identity vault app ("Commons by Oxy")
│   │   └── (private keys, recovery, QR approve, attestation)
│   │
│   ├── contracts/         # @oxyhq/contracts — Zod API contracts
│   ├── protocol/          # @oxyhq/protocol — signed records + crypto substrate
│   │
│   ├── core/              # @oxyhq/core — foundation
│   │   ├── /session       # SessionClient, cold boot, session-state projection
│   │   ├── /crypto        # Signing utilities (NOT key storage)
│   │   └── /server        # Express middleware (@oxyhq/core/server)
│   │
│   ├── services/          # @oxyhq/services — the single UI SDK (Expo/RN/RN Web)
│   │
│   ├── api/               # Backend API server (api.oxy.so)
│   │   └── (users, sessions, DeviceSession, OAuth, device bootstrap)
│   │
│   ├── auth/              # auth.oxy.so — third-party OAuth authorize/consent IdP
│   │   └── (mounts OxyProvider device-first like every app; a shell, not an RP)
│   │
│   └── accounts/          # "Accounts by Oxy" — keyless, management-only
```

See [architecture/overview.md](./architecture/overview.md) for the full monorepo map, dependency graph, and build order.

### Layer Diagram

```
+-----------------------------------------------------------------+
|                         USER APPLICATIONS                        |
|   Oxy apps (Mention, Homiio, …) + third-party OAuth apps         |
+-----------------------------------------------------------------+
|                                                                  |
|   +-------------------+              +-------------------+       |
|   |  Commons by Oxy   |              |  Oxy SDK          |       |
|   |  (Native App)     |              |  (npm packages)   |       |
|   |                   |              |                    |       |
|   |  - KeyManager     |   signs ->   |  @oxyhq/core      |       |
|   |  - Recovery       |   challenges |  @oxyhq/services  |       |
|   |  - QR approve     |              |  @oxyhq/contracts |       |
|   +---------+---------+              +---------+----------+       |
|             |                                  |                  |
|             |  Public Key                      |  API calls       |
|             |  + Signature                     |  + Bearer tokens |
|             v                                  v                  |
|   +---------------------------------------------------------+    |
|   |                      api.oxy.so                          |    |
|   |                                                          |    |
|   |  - Challenge-Response Auth    - Password Auth            |    |
|   |  - DeviceSession authority    - Social Auth (OAuth)      |    |
|   |  - Device-first transport     - User Linking             |    |
|   |  - OAuth authorize/token      - session_state socket     |    |
|   +----------------------------+-----------------------------+    |
|                                |                                  |
|                                v                                  |
|   +---------------------------------------------------------+    |
|   |                      PostgreSQL                          |    |
|   |  Users, Sessions, DeviceSessions, Applications, Grants   |    |
|   +---------------------------------------------------------+    |
+-----------------------------------------------------------------+
```

---

## Identity System

> **IMPORTANT**: Identity (private key storage) exists ONLY in the Commons by Oxy app.
> The Oxy SDK packages handle authentication but NOT identity storage. The Accounts
> app is keyless and management-only.

### Where Identity Lives

| Component | Identity Storage | Signing | Verification |
|-----------|-----------------|---------|--------------|
| Commons app | KeyManager (expo-secure-store) | Yes | Yes |
| @oxyhq/core | None | No | Yes (SignatureService.verify) |
| api.oxy.so | None | No | Yes (server-side) |

### Cryptographic Primitives

- **Algorithm**: ECDSA secp256k1 (same as Bitcoin/Ethereum)
- **Private Key**: 256-bit (32 bytes), stored in device secure storage
- **Public Key**: Compressed format (33 bytes hex), serves as user identifier
- **Recovery**: BIP39 mnemonic (12 or 24 words)

### Identity Lifecycle

```
1. CREATE IDENTITY (in Commons by Oxy app)
   +--------------------------------------------------------------+
   |  1. Generate ECDSA keypair locally (works offline)           |
   |  2. Store private key in expo-secure-store                   |
   |  3. Generate BIP39 recovery phrase                           |
   |  4. User saves recovery phrase (IMPORTANT!)                  |
   |  5. When online: Register publicKey with api.oxy.so          |
   +--------------------------------------------------------------+

2. AUTHENTICATE (sign in to any app)
   +--------------------------------------------------------------+
   |  1. App requests challenge from api.oxy.so                   |
   |  2. Commons app signs challenge with private key             |
   |  3. Server verifies signature matches registered publicKey   |
   |  4. Server creates session, returns JWT tokens               |
   +--------------------------------------------------------------+

3. TRANSFER TO NEW DEVICE (via recovery phrase)
   +--------------------------------------------------------------+
   |  1. New device: Enter (or scan) recovery phrase              |
   |  2. New device: Restores keypair from recovery phrase        |
   |  3. New device: Can now sign as the same identity            |
   +--------------------------------------------------------------+
```

### Using the Crypto Module

Crypto utilities are exported from `@oxyhq/core`. They handle **signature verification** and **utilities**, NOT key storage:

```typescript
// In Commons by Oxy app (has full KeyManager)
import { KeyManager, SignatureService, RecoveryPhraseService } from '@oxyhq/core';

// Generate identity (only in Commons)
const publicKey = await KeyManager.createIdentity();
const { phrase, words } = await RecoveryPhraseService.generateIdentityWithRecovery();

// Sign challenges (only in Commons)
const signature = await SignatureService.sign(challenge);

// -----------------------------------------------------------------

// In other apps (verification only)
import { SignatureService } from '@oxyhq/core';

// Verify signatures (works anywhere)
const isValid = await SignatureService.verify(message, signature, publicKey);
```

For the DID layer, signed records, and verifiable credentials built on top of
this, see [identity/README.md](./identity/README.md).

---

## Sessions — Device-First Model

Sessions are **device-first**: the browser/device carries a durable device
identity, and the server — not the client — is the authority for which accounts
are signed in on that device. The full reference lives in
[SESSION-ARCHITECTURE.md](./SESSION-ARCHITECTURE.md) and
[auth/device-session.md](./auth/device-session.md); the short version:

### Transport (zero-cookie)

- **`deviceId` + `deviceSecret`** — every successful sign-in (password, 2FA,
  QR claim, challenge verify) returns the session's `deviceId` and a 256-bit
  `deviceSecret`. The client persists both first-party (localStorage per web
  origin; SecureStore on native) — the server stores only
  `sha256(deviceSecret)` (`DeviceSession.secretHash`, sparse-unique).
- **Mint** — to restore or refresh, the client POSTs `{ deviceId,
  deviceSecret }` to `POST /session/device/token` (no bearer, no cookies —
  possession of the secret is the proof) and gets a short access token plus a
  rotated `nextDeviceSecret` (rotation-in-use, 60s grace).
- **No cookie, no refresh-token family, no `#oxy_boot` bootstrap hop** — all
  deleted in the zero-cookie cutover (2026-07-07). A `deviceId` is per web
  origin / per native app-group; there is no implicit cross-subdomain or
  cross-app device sync (the deliberate trade for zero cookies).

### Server authority

- **`DeviceSession`** model (collection `devicesessions`): `deviceId`,
  `accounts[{ accountId, sessionId, authuser, operatedByUserId? }]`,
  `activeAccountId`, `revision`.
- REST: `GET /session/device/state`, `POST /session/device/add`,
  `POST /session/device/switch`, `POST /session/device/signout`.
- Sync: Socket.IO room `device:<deviceId>` (derived from the JWT claim, never
  from the client) emits **`session_state`** with a token-free payload — every
  app on the same device converges instantly on add/switch/sign-out.
- Client: **`SessionClient`** in `@oxyhq/core` (`packages/core/src/session/`)
  consumes the state, projects it for UI, and drives the cold boot
  (`runSessionColdBoot`).

The legacy browser-federation stack (FedCM, silent iframes, top-level SSO
bounce flows, IdP session cookies, per-app callback routes) was **removed
ecosystem-wide** — none of it exists in the codebase or the product anymore.

---

## Authentication Methods

Oxy supports multiple authentication methods that ALL map to the same user account.
The full guide is [AUTHENTICATION.md](./AUTHENTICATION.md).

### 1. Identity (Passwordless, Commons-first)

Primary method using the cryptographic keypair. The phone IS the password.

```tsx
import { OxySignInButton } from '@oxyhq/services';

function LoginScreen() {
  return <OxySignInButton />;
}
```

`OxySignInButton` resolves the app's registered `Application` via
`GET /auth/oauth/client/:clientId`:

- **Official Oxy apps** (`first_party` / `internal` / `system` / `isOfficial`)
  → opens the in-app **`OxyAccountDialog`** (Bloom
  `<Dialog placement={{ base: 'bottom', md: 'center' }}>`): account switcher,
  Commons QR / deep-link sign-in, and a collapsed password form.
- **Third-party apps** (`type: third_party`) → standard **OAuth redirect to
  `auth.oxy.so/authorize` with PKCE** (`generatePkcePair`,
  `generateOAuthState`, `buildOAuthAuthorizeUrl` from `@oxyhq/core`). See
  [auth/integration-guide.md](./auth/integration-guide.md).

**Identity flow** (QR / cross-device):
1. App creates an auth session → gets a secret `sessionToken` + a public QR code
2. User scans the QR with Commons (or the deep link opens Commons on-device)
3. Commons signs the authorization with the private key
4. Server verifies, links the session to the user
5. Original app receives the session (socket/polling)

### 2. Password (Traditional)

For users who prefer traditional login — surfaced inside the same sign-in
dialog under "Sign in without the app":

```typescript
import { OxyServices } from '@oxyhq/core';

const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
const session = await oxy.signIn('user@example.com', 'secret123');
```

**Requirements**:
- User must have set email + password on their account
- Can be added to an existing identity account via account linking

### 3. Third-party OAuth ("Sign in with Oxy")

Apps outside the Oxy ecosystem integrate via standard OAuth 2.0 Authorization
Code + PKCE against `auth.oxy.so`, with a consent screen (`OxyConsentScreen`
from `@oxyhq/services`) and per-app grants revocable from Accounts →
Connected apps. `Application` records carry `privacyPolicyUrl` / `termsUrl`
for the consent surface. Full walkthrough:
[auth/integration-guide.md](./auth/integration-guide.md).

### The IdP is not an RP

`auth.oxy.so` (packages/auth) is the OAuth authorize/consent IdP. It mounts
`OxyProvider` from `@oxyhq/services` device-first like every Oxy app (normal
cold boot from its own `{deviceId, deviceSecret}`, `useDeviceSwitcher`
chooser, `signInWithPassword`/`completeTwoFactorSignIn`/`handleWebSession`
funnels). It stays a SHELL that emits the OAuth code after authenticating —
NOT a Relying Party. Account management lives exclusively on
**accounts.oxy.so**; the IdP's `/settings/*` routes permanently redirect there.

---

## User Linking

Users can have **multiple auth methods** linked to the **same account**.

### Use Cases

1. **Started with password, want identity**: Link publicKey to existing account
2. **Started with identity, want password**: Add email/password to identity account
3. **Social login**: Link Google/Apple/etc. to existing account
4. **Multiple devices**: Same identity on multiple devices (via recovery phrase)

### Linking API

```typescript
// Link identity to existing password account
POST /auth/link
Headers: { Authorization: "Bearer <jwt>" }  // Must be logged in
Body: {
  type: "identity",
  publicKey: "04abc...",
  signature: "...",  // Proof of key ownership
  timestamp: 123456789
}

// Link password to existing identity account
POST /auth/link
Headers: { Authorization: "Bearer <jwt>" }
Body: {
  type: "password",
  email: "user@example.com",
  password: "newpassword123"
}

// Get linked auth methods
GET /auth/methods
Headers: { Authorization: "Bearer <jwt>" }

// Unlink auth method (must keep at least one)
DELETE /auth/link/:type
Headers: { Authorization: "Bearer <jwt>" }
```

### Linking Rules

1. **At least one method required**: Cannot unlink last auth method
2. **Identity is transferable**: Recovery phrase works on any device
3. **Email verification**: Required before linking password
4. **Signature required**: Linking identity requires signed proof

---

## API Reference

Paths below are as mounted in `packages/api/src/server.ts` (no `/api` prefix).

### Authentication

```
POST /auth/register               # Register with publicKey (identity)
POST /auth/signup                 # Register with email/password
POST /auth/login                  # Login with email/password
POST /auth/challenge              # Get challenge for identity auth
POST /auth/verify                 # Verify signed challenge
```

### Device session — transport & authority

```
POST /session/device/token         # Zero-cookie mint: {deviceId, deviceSecret} -> access token + rotated deviceSecret (no bearer, no cookies)
GET  /session/device/state         # Token-free DeviceSessionState for this device
POST /session/device/add           # Add the bearer's account to the device set
POST /session/device/switch        # Set activeAccountId (revision++)
POST /session/device/signout       # Remove one account or all (revision++)
```

### Cross-app sign-in (QR / Commons handoff)

```
POST /auth/session/create                     # Create auth session (QR payload + authorizeCode)
GET  /auth/session/status/:sessionToken       # Poll session status
GET  /auth/session/approve-info/:authorizeCode  # Public Application identity for the approve screen
POST /auth/session/authorize-signed/:authorizeCode  # Key-signed approval from Commons
POST /auth/session/deny/:authorizeCode        # Deny/cancel
```

### OAuth (third party) + linking

```
POST   /auth/oauth/authorize      # Mint single-use authorization code (IdP, Bearer)
POST   /auth/oauth/token          # Code → tokens, RFC 6749 §4.1.3 (PKCE or confidential)
GET    /auth/oauth/userinfo       # OpenID Connect claims for the bearer (GET or POST)
GET    /auth/oauth/consent        # Consent decision for the current user + client
GET    /auth/oauth/client/:clientId  # Public Application metadata
GET    /auth/grants               # Connected apps
DELETE /auth/grants/:applicationId   # Revoke a grant

POST   /auth/link                 # Link new auth method
GET    /auth/methods              # Get linked auth methods
DELETE /auth/link/:type           # Unlink auth method
```

---

## Database Schema

### User Collection

```javascript
{
  // Identity
  _id: ObjectId,
  publicKey: String,           // sparse unique index
  username: String,            // sparse unique index
  email: String,               // sparse unique index

  // Auth
  password: String,            // bcrypt hash, select: false
  twoFactorAuth: {
    enabled: Boolean,
    secret: String,            // TOTP secret, select: false
    backupCodes: [String],     // select: false
    verifiedAt: Date
  },

  // Auth methods tracking
  authMethods: [{
    type: String,              // 'identity' | 'password' | 'google' | etc.
    linkedAt: Date,
    metadata: Mixed            // type-specific data
  }],

  // Profile
  name: { first: String, last: String, displayName: String },  // displayName optional
  bio: String,
  avatar: String,              // file ID
  verified: Boolean,
  language: String,

  // Social
  following: [ObjectId],
  followers: [ObjectId],
  _count: { followers: Number, following: Number },

  // Privacy
  privacySettings: { ... },

  // Timestamps
  createdAt: Date,
  updatedAt: Date
}
```

### Session Collection

```javascript
{
  _id: ObjectId,
  userId: ObjectId,            // ref: User
  deviceId: String,
  deviceName: String,
  deviceFingerprint: String,
  platform: String,            // 'ios' | 'android' | 'web'
  ip: String,
  userAgent: String,
  expiresAt: Date,
  lastActiveAt: Date,
  createdAt: Date
}
```

### DeviceSession Collection (server session authority)

```javascript
{
  _id: ObjectId,
  deviceId: String,            // unique
  accounts: [{
    accountId: ObjectId,       // ref: User
    sessionId: ObjectId,       // ref: Session
    authuser: Number,          // stable per-device slot index
    operatedByUserId: ObjectId // set for managed/org accounts (audit)
  }],
  activeAccountId: ObjectId,   // ref: User, nullable
  secretHash: String,          // sha256 of the current deviceSecret (sparse unique)
  prevSecretHash: String,      // sha256 of the just-superseded secret (short grace window)
  revision: Number             // bumped on every mutation; drives socket sync
}
```

### AuthSession Collection (QR / cross-app flow)

```javascript
{
  _id: ObjectId,
  sessionToken: String,        // unique, short-lived, NEVER in the QR
  status: String,              // 'pending' | 'authorized' | 'expired' | 'cancelled'
  appId: String,
  userId: ObjectId,            // set when authorized
  authorizedSessionId: ObjectId,
  deviceName: String,
  deviceFingerprint: String,
  expiresAt: Date,
  createdAt: Date
}
```

---

## Security

### Private Key Security

- **Never transmitted**: Private keys never leave the device
- **Secure storage**: expo-secure-store (iOS Keychain, Android Keystore)
- **No server storage**: Server only stores public keys

### Challenge-Response

- **Time-limited**: Challenges expire in 5 minutes
- **Single-use**: Challenges marked used after verification
- **Replay protection**: Timestamp included in signed message

### Token & Device Security

- **JWT tokens**: Short-lived access tokens
- **`deviceSecret` rotation-in-use**: each mint via `POST /session/device/token`
  rotates the secret; the just-superseded secret stays valid for a short grace
  window (60s) so a multi-tab race is not locked out
- **Secret never stored raw**: the server stores only `sha256(deviceSecret)`
  (`DeviceSession.secretHash`); a database dump cannot forge the secret
- **Token-free sync**: the `session_state` socket payload never contains tokens
- **Session binding**: Tokens bound to device fingerprint

### Best Practices

1. **Recovery phrase**: Users MUST save their recovery phrase
2. **2FA**: Encourage enabling TOTP 2FA for password accounts
3. **Session management**: Review active sessions in Accounts regularly
4. **Device trust**: Mark trusted devices, alert on new devices

---

## Quick Start

One provider for every platform — Expo, React Native, and web (RN Web):

```tsx
import { OxyProvider, useAuth } from '@oxyhq/services';

function App() {
  return (
    <OxyProvider baseURL="https://api.oxy.so" clientId={process.env.OXY_CLIENT_ID}>
      <YourApp />
    </OxyProvider>
  );
}

function LoginScreen() {
  const { signIn, user, isAuthenticated } = useAuth();

  if (isAuthenticated) {
    return <Text>Welcome, {user?.name?.displayName}</Text>;
  }

  // Cold boot already restored an existing device session silently.
  // signIn() opens the OxyAccountDialog — it never redirects the page.
  return <Button onPress={() => signIn()} title="Sign in with Oxy" />;
}
```

### For Node.js / Backend

```typescript
import { OxyServices } from '@oxyhq/core';
import { createOxyAuthMiddleware, getRequiredOxyUserId } from '@oxyhq/core/server';

const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
app.use('/api', createOxyAuthMiddleware(oxy)); // validates Authorization: Bearer
```

Never hand-roll bearer parsers or auth interceptors — `@oxyhq/core/server`
owns request identity; RP frontends calling their own backend use
`oxyServices.createLinkedClient({ baseURL })`.

---

## Related Documentation

- [SESSION-ARCHITECTURE.md](./SESSION-ARCHITECTURE.md) — device-first session architecture in depth
- [AUTHENTICATION.md](./AUTHENTICATION.md) — auth integration guide (Expo, Web, Node, WebSockets)
- [auth/device-session.md](./auth/device-session.md) — DeviceSession API, socket events, multi-account
- [auth/integration-guide.md](./auth/integration-guide.md) — "Sign in with Oxy" for third-party apps (OAuth + PKCE)
- [identity/README.md](./identity/README.md) — DID documents, signed records, verifiable credentials
- [architecture/oxy-auth-platform.md](./architecture/oxy-auth-platform.md) — the auth platform master plan
