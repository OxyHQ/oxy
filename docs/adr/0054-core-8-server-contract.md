# ADR 0054 — `@oxy.so/core` 8.0: one server contract, with the right defaults

- Status: proposed. Nothing here ships until it is accepted; `@oxy.so/core`
  7.17.0 adds the opt-in half (below) without changing any default.
- Date: 2026-11-04.
- Context: the Oxy backend integration audit of 2026-11-04 (every product
  backend read at `origin/main`). Apps improvised wherever the SDK had a gap or
  answered the same thing in two shapes, and the improvisations disagreed:
  three of seven apps mapped an Oxy outage to a "no", about thirty hand-built
  per-request clients leaked a cache entry each, and every backend but one
  omitted `serviceIdentity`.

## What 7.17.0 already did (additive)

- `OxyServer.withUser` / `asUser`: an isolated `OxyUserClient` bound to the
  requesting person's bearer, disposed deterministically; the module-wide cache
  sweep no longer pins an empty cache, so an undisposed client cannot leak.
- `accountAccessFor` / `applicationAccessFor` (+ `requireAccountAccess` /
  `requireApplicationAccess`) with one typed outcome, `OxyAccessError`, and one
  mapping: 401 → re-authenticate, 403/404 → a definitive no, anything else →
  503 and never cached. `GET /accounts/:id` carries `callerAccess` for them.
- `OxyServerConfig.expectedAudience`, the default for every `auth()` /
  `service()` mount.
- `createOxyOriginCheck` / `createOxySocketCors`, an asynchronous key lookup for
  capability tickets, per-call `{ timeout, retry, signal }` on file references,
  and a `safeFetch` refusal of a first-party host that says to use `OxyServer`.

## Decision (proposed for 8.0)

1. **One refusal envelope.** Every middleware refusal is
   `{ "error": { "code", "message" } }` (`docs/api-conventions.md`), keeping
   today's codes: `middleware.auth()` (`{ error: 'CODE', message, code }`),
   `requireOxyAuth` (`{ error: 'Unauthorized', message }`), `service()`
   (`{ error: 'Service token required', … }`), the bare-`{ code }` 503s and the
   capability-ticket middleware all move to it. Clients that parse two shapes
   (OxyOS `refusal()`) parse one.
2. **One authority error.** `OxyAppPermissionError` folds into
   `OxyAccessError` (adding its `NOT_CONFIGURED` outcome), and
   `appPermissionErrorStatus` into `accessErrorStatus`, so every caller-authority
   reader fails the same way.
3. **`serviceIdentity` defaults to `'when-anonymous'`** whenever the process
   can produce a service token (workload or credential). Opting out becomes the
   explicit choice; a local checkout with no identity still goes anonymous.
4. **`expectedAudience` defaults to `oxy-service:<applicationId>`** when
   `applicationId` is configured; an app that accepts the legacy `oxy-api`
   audience says so.
5. **No standalone `requireOxyAuth`.** It only works after something else ran
   the optional resolver; `createOxyAuthMiddleware(oxy)` is the one gate.
   `oxy.authSocket()` and other pre-namespace aliases go with it.
6. **Per-call `{ timeout, retry, signal }` on every server namespace method**,
   not only file references, through one options parameter.
7. **`users.getMany` stops hiding failed chunks**: it throws, or is removed in
   favour of `users.lookupMany`, which reports them. `accounts.get` and
   `apps.get` take `{ cache: false }`.
8. **`Application.callerMembership` gets its real type**,
   `ApplicationCallerMembership` (`{ role, permissions, source: 'account',
   ownerAccountId }`, exported since 7.17.0). It is typed `AccountMember`
   today, whose `_id`, `memberUserId`, `inherit` … the API never sends;
   correcting it in a minor breaks consumers that pass it on as an
   `AccountMember` (the Console's `useCallerAccess`).

## Consequences

Each item is a breaking change for some consumer, which is why none is in
7.17.0. Before 8.0 is cut, every backend adopts the 7.17.0 opt-ins (user
clients, access readers, `serviceIdentity`, `expectedAudience`), so the default
flips change nothing for them; the envelope change is announced with the
client parsers that must follow it. Missing typed methods the audit listed
(service-cache and federation uploads, a bounded `assets.readLinked`, a server
`federation.*` namespace, `apps.sendInvitationEmail`, domain verification,
`/platform-infrastructure`, a standalone `verifyAccessToken`, OAuth/MCP
principal permissions, a server entitlement read) are additive and land in 7.x
as each app needs them.
