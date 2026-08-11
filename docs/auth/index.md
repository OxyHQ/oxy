# Oxy authentication — canonical entry

Start here. Where any other page disagrees with this tree, this tree wins; where
this tree disagrees with the code, the code wins and the page is a bug.

Authentication documentation used to live in several places that each described
a different year — root docs, package READMEs, wiki copies, and plan documents
written before the thing they planned existed. Some promised sign-in-once
behaviour while others documented, correctly, that a new origin starts signed
out. This page exists so there is one place that is answerable for being right.

## The model in five nouns

An **identity** is a cryptographic human identity controlled by a Commons key.
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
| Device session, zero-cookie transport | [device-session.md](./device-session.md) | shipped |
| Principals, contexts, the directory | [principals-and-account-contexts.md](./principals-and-account-contexts.md) | shipped |
| Tokens and credentials (v2 claims) | [tokens-and-credentials.md](./tokens-and-credentials.md) | shipped |
| Third-party integration | [integration-guide.md](./integration-guide.md) | shipped |
| The IdP's own shape | [README.md](./README.md) | shipped |

## Why it is shaped this way

The decisions, each with the alternatives that were rejected and why — read
these before proposing a change to the model:

- [ADR 0001 — a device holds principals, and principals hold account contexts](../adr/0001-multi-principal-device-model.md)
- [ADR 0002 — one globally active context, activated through one endpoint](../adr/0002-global-account-context.md)
- [ADR 0003 — `auth.oxy.so` becomes the browser's first-party DeviceSession hub](../adr/0003-browser-device-session-hub.md)
- [ADR 0004 — one headless `OxyRuntime` behind one public `OxyProvider`](../adr/0004-single-oxy-runtime-provider.md)

## What is NOT built yet

Stated here rather than left for a reader to infer from silence. Each is an
accepted gap with a named reason, not an oversight:

- **ADR 0003's browser hub is a decision, not a deployment.** `auth.oxy.so` is
  still a pure-static SPA and sets no cookie. Until it does, a new web origin
  cold-boots signed out and joins by its own device credential — the accepted
  trade of the zero-cookie cutover. **Relying-party origins remain zero-cookie
  regardless**; the host-only handle ADR 0003 describes is for the IdP alone,
  and `AGENTS.md` must be amended in the same change that ships it.
- **The native shared DeviceSession credential is not built.** Ordinary apps
  still restore through the paths `device-session.md` describes. Separating the
  Commons private key from the ordinary cross-app session credential rewrites
  keystore slot layout, where the failure mode is permanent, unrecoverable
  identity loss — it needs real device verification, not reasoning.
- **Third-party OAuth token exchange still returns `deviceId`/`deviceSecret`.**
  The credential is for the client's own isolated per-`(user, client)` device,
  never the shared one, so the global-credential hole is closed; omitting the
  pair outright needs a `@oxyhq/core` release and an announced cutover. Tracked
  in #954, with the reasoning at the call site.

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
