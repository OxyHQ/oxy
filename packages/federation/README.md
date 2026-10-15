# Oxy federation


## Authorizing outbound delivery

`createDeliveryService({ authorizeDelivery })` optionally checks live application
policy before signing or queueing an activity. It receives `activity` and the
trusted `senderAccountId` supplied by the app or persisted delivery job. Never
infer that identity from an activity URL or a key ID. Follower fanout checks once
for the batch; each later worker delivery checks again.

Return `true` to allow or `false` for a definitive refusal. A refusal throws
`DeliveryAuthorizationDeniedError`: a durable worker should mark the job
suppressed (or permanently failed), without marking it delivered or retrying it.
Other thrown errors are transient authority failures and should follow the
worker's normal bounded retry policy. Neither path signs or sends the activity.
Do not catch an authority failure and retry through an unguarded transport.

Without the optional hook, delivery behavior is unchanged. `sendUndoFollow`'s
boolean reports local relationship removal; it does not confirm remote delivery.

## Discovery response caching

`createWebfingerRouter({ httpCacheTtlSeconds })` controls HTTP caching of fresh,
cached and instance WebFinger responses. The default remains 3600 seconds.
`createActorRouter` accepts the same option for human and instance actor
responses, retaining its existing 1800-second default.
Use `0` for `Cache-Control: no-store` when live privacy decisions must govern
each request. Only whole seconds from 0 through 86400 are accepted. This does
not change the injected JRD cache: applications must also authorize its reads
and their user resolver against current policy. It cannot retract documents
already cached by remote consumers before this setting changes.
