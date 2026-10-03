# Interrupted operator task: real SIGTERM regression

Review [5972926389](https://github.com/OxyHQ/oxy/pull/1568#issuecomment-5972926389)
identified that Python's default SIGTERM exits without entering `finally`.
The original transport was therefore not ready for live execution under
interruption. Its earlier proof remains historical at `eee6afbd6`.

The launcher now handles SIGTERM/SIGINT around the complete operation. Before
unwinding it writes a private interruption receipt containing plan hash/nonce
and the need for manual reconciliation. Cleanup then runs independently for
the known task and TD. Repeated signals do not interrupt cleanup; a first
signal during cleanup records the interruption and lets cleanup finish. An
interrupted run exits as failure even if the operation had completed. It never
redispatches or invokes SQL rollback.

A registration or RunTask acknowledgement that does not return an identity is
marked explicitly as unknown in `cleanup.json`, and cleanup is not reported
complete. The durable original intent/registered TD/client token remain the
reconciliation boundary. SIGKILL, host death and filesystem failure cannot be
handled reliably: use those original receipts and exact AWS metadata/logs;
never infer that the absence of a result means the CAS did not commit.

Four real child-process tests send SIGTERM at precise fixture boundaries:
after RunTask ACK, while collecting a receipt, with StopTask failure, and
before RunTask returns its ACK. AWS is a stateful local fixture; SQL and AWS
are not executed. The original frozen test file and RED log are retained:
all four exited -15. The final tests pass and verify one dispatch only,
interruption receipt, known task STOPPED or explicit unknown, independent TD
deregistration even when stop fails, and an empty result remaining unaccepted.
The ordinary 12 launcher controls also pass after this change.

The Node runner and existing compiled API CAS are unchanged. Their previous
four real-PG controls are preserved rather than repeated for Python signal
handling. This source-only fix requires no API image or SDK freeze change.
Live execution still requires the reviewed final-image plan and root operator.
