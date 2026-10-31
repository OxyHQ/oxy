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
