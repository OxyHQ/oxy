# Holder context evidence experiment (disabled)

This API is an experimental observation for a future shared-device client. It
is disabled by default and needs independent, explicitly configured subject,
IP and global Redis budgets before it will answer. No existing SDK consumes it.
Do not enable it until the server, client and rollout are reviewed and tested
together.

The caller presents its current bearer in `Authorization` and the existing
holder's `deviceId` and `deviceSecret` in the body. The server validates the
bearer through the existing live-session authority and observes the active
holder, context, exact stored bearer and writable-primary state in one database
statement. It returns identifiers and expiry, never the bearer or holder secret.
This is a point-in-time observation, not a lease, authorization grant or proof
that any future request will have the same bearer, permissions or context. It
does not assert token scopes or whether a client uses a pinned session.

This experiment accepts only a first-party v2 personal session where subject
and actor match and the principal's personal session is the same validated
session. OAuth, legacy and delegated bearers are rejected. Supervised policy
that cannot be evaluated by the existing live authority fails closed as 503.
The policy's existing cache/invalidation semantics remain unchanged; the
endpoint does not add new authority. An unsupported bearer returns 403, a
missing or invalid bearer 401, a valid bearer whose holder or active binding
cannot be matched 409, and unavailable authority or capacity 503. Clients must
not interpret 409 or 503 as revocation or delete credentials. The API itself
must not mint, refresh, rotate, or restore a session.

Before any rollout, independently prove the runtime contract that atomically
binds the evidence to the precise installed bearer and its generation, including
refresh, account and actor switches, direct setters, cross-tab changes, offline
restoration, in-flight requests and cancellation. Add complete delegated,
supervised and OAuth handling only after their existing authority and error
semantics can be checked without granting new permissions. Validate writer and
Redis failure behavior under production topology, provision capacity, and define
flag rollout and rollback. These changes alone do not fix any client race.
