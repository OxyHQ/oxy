# Authentication

## Overview

Oxy authentication is **device-first and zero-cookie**. A short-lived access token authorizes each request (bearer). The durable session transport is a first-party `{ deviceId, deviceSecret }` pair the client persists **per origin** (web `localStorage`, native SecureStore); the client mints a fresh access token by presenting that pair to the API. The `DeviceSession` document is the server-side session authority.

There is **no session cookie of any kind** — no `oxy_device` cookie, no refresh-token family, no `#oxy_boot` bootstrap, no FedCM, no `/sso` bounce. All of that legacy browser-federation machinery was removed.

## Token / credential types

| Credential | Lifetime | Storage | Validation |
|-------|----------|---------|------------|
| Access token | Short-lived | Memory / `Authorization: Bearer` header | Server-side session check |
| Device secret | Stable on mint; rotates on sign-in (short grace for the prior hash) | First-party per-origin (localStorage / SecureStore) | `sha256` match against `DeviceSession.secretHash` (constant-time) |
| Service token | 1 hour | Memory (cached) | Stateless JWT signature verification |

The device secret is the SOLE restore credential; possession of it proves device ownership. Only its `sha256` hash is stored server-side, so a database dump cannot forge it.

## Authentication flow

### 1. Sign in

```
Client -> POST /auth/login { username, password }   (2FA / signup / social variants exist)
Server -> { accessToken, expiresAt, user, deviceSecret }
```

The response carries a fresh `deviceSecret` (device-first lanes only). The client persists `{ deviceId, deviceSecret }` first-party.

### 2. Authenticated request

```
Client -> GET /protected
          Authorization: Bearer <accessToken>
Server -> validate session -> 200 OK
```

### 3. Restore / re-mint (replaces refresh-token flow)

When the short access token expires — or on cold boot / page reload — the client mints a new one with a single bearer-less, cookie-less POST:

```
Client -> POST /session/device/token { deviceId, deviceSecret }
Server -> { accessToken, expiresAt, nextDeviceSecret, state }
```

The mint echoes the proven secret as `nextDeviceSecret` (stable — multiple origins sharing one device can refresh concurrently). Persist `nextDeviceSecret` **before** using the returned access token so a reload never diverges from the server. Sign-in rotates the secret in-use (the prior hash stays valid for a short grace). The SDK cold boot (`runSessionColdBoot` in `@oxyhq/core`) owns this end to end — apps never implement local session restore.

## CSRF

With no ambient session cookie, state-changing requests are authenticated by the bearer access token and are **not** vulnerable to CSRF; bearer-authenticated writes do not fetch a CSRF token. CSRF protection (double-submit) remains only for any residual cookie-credentialed, cookie-only write paths.

## Auth middleware (`@oxyhq/core/server`)

Backends use the shared helpers — never app-local `AuthRequest` / `requireAuth` / bearer parsers.

```typescript
import { createOxyAuthMiddleware, createOptionalOxyAuth, getRequiredOxyUserId } from '@oxyhq/core/server';

// Require authentication
app.use('/api/protected', createOxyAuthMiddleware(oxy));

// Optional auth (attach user if present, don't block)
app.use('/api/public', createOptionalOxyAuth(oxy));

// Inside a protected handler:
const userId = getRequiredOxyUserId(req);
```

### Request properties set by middleware

| Property | Type | Description |
|----------|------|-------------|
| `req.userId` | `string \| null` | User ID from token |
| `req.user` | `User \| null` | User object (minimal unless full profile requested) |
| `req.accessToken` | `string` | The validated access token |
| `req.sessionId` | `string \| undefined` | Session ID (if session-based token) |
| `req.serviceApp` | `ServiceApp \| undefined` | Service app metadata (if service token) |

## Socket.IO authentication

Use the shared socket authenticator — derive rooms from `socket.user.id`, never from client-supplied ids, and ownership-check before joins.

```typescript
import { authSocket } from '@oxyhq/core/server';

// Server
io.use(oxy.authSocket());
io.on('connection', (socket) => {
  socket.join(`user:${socket.user.id}`); // room derived server-side
});

// Client
const socket = io('https://api.oxy.so', { auth: { token: accessToken } });
```

## Rate limiting

| Limiter | Window | Max | Scope |
|---------|--------|-----|-------|
| General | 15 min | 1000 | Per IP (`rl:general:`) |
| Auth | 15 min | 300 | Per IP (`rl:auth:`) |
| User | 15 min | 200 | Per user ID (`rl:user:`) |
| Device-token mint | 60 s | 30 | Per deviceId (`rl:session:device-token:`) + per-device lockout |

All rate limiters use `rate-limit-redis` over a shared client with a **unique prefix per limiter** (a shared key would double-count and halve the budget). Falls back to in-memory when `REDIS_URL` is unset.

## Security headers (Helmet)

| Header | Value |
|--------|-------|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` |
| `Content-Security-Policy` | `default-src 'self'; frame-ancestors 'none'` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Content-Type-Options` | `nosniff` |
