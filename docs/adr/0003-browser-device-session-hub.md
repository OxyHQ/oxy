# ADR 0003 — `auth.oxy.so` becomes the browser's first-party DeviceSession hub

- Status: accepted
- Date: 2026-08-10
- Issue: #937
- Amends: the zero-cookie posture recorded in `AGENTS.md` and
  `docs/SESSION-ARCHITECTURE.md` — read "What this changes about zero-cookie"
  below before touching either.

## Context

Session transport is device-first and, as of the zero-cookie cutover, carries no
cookie of any kind: each origin persists its own `{deviceId, deviceSecret}` and
mints a short access token at `POST /session/device/token`.

That is per **origin**, and deliberately so — it was the accepted trade for
deleting third-party cookies, FedCM, hidden-iframe detection and the `#oxy_boot`
bootstrap hop. The consequence is equally deliberate and now unacceptable at the
product level: **a browser that authenticated on `mention.example` starts signed
out on `mercaria.example`**, because the second origin has no credential of its
own and nothing may read the first one's. Today the user answers that with
another Commons QR scan, per origin.

`auth.oxy.so` cannot close the gap in its current form. It is a static Vite SPA
that authenticates a user, emits the authorization code for the relying party,
and retains nothing — so a later origin arriving at the IdP finds no session
there either and the ceremony repeats.

## Decision

`auth.oxy.so` keeps a **first-party** DeviceSession for the browser profile, and
later official origins join it over ordinary Authorization Code + PKCE.

### The handle

```http
Set-Cookie: __Host-oxy-device=<opaque random handle>; Secure; HttpOnly; SameSite=Lax; Path=/
```

- `__Host-` prefix, therefore **no `Domain` attribute** — the cookie is bound to
  `auth.oxy.so` alone and is not sent to any other `oxy.so` host. This is a
  host-only first-party cookie, not a shared-domain one.
- The value is an **opaque handle and nothing else**: no token, no user id, no
  device id, no account id, no serialized state. The server stores only a
  hash/verifier.
- `HttpOnly`, so no script on the IdP origin can read it; `SameSite=Lax`, so it
  is not sent on cross-site subrequests. **It is never required in a
  third-party context** — every flow that depends on it is a top-level visit or
  a user-opened popup.
- Rotated on sensitive transitions, revocable from the Accounts/Commons security
  UI, and revoked with the DeviceSession.

### Joining a later origin

A new official web app runs Authorization Code + PKCE against the IdP. When the
hub session exists, the IdP resolves the active `DeviceAccountContext`, applies
the existing registry-based trust decision for skipping consent, and issues a
code bound to application, redirect URI, PKCE challenge, scopes, actor, subject
and device context. No QR, no password, no passkey ceremony. When it does not
exist, one Commons-first authentication establishes it, over the same
`AuthSession` model every other delivery surface uses.

### What stays forbidden

Unchanged from the zero-cookie cutover, and not reopened by this ADR:

- third-party cookies;
- hidden or silent iframes for session detection;
- cross-origin `localStorage`;
- Storage Access API as the primary architecture;
- popups created without a user gesture;
- silent `prompt=none` loops (`'none'` stays absent from the `prompt` union);
- FedCM;
- automatic redirect chains across every Oxy origin.

Public/guest-capable apps must not destroy the user's route or unsaved state on
cold boot: they stay guest until the user chooses "Continue with Oxy", or use a
product-approved top-level redirect policy. Popup remains the preferred
interactive transport where the mounted page matters.

### What this changes about zero-cookie

The rule as written — "there is NO cookie, NO refresh-token family, NO bootstrap
hop; never reintroduce any of it" — was one rule covering several mechanisms.
This ADR reopens exactly one of them, at exactly one origin, and the rest stay
deleted. Restated:

- **Relying-party origins remain zero-cookie.** Mention, Mercaria, Syra,
  Console, Accounts, Inbox and every scaffolded app keep
  `{deviceId, deviceSecret}` + `POST /session/device/token` and set no cookie.
- **`auth.oxy.so` alone holds a host-only, HttpOnly, opaque handle**, and only
  in a first-party context.
- **No refresh-token family and no bootstrap hop return.** The cookie is a
  pointer to a server-side DeviceSession, not a credential the browser can
  spend against the resource API.

`AGENTS.md` must be amended in the same PR that lands this, or the repository
will carry a rule that forbids what it also ships. A source-level guard is not
enough: sweep comments, prose and log strings, since nothing recomputes them.

## Alternatives rejected

**A `Domain=.oxy.so` cookie shared across Oxy origins.** It is the smallest
change and it is the one thing the `__Host-` prefix exists to prevent: any
subdomain — including one delegated to a third party — could then read or
overwrite the browser's device handle.

**Per-origin device credentials plus a "sign in again" prompt.** The status quo.
Rejected at product level: the repeated QR scan per origin is the specific
failure this epic exists to remove.

**Storage Access API.** Prompts the user, is implemented inconsistently, and
makes the architecture depend on a permission that can be denied. Available as a
future optimization, never as the mechanism.

## Consequences

- The IdP stops being purely static. It gains the **smallest** server/edge layer
  that can read/set/rotate/revoke the handle, resolve the DeviceSession, run
  authorize/callback/session endpoints, and enforce CSRF/origin/redirect
  constraints. No account management moves there — `accounts.oxy.so` keeps it.
- If that layer is a Cloudflare Pages Function it MUST be a Functions
  *directory*, never an advanced-mode `dist/_worker.js`, and it deploys via
  `bunx wrangler` (npm's Arborist rejects the repo-root `overrides`). That is a
  recorded deploy failure, not a preference.
- CSRF matters again for the cookie-bearing endpoints. Bearer-authenticated
  writes elsewhere are unaffected.
- Test coverage must include: third-party cookies blocked; no hidden iframe
  present; the cookie's exact attribute set; the value being an opaque handle;
  revocation invalidating joined apps per policy; Chrome/Safari/Firefox plus
  private windows; popup success, blocked popup, manual close, timeout,
  malformed message, wrong source/origin/state, and the redirect fallback.
