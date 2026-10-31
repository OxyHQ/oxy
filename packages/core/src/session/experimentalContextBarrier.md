# Context barrier experiment

This internal state machine and its opt-in wiring are a prototype, not a
production session or request guard. No app or Services runtime creates it.
Identity-pinned and legacy clients continue on their existing paths. Explicit
test-only wiring connects `SessionClient`, one `HttpService` and its linked
clients, including real socket callbacks and direct directory reads. Context
activation is experimental; signout, switching by account and adding accounts
still fail explicitly and remain unimplemented.

The prototype starts closed and stages the holder-proven v1 response plus state
and directory read with that candidate bearer. It compares device and revision,
active context, actor, subject, and the exact session/actor pair in the flat
state. It rejects mismatches, expired or invalid expiry, credential replacement,
old signal generations, and lower revisions for an observed incarnation. During
the synchronous token-set callback it remains closed, including if that callback
reenters or invalidates again. Its published snapshot is frozen. Failures do not
fall back to the legacy endpoint; they leave the barrier unavailable.

The prototype transport sends the holder credential without a bearer and reads
state and directory with the candidate bearer, with redirects and cookies
disabled. Its fetch implementation is mocked in the test; real server and
browser integration remain unverified. A running application does not use this
snapshot. The test adapter uses the real
`SessionClient`, socket callback and `HttpService` token store, while stubbing
the remote responses. Real issuer/holder behavior is tested in the server PR.

Production integration must establish all of the following before enabling it:

- Invalidate before every relevant state, directory, credential, token, pin,
  lifecycle, socket and broadcast mutation can be observed, including direct
  reads, equal-revision directory updates and credential ABA. Observe external
  providers or refuse strict mode when their changes cannot be fenced.
- Keep staging private; do not expose the raw `SessionClient` projections or
  cached Services snapshots while closed. Stage context-token, state and
  directory via transport that never plants a candidate bearer early.
- Complete propagation of the barrier to `HttpService`, all linked clients and runtime
  adapters. Fence before cache/deduplication, on retry and after asynchronous
  auth preflight immediately before network sends. Cover raw responses, optional
  authentication, explicit headers and socket token acquisition. An anonymous
  holder mint lane must not attach an old bearer.
- `HttpService` notifies token listeners synchronously with the raw token and
  linked clients have independent stores. Before explicit opt-in a test confirms
  that a linked client can obtain its bearer while the standalone prototype is
  closed. The experimental wiring shares the gate, hides public token getters
  while closed, suppresses token listeners through commit, and separately
  releases them. Its privileged experimental peek/install methods are not a
  security boundary and require a narrower API before publication.
- The experimental runtime projects the v1 binding's exact `sessionId` and masks
  its snapshot while closed or out of step. Legacy `activeSessionIdOf` still
  chooses the first matching account row, which need not be the active actor.
  The surrounding provider only clears query caches on a subject-id change;
  changing actor for the same subject needs a cache reset before release, which
  this experiment does not yet coordinate.
- An experimental `prepareCommit` hook can remove owner queries while the gate
  is closed, without deleting paused mutations. Account-only persisted blobs
  cannot be assigned to an actor by inference and must remain quarantined.
  A real QueryClient test shows paused mutations can otherwise resume under a
  different actor. Another test shows TanStack can pass `canRun`, notify a
  subscriber that changes owner, then invoke the mutation under that new owner.
  An executor waiter closes that race in the test, but TanStack marks the
  waiter `isPaused: false` and `setOptions` can replace the wrapper. A strict
  persister must explicitly include waiting work and restore it as quarantined;
  the existing paused-only persister does not do this.
- A separate experimental explicit mutation registry ties each operation to an
  actor, account and session, and gives its registered executor a lease-bound
  HTTP request. It refuses cross-owner execution and preserves uncertain
  outcomes rather than automatically retrying. Only cooperative registered
  operations using that transport are covered. Storage, idempotency on the
  receiving endpoint, immutable adapters, arbitrary callbacks, cancellation and
  app integration still require design and end-to-end verification.
- A successful authenticated `{all:true}` signout returns the transaction's
  empty state after revoking every holder. That response can establish what the
  mutation did at that moment without reusing the revoked secret. It cannot
  establish an ongoing empty device: the broadcast can precede the response and
  a new sign-in may already have happened. Clearing local durable credentials
  safely needs a storage-queue CAS against the old holder and lifecycle. The
  current `AuthStateStore.clear()` and signout callback lack that guard. Context
  removal's directory and state are separate reads after its transaction, not a
  shared snapshot. A 409 or 401 from v1 alone does not prove empty signout.
- A native per-instance clear experiment compares holder and lifecycle inside
  one store queue. A test demonstrates that a second store instance can still
  replace the backing credential during deletion and lose the replacement, so
  this capability is disabled by default and must not be used as a general CAS.
  The provider creates a new store per provider; the SecureStore adapter exposes
  only get/set/delete and supplies no cross-instance or cross-process CAS.
- A separate tombstone experiment writes only a marker for a distinct local
  login incarnation and never deletes the shared current credential. Its
  concurrent test preserves a newer credential, but no login or restoration
  path uses the marker. It requires unique random incarnation ids, verified
  durable single-key writes, fail-closed reads, a design for stale current-pointer
  writes, marker retention/cleanup and native/browser validation. The server can
  still revoke a new holder if that holder was added before signout committed.
- Commit token and projections behind the barrier, then publish only after all
  components agree. Define callbacks and failures during commit, guarantee
  generation fencing through the last send, and test synchronous reentry.
- Keep identity-pinned clients on their explicit account mint. Do not silently
  downgrade strict account mode on missing capability, 401, 409, 429 or network
  failure. Provide an explicit unavailable state and recovery behavior.
- Verify real server, SDK, Services runtime, linked backend and app together,
  including pinned, legacy, logout, token rotation, out-of-order and same-subject
  different-actor transitions. Include native and web transport behavior.

The prototype assumes its getters are plain synchronous reads and every local
change triggers invalidation. It cannot detect a change that leaves and returns
to the same credential or token without such a signal. It also cannot undo a
request already sent, observe a remote change before a signal, freeze the
server's account graph or ensure authorization continues after issuance. The
server checks delegation before its final database read; authorization can
change afterwards. Device revisions do not represent a complete graph snapshot.
