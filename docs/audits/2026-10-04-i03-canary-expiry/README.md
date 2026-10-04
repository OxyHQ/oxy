# Revocation measurement excludes natural expiry

The external canary now requires at least 122 seconds of credential lifetime
before issuance and 62 seconds of both credential and bearer lifetime before T0.
These fixed thresholds include a two-second clock margin. The dispatcher rejects
near-expiry plans before AWS dispatch; recovery still accepts expired plans and
never renews or reissues them.

The parent reads a fixed PostgreSQL `clock_timestamp()` projection before issue,
before measuring and after both samples. It compares the database clock with the
local wall/monotonic brackets, rejects clock drift, and requires all initial ALLOW
and final DENY timestamps to precede both expiries by the margin. The receipt
records the expiries, clock observations and accepted sample timestamps. A late
sample cannot set `measured: true`, even with canonical revoked-row readback and
a refusal within five monotonic seconds. Cleanup still retires the own row.

The identical controlled expiry fixture fails on parent source `2237ee282`
(`measured: true` after expiry) and passes on the new helper. Nine cases execute
the actual parent through a VM, with a real owned PostgreSQL clock/credential
state and synthetic mint, credential service and fork boundaries. The fixture
clock adds a controlled SQL offset; this is not a live API/SDK revocation sample.
It covers a fresh positive, expired/near-expiry rejection before issue, expiry
during warm/probes, short bearer, oracle ERROR and expired recovery. All own rows
are retired and each random database dropped; PostgreSQL PIDs are absent.

Sixteen mocked AWS protocol cases pass, including dispatch lifetime rejection
and expired recovery. Twelve controls use the real fork and two core 4.2.0 SDK
processes with a signed synthetic loopback oracle; an outage remains ERROR.
These retain the earlier scope and are not a production latency claim.

The external owner is aligned to the fresh API693 authority readback: Alia's
existing internal application belongs to `01a0369b-1222-712f-8df6-f8ffeb78ccc2`.
The live readback is private and hash-bound in the proof. No authority was changed.
The default compiled API module remains untouched. An optional operational module
path accepts only the reviewed CJS SHA2977 at its exact hash-named file beside
`dist/services`; it checks real path and bytes before loading. The separate i04
loader stages that module with exclusive creation and verifies removal. Its
transport composition and root's fresh execution plan are required before use;
this checkpoint does not claim that the existing image contains the patched
metadata module or that a live canary has executed.
