# Shared credential mirror experiment (not for integration)

The mirror wrapper can receive overlapping saves in a single JavaScript runtime.
The baseline allows both to read an empty shared slot and then publish in the
opposite order to the local native store's completed saves. Separate wrappers
and processes can race too; none of the existing shared stores exposes an atomic
compare-and-publish primitive.

This experimental branch serializes the mirror's read and publish for one
wrapper, checks the actual local state and a local mutation generation before
publication, and allows local clear to proceed independently. Tests use the real
native auth store and mirroring wrapper with deterministic in-memory I/O.

The experiment must not be integrated as written: a new save waits for a
previous hung mirror publication, whereas the existing implementation only
waits for that save's own publication. A test demonstrates that the second
credential reaches local storage while the second save remains pending. A
timeout does not cancel the native operation; starting the next publication
anyway allows an older in-flight publication to finish last. Local clear must
never wait on the mirror, and it cannot revoke a shared publication already in
flight. This is tested explicitly. The branch makes no guarantee for separate
wrappers, other runtimes or processes, non-cooperating code, or server-side
credential revocation.

A viable fix needs a real, shared, atomic publication authority with semantics
covering all participating writers, or a redesigned protocol in which an old
write cannot replace the selected new holder. Availability, migration, older
clients and recovery must be handled before enabling it. Generation counters
and JavaScript queues in one wrapper do not provide those guarantees.
