# WEB04 fallback race: frozen RED

The test uses actual HTTP session-device routes, normal migrations through 142,
PostgreSQL, SessionService and signed JWTs. Existing outer bearer/rate/socket
fixtures remain synthetic; device-secret authentication and organization
membership are real. A scheduling spy returns the actual authenticated snapshot
only after an actual organization sign-out transaction commits. No timers or
fabricated state/token responses create the interleaving.

The first exploratory case produced 7 pass / 1 fail (expected fallback HTTP200,
received401). The frozen expanded cases retain the same failure and deny-boundary
checks. The launcher owns a new PostgreSQL process and checks executable, UID,
data directory and loopback socket before creating its database; fresh/repeat
142 migrations pass and the process is stopped in finally. No production or
live browser fixture was modified. This RED is a reproduction, not acceptance.
