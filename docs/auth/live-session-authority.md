# Live session-row authority

`OxyServer` can opt a server route into a fresh session-row read. It is off by
default, requires explicit API provisioning and is not a replacement for the
route's own authorization. Ordinary validation and its caches remain the
default. `freshSession` only skips the `OxyServer` validation cache; Oxy may
still answer it from its session cache.

```ts
app.post('/sensitive-operation', oxy.middleware.auth({ liveSession: true }), handler)
```

`ServerSessionValidateOptions` also exposes `liveSession` on
`oxy.session.validate(sessionId, { accessToken, liveSession: true })` for
server code. `OxyServices` client options do not expose it; injecting the option
at runtime fails with 503 without sending a request. This SDK distinction is
not access control: a manual HTTP client can send the live header, so the API
gate and budgets below remain necessary. No browser CORS contract is added.

## Contract and errors

Oxy reads the active, unexpired session row and `pg_is_in_recovery()` in the
same PostgreSQL statement and connection. A physical standby is refused even
when the row is missing. The result reflects commits visible to that
statement's snapshot **on the configured authoritative writer**; operators
must establish that the connection targets the correct cluster. The recovery
check alone does not detect a logical replica or a wrong writable cluster.
Requests whose authority read preceded revocation may still finish. It does
not make account data, grants, supervision decisions, socket connections or
other sessions fresh.

The server SDK requires a versioned response marker. Old servers, an
unavailable dependency, a missing marker or malformed response fail closed
with 503. Unconfirmed user, grant or supervision negatives also yield 503,
without deactivating a managed session. A confirmed invalid bearer or session
is 401; a valid bearer that does not match the requested session is 403. A
marked policy denial is 403. The SDK maps an upstream 429 to 503 and does not
retry the live authority call. A response already expired according to the
consumer clock is 503; clock skew can therefore reduce availability. Explicit
503 responses preserve the client bearer and session epoch.

## Provisioning and capacity

Oxy API reads these settings at startup; live requests return 503 unless all
are present and Redis is ready. They are deliberately absent by default.

| Variable | Required setting when enabled |
| --- | --- |
| `OXY_LIVE_SESSION_ENABLED` | `true` |
| `OXY_LIVE_SESSION_SUBJECT_PER_MINUTE` | Integer from 1 through 60 |
| `OXY_LIVE_SESSION_IP_PER_MINUTE` | Integer from 1 through 300 |
| `OXY_LIVE_SESSION_GLOBAL_PER_MINUTE` | Integer from 1 through 600 |
| `REDIS_URL` | The shared Redis used by every participating API task |

The upper bounds are safeguards, not capacity recommendations. Choose actual
limits only after measuring the target deployment, and configure every task
consistently. The route uses separate fixed-window Redis budgets in this order:
verified subject (or hashed IP when there is no verified subject), hashed IP,
then a shared global key. After the address budget, a request without a
signature-, expiry-, subject- and session-id-verifiable bearer is refused
without reaching the global budget. This is budget attribution, not a live
session authorization: a verified bearer still requires the controller's
authority checks. A verification failure has no invalid-session marker; a
missing signing secret returns 503. The legacy endpoint's budget is separate and
unchanged. A rejected subject or IP does not consume the global counter, but a
later denial or Redis failure can consume earlier reservations. Shared NAT
traffic shares the IP budget. A caller can compete for global capacity, so
these limits do not provide isolation from denial of service. Adjacent fixed
windows can admit a burst, and Redis eviction, failover counter loss or
inconsistent stores can weaken the bound. Correct trusted-proxy configuration
is required for address bucketing. Redis errors fail closed.

Every admitted live validation adds three Redis limiter commands, a session-row
SELECT and the existing activity bookkeeping. That bookkeeping issues an
asynchronous Redis `SET NX` per validation and a locally throttled conditional
session UPDATE. Local single-host measurements with one user and 30 sequential
alternating requests showed legacy p50/p95 of 3.95/4.92 ms and live with
budgets 5.88/8.10 ms; they do not measure production contention or establish
capacity. Measure authenticated request rate, API and database latency and
errors, PostgreSQL CPU, connections and query rates, Redis latency and command
rate, and 401/403/429/503 and session-clearing rates before and during adoption.

## Rollout and rollback

1. Deploy the API first with the gate disabled and no clients opting in. Verify
   all API tasks have the intended image and rollout has completed. Select
   budgets and alert thresholds from deployment-specific measurements.
2. Configure the same budgets and enable the gate on every API task. During a
   mixed fleet, an opted-in request can receive 503 from a task where the gate is
   still disabled. Complete the fleet rollout before any consumer opts in, and
   check marked success, confirmed invalidity, a rate-limit refusal and an
   authority failure through the production load balancer.
3. Release Core with a separate version-bump PR and verify CI, OIDC publication
   and the actual package tarball. Enable one low-volume route first and observe
   its outcomes and the resource signals above before expanding.
4. Disable `liveSession` on an adopted route and redeploy its consumer to roll
   it back. Do this before rolling the API back: an older API intentionally
   causes opted-in consumers to return 503. Returning to ordinary validation
   restores its existing cache semantics, not the live-row guarantee.
