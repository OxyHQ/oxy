# Oxy authentication — canonical entry

Start here. Where any other page disagrees with this tree, this tree wins; where
this tree disagrees with the code, the code wins and the page is a bug.

Authentication documentation used to live in several places that each described
a different year — root docs, package READMEs, wiki copies, and plan documents
written before the thing they planned existed. Some promised sign-in-once
behaviour while others documented, correctly, that a new origin starts signed
out. This page exists so there is one place that is answerable for being right.

## The model in five nouns

An **identity** is a cryptographic human identity controlled by its owner's root key, held in Commons ([ADR 0024](../adr/0024-one-oxy-account-root-holders.md)); an account without a key has no identity root and signs in by email ([ADR 0030](../adr/0030-email-code-password-authenticator.md)).
A **principal** is a human who has authenticated onto one device or browser
profile. An **account** is the subject an application acts as. A **device
session** is the server's record of one device, its principals, and their
contexts. A **device account context** is one principal acting as one account —
the globally switchable unit, and the thing `contextId` names.

Full definitions, the reason the pair rather than the account is the unit, and
the five distinct meanings of "sign out":
[principals-and-account-contexts.md](./principals-and-account-contexts.md).

## What is built

| Area | Page | State |
|---|---|---|
| Device session, device-first transport | [device-session.md](./device-session.md) | shipped |
| Principals, contexts, the directory | [principals-and-account-contexts.md](./principals-and-account-contexts.md) | shipped |
| Tokens and credentials (v2 claims) | [tokens-and-credentials.md](./tokens-and-credentials.md) | shipped |
| Third-party integration | [integration-guide.md](./integration-guide.md) | shipped |
| The IdP's own shape | [README.md](./README.md) | shipped |
| The native cross-app device credential | [../SESSION-ARCHITECTURE.md](../SESSION-ARCHITECTURE.md) § Cold boot | built, not verified on a device |
| The account switcher on the directory | [principals-and-account-contexts.md](./principals-and-account-contexts.md) | shipped |

## Why it is shaped this way

The decisions, each with the alternatives that were rejected and why — read
these before proposing a change to the model:

- [ADR 0001 — a device holds principals, and principals hold account contexts](../adr/0001-multi-principal-device-model.md)
- [ADR 0002 — one globally active context, activated through one endpoint](../adr/0002-global-account-context.md)
- [ADR 0003 — the browser DeviceSession hub](../adr/0003-browser-device-session-hub.md) (superseded: never deployed, deleted)
- [ADR 0004 — one headless `OxyRuntime` behind one public `OxyProvider`](../adr/0004-single-oxy-runtime-provider.md)
- [ADR 0024 — one Oxy account: `auth.oxy.so` is the web entry, the root lives in user-controlled holders](../adr/0024-one-oxy-account-root-holders.md)
- [ADR 0029 — one Oxy session: the dialog in every app, one browser session](../adr/0029-one-oxy-session.md)
- [ADR 0030 — email, code, password and authenticator; passkeys removed](../adr/0030-email-code-password-authenticator.md)

## What is NOT built yet

Stated here rather than left for a reader to infer from silence. Each is an
accepted gap with a named reason, not an oversight:

- **An account without a key signs in by email** ([ADR 0030](../adr/0030-email-code-password-authenticator.md),
  changing 0029 D1/D3): a 6-digit code or a link (which approves only the
  browser that asked), an optional password and an optional authenticator, all
  inside every app's dialog; there is no passkey and no web identity carrier.
  Sign-up, deletion and linking Commons are services panels, confirmed with an
  emailed code. Commons is the self-custody way. The accepted differences of
  `auth.oxy.so` from a minimal host — the full SDK graph,
  `style-src 'unsafe-inline'` for react-native-web, no release manifest yet —
  are listed in ADR 0028.
  Inventory, invariants and open items: [holders-and-recovery.md](../identity/holders-and-recovery.md).

- **The native shared DeviceSession credential is BUILT and UNVERIFIED ON A
  DEVICE.** A sibling official app's `deviceId` + `deviceSecret` now lives in a
  dedicated cross-app slot — its own `keychainService` inside the approved access
  group on iOS, a signature-protected `OxyDeviceSession` broker on Android — and
  the cold boot's `shared-device-adopt` step joins it before falling back to
  `shared-key-signin`. That is what separates the self-custody identity key from
  ordinary session transport: an ordinary app never needs identity-key access.

  **What has not happened is a device run.** There is no gradle job in CI, the
  Kotlin is not compiled here, and a real ContentProvider needs an instrumented
  test — so the Android and manifest invariants are held by source-level gates
  that run on every `bun run test` instead, each mutation-tested. Those gates
  read source; they cannot tell you the broker answers on a phone.

  Deliberately still out of scope: the identity vault is excluded from both the
  mirror and the adoption (a background persist inside the vault must not decide
  which session five other apps boot into), and `shared-key-signin` is retained
  as the last-resort recovery lane for devices where nothing has published a
  credential yet.
- **Third-party OAuth token exchange still returns `deviceId`/`deviceSecret` from
  the API.** The client half landed: `exchangeOAuthCode` no longer REQUIRES the
  pair, and a device-less grant boots, runs and expires correctly (its lifetime
  is the access token — the zero-cookie mint lane's whole proof is possession of
  a `deviceSecret`, so there is nothing to re-mint from and the 401 lane ends it
  loudly). The server still sends both fields, because removing them breaks
  external integrators pinned to older `@oxy.so/core` and needs an announced
  cutover. The credential is for the client's own isolated per-`(user, client)`
  device, never the shared one, so the global-credential hole is already closed.
  Tracked in #954, with the reasoning at the call site.

## Rules that keep biting

- `contextId` is **not stable across a removal** — a removed-but-still-reachable
  pair comes back under a new id at an unchanged revision. Never persist one.
- Switchability is `available` alone. `available || onDevice` is wrong in both
  directions: it hides organizations the person has not used on this device yet,
  and offers rows the server refuses and heals away.
- `available` folds in principal liveness: a principal whose own personal
  session has died makes **every** context of theirs unavailable, delegated ones
  with live sessions included.
- Commons (`sessionMode: 'identity'`) never follows the switch and never gains a
  switcher. `switchToAccount` / `switchSession` throw there.

## Historical plans

`docs/architecture/` holds design documents that predate the current model —
including a transport proposal and an audit written before this work. They are
kept for provenance and are **not** current. Read them as history, and read the
ADRs above for what was actually decided.
