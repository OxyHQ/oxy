# Exact credential revision experiment

Investigation only; do not release, use as authority, or activate in Mention.
This branch is independent of Oxy #2066 and is based on Oxy main `93a3f09c1`.
It does not call, enable, or consume that endpoint. No credentials are real.

## Motivation

The #2066 response, when supported and enabled, is a point-in-time server
observation of the exact bearer and current holder; it is not a lease, an
authorization grant, a scope assertion, or proof that the SDK's UI projection
has caught up. An endpoint response must be rejected when the local bearer was
replaced during its request, including A→B→A with identical final bytes. A
later linked request must send the same captured revision, not whatever the
linked auth preflight happens to select.

The separate `evidence-preflight-probe.ts` in the Mention investigation uses
the real linked client and simulated transport: a modeled observation for A1
precedes an awaited refresh; the unmodified linked client dispatches A2 while
the session epoch is unchanged. It does not execute #2066.

## Prototype scope

Core creates an opaque, per-instance local bearer revision on every setter,
clear, provider installation and direct internal 401 clear, including repeated
identical bytes. It supplies capture and current checks that expose no bearer.
The revision proves only local sequencing; it says nothing about account,
device, permissions, token validity or server evidence. A pull-only source is
excluded because it can change A→B→A between reads without notifying Core.

An explicit `expectedCredentialRevision` opts a write into checks against the
source. Checks run on entry, after async auth preflight, after queue waiting,
in the synchronous dispatch segment against the header actually selected,
and after response/body processing. The source check happens in the transport
that selects the bearer; a check in the app before calling it is insufficient.
The option disables cache, deduplication and retries for this experiment.
Guarded 401 responses do not refresh or clear the source: they are reported to
the caller. This is specific to opt-in calls; ordinary calls retain their
existing behavior.

For a possible future evidence acquisition, a source request can use the same
revision option to check that the request and response correspond to one local
revision. A caller would still need to validate the authority response and
check the revision in the *same synchronous commit* that associates it with
the matching projected identity. The prototype has no such association and
allows a revision to be captured for an invalid or expired token.

Every setter invalidates the previous revision, including a legitimate refresh
for the same account. A new revision can be captured immediately, but cannot
be treated as evidenced without a new authoritative response. Pending
confirmations and operations fail conservatively; an app must present
appropriate retry feedback and must not silently pretend the write succeeded.
Whether it is possible to preserve an intent over a refresh needs a separate
server-evidenced continuity and scope policy, with CAS on all concurrent
setters. #2066 alone does not establish equal scopes.

## Validation and outstanding work

`bun run test --runInBand --runTestsByPath
src/__tests__/linkedCredentialRevision.experimental.test.ts
src/__tests__/httpActorContextFence.test.ts
src/__tests__/httpServiceAbort.test.ts` passed 43 tests on the working tree.
They include synthetic delayed refresh, queued writes, stale success/failure and delayed response bodies,
same-byte setter, ABA, logout/relogin, reentrant listeners, unsupported
pull-only sources and a simulated evidence 401; no endpoint was contacted.
Biome passed on the changed files. A package typecheck could not finish with
the filtered install because the workspace dependencies were not built.

This is not a finished API: add an identity-proof/projection transaction,
authority response verification and expiration policy; exact 409/429/503,
offline and unsupported-lane behavior; full cancellation, 401 and error-body
races; linked provider lifecycle; native XHR; cache/dedupe/raw transports if
needed; same-account refresh continuity; packaging and end-to-end tests. The
experimental endpoint supports neither OAuth nor delegated/legacy contexts and
is disabled by default. Refusing every unproved action would break valid
sessions; falling back to an ID/epoch would restore the original race. Neither
is an acceptable universal rollout.

The server observation may become stale immediately after it returns. The
prototype cannot establish instantaneous remote-device state, authorize a
server mutation or recall one already dispatched. Per-request server-side
authority and the existing product authorization remain necessary.
