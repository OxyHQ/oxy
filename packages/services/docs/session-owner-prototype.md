# Session owner prototype - not exported

This experiment checks whether work still belongs to the authenticated account
and Core client that created it. It is not a production API or an authorization
check. It does not cancel a request, reverse a remote write, or make an async
check remain true after an `await`; a caller must check immediately before each
effect and again after each wait. Guest work is outside its scope.

The hook observes primitive snapshots of the Core session epoch, token presence,
bearer subject, runtime subject generation and account id. It retains no token.
It checks the runtime actually owns that client and refuses known subject
mismatches. Consumers must choose between `require-match`, which fails closed
for opaque and sub-only tokens, and `allow-unknown`, which preserves those
tokens but cannot establish their owner. Core's subject getter recognizes only
`userId` and `id`.

The runtime generation advances synchronously whenever its account fact changes,
including intermediate changes inside a batch. Thus A -> B -> A invalidates a
previous owner before subscribers run, even if the published snapshot is still
A. Updating profile data for the same account and a same-session token refresh
do not invalidate it. Runtime changes to another delegated principal or context
while the account remains the same need separate review; this prototype does not
claim to fence those transitions.

The current prototype also has deliberately failing regression tests for an
external `accessTokenProvider`: it can change A to B without changing the stored
bearer or epoch. Calling `getSessionEpoch()` does not synchronize that provider.
Even an indicator of whether a provider is currently installed is insufficient:
installing and removing a provider can hide a transition. Do not use or export
the prototype until Core exposes a safe, reviewed way to detect that condition.

The runtime generation cannot detect an independent app-local projection that
changes without updating the runtime. React may run a child ref cleanup before
the hook's insertion effect when that local projection changes; the test suite
characterizes this case and shows the old callback can still return true. The
returned guard becomes inactive after insertion-effect cleanup on unmount, not
at the start of every possible React commit. A render abandoned by React does not
publish a new owner, and no owner is active during server rendering. The test
renderer is not a physical React Native device test. See React's
[`useInsertionEffect` caveats](https://react.dev/reference/react/useInsertionEffect).

## Blocking Core compatibility issue

The Services peer currently accepts Core 7.9.0. Real Core 7.9.0 leaves its epoch
unchanged after the 401 clear path: A -> 401 -> empty -> a new A session can
make an old guard appear current. An unknown-subject B can do the same under the
compatible policy. A delayed A 401 can also clear B, or retry A's request under
B, irrespective of this hook. Core 7.9.1 corrects those HTTP paths, but it has
no runtime capability marker that distinguishes it from 7.9.0.

One option is a future Core capability reported by the exact HttpService
instance, narrowly certifying installed-bearer epoch invalidation, together with
a separate way to reject instances with an externally supplied bearer. The hook
would fail closed if either guarantee is unavailable. That avoids silently
accepting an unsafe peer without changing Services' global peer range. Such APIs
need their own release and cross-version tests. This prototype does not implement
them and must not be exported or described as safe for all supported versions.

## External provider investigation

An application-owned observable wrapper alone cannot prove which provider the
HTTP client will use. The existing `setAccessTokenProvider` can replace the
wrapper without advancing the installed bearer epoch or notifying its observers.
`providerSnapshotAudit.test.ts` captures an account-A snapshot from such a
wrapper, replaces the HTTP provider with one returning B, and demonstrates
that the old check passes immediately before an actual request is sent as B.
The epoch changes only when the request synchronizes the provider, too late for
that preceding check. An A -> B -> A transition hidden between reads cannot be
detected by comparing only current subjects or bearer values.

`createLinkedClient` is a narrower, observable case: it subscribes to the root
client's token events and uses that root as its provider. The audit checks an
earlier root listener during A -> B, before the linked client receives its own
update. The root epoch has already changed, so a guard bound to the root client
rejects old work even while the linked copy still holds A. This demonstrates
that wiring, not arbitrary provider safety. The root itself may be configured
with a silent external provider, and consumers must still fence the work they
send through the linked client.

A future SDK-owned provider API could make a stronger snapshot possible if it:

1. Binds provider installation, replacement and removal to the exact HTTP
   client, with a monotonic generation invalidated before any observer can run.
2. Requires an atomic, non-secret snapshot with a monotonic provider generation
   and explicit signed-out state, plus subscription. Every transition must
   advance it, including A -> B -> A without an intervening read. The API must
   specify initialization, errors, missed notifications and disposal.
3. Makes the effective provider and its snapshot inseparable from HTTP sending;
   a snapshot of some other wrapper is not evidence of the bearer actually used.
4. Offers a synchronous check usable immediately before each effect, including
   after awaits. React subscriptions must use stable primitive snapshots and
   must not synchronize or mutate tokens while rendering.
5. Fails closed when provider state, generation or subject cannot be verified;
   any compatibility mode for unknown subjects must remain an explicit choice.

Such a design would need adversarial tests for replacement/removal, silent or
throwing providers, initial absence, refresh, nested notifications, reentrancy,
logout, A -> B -> A and clients linked to another client, plus platform tests
for native concurrency. It would still provide no authorization decision,
request cancellation, or guarantee for a server action already sent. No such
API is implemented here, and the current arbitrary-provider case is not safe.
