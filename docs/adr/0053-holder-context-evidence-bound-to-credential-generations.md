# ADR 0053 — Holder-context evidence is bound to one installation of the bearer

- Status: accepted; the server flag ships OFF and every consumer flag ships OFF.
- Date: 2026-11-03.
- Issues: OxyHQ/oxy#2066 (server) and #2067 (SDK transport); Mention #1741 and #1742.
- Builds on: ADR 0001 (multi-principal device), 0002 (account context), 0029 (one Oxy
  session), 0041 (supervised personal policy), 0049 (first-party authority).
- Related: `docs/auth/live-session-authority.md` (the budgets this endpoint copies).

## Context

A UI action (a notification confirmation, a collaboration sheet, a publication
continuation) is opened for viewer A. Before it is dispatched the shared device
can switch to B, the access token can refresh, another tab can plant a token, or
the session can be restored. Mention fences the effective subject today
(`X-Mention-Expected-Viewer`, compared with the subject Oxy authenticated, and a
session-epoch fence on the client). That cannot prove which account, actor and
context a bearer belongs to BEFORE the request is sent, and it cannot tell the
bearer the UI saw from the bearer an asynchronous auth preflight selected.

## Threat model

In scope: a stale or racing client dispatching with a bearer that is not the one
its viewer intent was captured under (account switch, actor/context switch,
refresh, cross-tab write, restore, A to B to A with identical bytes, a response to
the evidence request that arrives after the bearer changed).

Out of scope, and stated so nobody relies on it:

- Evidence is a point-in-time observation. It is not a lease, a scope, a
  permission or an authorization; every product handler keeps its own checks.
- A request already dispatched cannot be recalled.
- A compromised client holding the bearer and the holder secret can ask for its own
  evidence; evidence exposes identifiers only and grants nothing.
- Sign-in is untouched. The endpoint needs an existing valid bearer plus the holder
  secret of that bearer's own device, so it cannot be used to learn whether an
  account exists (AGENTS.md sign-in rule). An invalid or missing bearer is `401
  invalid_bearer` before any account lookup.

## Decision

### 1. Server: `POST /session/device/context-evidence-v1`

Request: `Authorization: Bearer <installed bearer>` and body `{deviceId,
deviceSecret}` (the existing holder credential; nothing new is minted). In one
database statement on a writable primary it observes the active context of that
device, the holder credential and the exact stored bearer, and returns identifiers
and expiry: `{version, deviceId, deviceSessionId, revision, contextId, actorId,
accountId, sessionId, expiresAt}`. No bearer, no secret, no scopes.

Supported lane: a first-party v2 personal session whose actor, subject and
validated principal session coincide. Delegated (organization/operator), OAuth and
legacy bearers are `403 unsupported_bearer`; a valid bearer whose holder or
active binding does not match is `409 binding_unavailable`; a missing or invalid
bearer is `401 invalid_bearer`; supervised policy that cannot be evaluated, a
replica, Redis or the database being unavailable, or the flag being off is `503
evidence_unavailable`; over budget is `429`. `Cache-Control: no-store` always.
None of these is a revocation verdict.

It is OFF by default and has its OWN budgets, independent of live-session
authorization, all required before it answers (`security.ts`, fail closed on any
missing, malformed or over-maximum value and on Redis being unavailable):

| Variable | Value |
| --- | --- |
| `OXY_HOLDER_EVIDENCE_ENABLED` | `true` |
| `OXY_HOLDER_EVIDENCE_SUBJECT_PER_MINUTE` | integer 1 to 60 |
| `OXY_HOLDER_EVIDENCE_IP_PER_MINUTE` | integer 1 to 300 |
| `OXY_HOLDER_EVIDENCE_GLOBAL_PER_MINUTE` | integer 1 to 600 |

Order: subject budget, address budget (hashed address, never stored raw), bearer
signature check (attribution only), global budget, then the route. A forged or
missing bearer never spends the global budget.

### 2. SDK: one credential generation, swapped by every write path

`@oxy.so/core` `TokenStore` owns an immutable, opaque `CredentialGeneration` and
replaces it in `setTokens`, `clearTokens` and on every access-token-provider
change. There is no other place that writes the bearer, so a setter, a refresh, an
account or actor switch, a cross-tab or restored token, `clear()`/sign-out, the
401-driven clear, and a repeated write of identical bytes all produce a new
generation. A to B to A is three generations.

`RequestOptions.expectedCredentialGeneration` (writes only) makes the transport
check the generation, on the source client that owns the bearer: on entry, after
the async auth preflight, after queueing, in the same synchronous segment that
selects the `Authorization` header, after the response and after the body is read.
A mismatch rejects with `OxyAuthenticationError` code `AUTH_SESSION_CHANGED`.
Such a request has no cache, deduplication or retry, and a 401 neither refreshes
nor clears the session. A pull-only access-token provider on the source cannot
observe A to B to A between reads, so it is never given a generation.

`oxy.session.observeHolderEvidence()` ties the two together: capture the
generation and the bearer synchronously, read the holder credential from the
provider the `OxyProvider` already installs (web, device lane), send the request
pinned to that generation, validate the answer with the contracts check, and then
in one synchronous commit require (a) the generation is still current and (b) the
answer agrees with the claims of the captured bearer (account, session, device
and, when present, actor and context). Anything else is `unavailable` with a
reason (`no_credential`, `no_holder`, `changed`, `unsupported`,
`binding_unavailable`, `unavailable`). Concurrent callers share one request per
generation (a `WeakMap` keyed by the generation); a refusal is remembered for five
seconds per generation. `isHolderEvidenceCurrent(evidence)` is the generation
being current and the expiry not passed. Native has no device credential provider
installed, so it reports `no_holder` and keeps today's behavior.

### 3. Consumer rule (Mention is the first)

Evidence is an ADDITIONAL check. A consumer behind its own flag may:

1. when the intent is captured, start `observeHolderEvidence()`;
2. when the answer names another account than the intent's viewer, refuse the
   action as "viewer changed";
3. when it is proven, pin the dispatched write to the evidence generation. If the
   bearer was replaced since the intent, re-observe and continue ONLY if the new
   evidence names the identical device, context, actor, account and session (a
   same-account refresh); a different identity refuses the action;
4. when evidence is `unavailable` for any reason, do exactly what the consumer did
   before. Unavailable evidence never blocks an action, never signs anyone out,
   never refreshes or clears a credential and never becomes a weaker check than
   the existing epoch and expected-viewer fences.

Mention: `EXPO_PUBLIC_VIEWER_EVIDENCE=true` at build time (default off) enables
this for notification actions, collaboration invites and as a contradiction check
on publication/reply/draft continuations. Publication requests themselves are not
yet pinned to a generation (their transport is several layers below the store);
the continuation only refuses to proceed on a contradiction.

## Closed blockers (from the draft PRs)

| Blocker | Closed by |
| --- | --- |
| Evidence bound atomically to the exact bearer across refresh, setters, switches, cross-tab, restore | Generation owned by `TokenStore`; commit-time check in `observeHolderEvidence`; tests for same bytes, refresh, A-B-A, logout/login in flight |
| #2067 not connected to #2066 | `observeHolderEvidence` uses the pinned transport against the endpoint |
| Permission lanes | Only first-party v2 personal; everything else a named non-answer the consumer degrades on |
| Failure behavior | Status table above; no outcome clears, refreshes or mints |
| Capacity | Own budgets, all required; SDK single-flight per generation and refusal memory; sizing below |
| Deployment and rollback | Order and rollback below |
| Integration tests | Real Postgres holder state, real Redis and HTTP route, run locally and in CI |

Not closed: native (no provider; reports `no_holder`), delegated and supervised
contexts (need their own authority contract), pinning of publication requests.

## Capacity

One request per installed bearer per client that opens an intent while the flag is
on, so at most one per access-token lifetime per tab (about every 15 minutes) and
only after a user opens a confirmation, a menu or starts a publication. Starting
values for the first enablement: subject 6, address 60, global 120 per minute,
raised only after the metrics below show headroom. The request is one indexed
statement plus a live-session validation (which reads the writable primary).

## Rollout (nothing is enabled by merging)

1. Deploy the Oxy API with no `OXY_HOLDER_EVIDENCE_*` variables. The route answers
   `503 evidence_unavailable`; the OpenAPI document lists it.
2. Publish `@oxy.so/contracts` and `@oxy.so/core` (merge of the version bump).
3. Ship Mention with `EXPO_PUBLIC_VIEWER_EVIDENCE` unset. Behavior is unchanged.
4. Set the four API variables on the API task definition (budgets first), deploy,
   and check `POST /session/device/context-evidence-v1` from a test device returns
   200 with a personal session, 403 for an organization context and 409 for a
   wrong holder secret. Watch the 429 and 503 rates and the database latency.
5. Build the Mention frontend with `EXPO_PUBLIC_VIEWER_EVIDENCE=true`, deploy web,
   then the native builds (native keeps degrading to today's behavior).

## Rollback (fastest first)

1. Remove `OXY_HOLDER_EVIDENCE_ENABLED` (or any budget variable) from the API task
   definition and redeploy: every client sees `unavailable` and falls back to the
   expected-viewer and epoch fences. No client change is needed and no user
   action is blocked.
2. Rebuild Mention without `EXPO_PUBLIC_VIEWER_EVIDENCE`.
3. The contracts, core and API additions are inert when unused and need not be
   reverted; do not unpublish.
