# Context barrier experiment

This internal, unexported state machine is a prototype, not a production session
or request guard. Nothing in `SessionClient`, `HttpService`, linked clients, or
the Services runtime currently creates it. Identity-pinned and legacy clients
continue on their existing paths. The test adapter deliberately invokes
`invalidate()` itself before a simulated socket ingress or direct directory
read; it does not prove that the production ingress does this.

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
- Propagate the same barrier to `HttpService`, all linked clients and runtime
  adapters. Fence before cache/deduplication, on retry and after asynchronous
  auth preflight immediately before network sends. Cover raw responses, optional
  authentication, explicit headers and socket token acquisition. An anonymous
  holder mint lane must not attach an old bearer.
- `HttpService` notifies token listeners synchronously with the raw token and
  linked clients have independent stores. A test confirms that an existing
  linked client can obtain its bearer while the prototype is closed. Commit and
  release therefore need an explicit shared protocol, including listeners and
  token getters, not just a guard around `HttpService.request`.
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
