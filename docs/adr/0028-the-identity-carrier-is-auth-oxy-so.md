# ADR 0028 — The web identity carrier is `auth.oxy.so`; `id.oxy.so` is gone

- Status: accepted
- Date: 2026-09-26
- Decided by: the owner (product direction), recorded here
- Changes: ADR 0024 D1 (the internal holder host `id.oxy.so`, and the gate it
  was to be removed behind) and D2 ("new credentials keep RP ID `oxy.so` until
  the holder moves to `auth.oxy.so`"). D3–D8 are unchanged and still bind.

## Context

ADR 0024 made `auth.oxy.so` the only web entry a person is sent to, but kept the
root-holding code on a separate, minimal origin, `id.oxy.so`, until
`auth.oxy.so` passed a holder gate (no third-party code, strict CSP, a reviewed
dependency graph, a content-addressed release manifest, restricted deploy
authority, a legacy-credential path, a telemetry grace window).

That left two web origins to build, deploy, harden and explain for one account,
with their own UI kit, and an app's sign-in popup opening an origin the person
was never supposed to see. Oxy has had no real users yet, so there is no one to
migrate: the holder can move now, as a clean cut.

## Decision

### D1 — `auth.oxy.so` is the web identity carrier

Everything `id.oxy.so` did runs on `auth.oxy.so`:

- `/continue?user_code=…` — the popup an app opens to sign in or create an
  account with a passkey, then authorize the app's device-flow request. The
  parameter is `user_code`, never `code`: `OxyProvider`'s cold boot on this
  origin reads a `?code=` as an OAuth return and strips it.
- `/identity` (and `/identity/move`) — saving or showing the recovery phrase,
  recovery, securing a legacy account, the move to Commons, account deletion.
- `/prf-check` — the local PRF diagnostic.

The holder logic lives in `packages/auth/lib/identity/` and runs on its own
`OxyServices` client with an in-memory bearer, never on the origin's
`OxyProvider` session. It does NOT move into `@oxy.so/services`: every app
bundles that package, and root-handling code has no business in them. The
screens are built from the SDK's sign-in shell (`OxyAuthScreen`,
`OxyAuthScreenHeader`) and Bloom, like the IdP's other pages.

The API serves the holder routes (the web envelope, recovery, the move) to
`auth.oxy.so` and loopback only (`getAuthWebOrigin()`, `AUTH_WEB_ORIGIN`). Core
exports `AUTH_WEB_ORIGIN`; `IDENTITY_WEB_ORIGIN` is deleted, and the account
dialog's controller option is `authOrigin`.

### D2 — The holder policy is `auth.oxy.so`'s policy

`auth.oxy.so` is built with `sensitive: true`, which now means the whole holder
policy: no third-party measurement (the Cloudflare beacon stripped from the CSP
and refused by `no-transform`), `base-uri` and `form-action 'none'`,
`Referrer-Policy: no-referrer`, a `Permissions-Policy` allowing passkeys for
this origin only with every other powerful feature off, and
`Cross-Origin-Resource-Policy: same-origin`. Never `Cross-Origin-Opener-Policy`:
the identity window reports back to its opener. The origin loads no product
analytics (guarded by `sensitive-origin.test.ts` and the post-deploy smoke).

`style-src 'unsafe-inline'` stays: react-native-web writes its stylesheet at
runtime. That, the full SDK graph and the Pages project's second hostname
(`oxy-auth.pages.dev`, which cannot assert an `oxy.so` passkey) are the known
differences from the old holder host, accepted with this decision.

### D3 — Passkeys stay on RP ID `oxy.so`

Every credential, old and new, is scoped to `oxy.so`, which `auth.oxy.so`
asserts natively. The move changes no wrap and strands no envelope: the PRF
output depends on the credential and the salt, not the origin, and the server
copy of the envelope is authoritative (IndexedDB holds only a ciphertext cache,
now on `auth.oxy.so`).

### D4 — `id.oxy.so` is deleted

`packages/id`, its Worker, its CI suite and its deploy job are removed. The
"Oxy Identity" application that made `id.oxy.so` a trusted first-party origin
is deleted by migration `0107_retire_oxy_identity_app`. The custom domain is
removed from Cloudflare by hand. No redirect is kept.

## Consequences

- One web origin for sign-in, consent, account creation and the identity.
- The holder is only as strong as `auth.oxy.so`: anything added to it (a
  dependency, a script, a connect source) is added to the page that opens roots.
  Review it that way.
- `docs/identity/holders-and-recovery.md` is the inventory; "holder host" there
  now means `auth.oxy.so`.
