# Android shared-session fan-out research (not production code)

The running broker can clear a host after its write returns false. In the
controlled JVM harness, a second thread replaces that host's holder after the
write fails but before cleanup. The unmodified `OxyDeviceSessionModule.kt`
clears the replacement and reports success when another host accepted the
write. Android, Binder, Expo, the host store, and holder proof are simulated;
this is not a physical-device or server test. Synthetic strings are used.

Run with cached Kotlin 1.9.24 compiler dependencies and Java:

```sh
python3 experiments/android-broker-fanout/run.py
python3 experiments/android-broker-fanout/cooperative_cas_model.py
bun experiments/android-broker-fanout/core-policy.ts
```

`run.py` compiles the real module and sweep against the local stub fixtures,
then compiles an isolated temporary variant that replaces the failed-write
clear with a failure result. It writes neither variant to production sources.
The preserve variant avoids the demonstrated clear, but if the first host
accepted the candidate and the second retained its older credential, the real
sweep selects the candidate. `core-policy.ts` exercises the real Core wrapper:
its `already-current` path skips publication and leaves the stale replica,
including on a new wrapper. A second simulation starts with two same-device
holders, assumes a successful holder proof, performs a final snapshot read,
then allows a legacy writer to replace one host during fan-out. Both variants
overwrite the intervening value. The proof is a fixture, not server validation.
A delayed legacy caller also overwrites a more recent publication. Therefore a
more detailed read and one more preflight alone do not make repair safe.

`cooperative_cas_model.py` is a separate idealized per-host authority with a
threading lock and an in-memory generation. With the explicit assumptions that
every write to each host, including writes initiated by legacy clients, goes
through that same host authority and changes its generation, a same-device
repair can converge, a newer write before CAS is preserved, and an unavailable
host can be retried after recovery. There is no unconditional fallback for an
older host without CAS. This does not implement a native provider or guarantee
production behavior. Its tests also exhibit important limits:

- A legacy host without the new operation remains pending, potentially
  indefinitely, until a compatible authority or an explicit recovery exists.
- A successful CAS cannot stop a later legacy write. A host that matched the
  candidate during the snapshot can also change before repair finishes.
- Per-host CAS is not a transaction across hosts. A later conflict or failure
  can leave earlier hosts changed; unconditional rollback is unsafe.
- Resetting a generation on restart allows ABA and can overwrite an unseen
  holder. A real design needs persistent, non-reusable incarnation/version
  semantics and crash-safe storage.
- A Java monitor in one process is not a cross-process primitive. The current
  provider plugin does not set a separate `android:process`, but that is not a
  proof that all production storage accesses run in one process or that every
  installed legacy host uses a participating implementation.
- A successful server proof only establishes validity within its defined scope
  and time. It does not freeze the server's authorization graph or guarantee
  the credential is still valid after a later write.

The existing `device_sessions.revision` versions a device's account/context
state; issuing another holder adds a credential row without advancing that
revision. It cannot order or authorize replacement of cross-app slot values.
The current native provider exposes read/write/clear but no atomic conditional
mutation, and the fan-out spans several independent hosts. Do not enable or
publish the preserve-only variant as a complete fix.
