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
